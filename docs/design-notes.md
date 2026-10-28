# Design notes

Repo-facing summary of the decisions behind the service. Short by intent: the README is
the entry point, this is the "why", and the git history tells the rest in the order the
risks were tackled.

## Operating conditions (what the design answers to)

- F1: ~1000 events/min, growing.
- F2: third-party senders retry, duplicate, and deliver out of order.
- F3: per-patient order matters.
- F4: never lose an event, never apply one twice.
- F5: a crash can happen mid-work.
- F6: the sender needs an immediate answer.

## Key decisions

- **Mongo is the queue.** One collection, `records`, holding two document kinds (`event`,
  `snapshot`) discriminated by a `kind` field. No extra broker to run or reason about.
- **Ingestion is decoupled from processing.** `POST /events` only persists and answers;
  all side-effects and folding happen in background workers. That is what makes F6
  compatible with F4.
- **Two stages, deliberately distinct.** Per-event `effect` (the external call) is computed
  once per event and is independent of order. The per-patient `fold` (event history ->
  snapshot) is pure and order-sensitive. Keeping them separate keeps the ordering logic in
  a pure function that is trivial to test.
- **Idempotency by content hash.** `eventId = sha256(canonicalJSON(...))`; a unique index
  makes a duplicate a no-op at the database, not a race in application code.
- **Durability before acknowledgement.** Writes use `j: true`; the `202` is sent only after
  the event is journaled. A failed write is a `5xx`, never a silent accept.
- **Crash recovery without transactions.** Atomicity is per-document (`findOneAndUpdate`
  plus a fencing token), not multi-document. The snapshot is written and only then are its
  source events marked folded; a crash in between leaves an orphan that the reaper redoes.
  The "transaction" here is idempotency + write order + reaper.

## Layering

A single NestJS app (no Nx: no frontend, UI is not evaluated). It reuses a clean
controller -> service -> repository layering, minus a unit-of-work/transaction manager -
atomicity here is per document, not transactional. The pure domain is isolated by an import
rule, not a package: `src/domain` imports neither Nest nor the driver, so its tests need no
container. The repository exposes named atomic commands (claimNext, commitReady,
saveSnapshot, requeueExpired, ...) rather than a generic `update(filter, patch)`, so Mongo
semantics never leak up and the method names read as the guard list.

## Testing strategy

- **Clock and ExternalProcessor are the only seams.** All business time comes from
  `Clock.now()` (no `Date.now()` outside it), so tests advance time without fake timers; the
  external call is a port, so a fake can gate, fail, or time out on command.
- **Unit tests** cover the pure domain (canonical hashing, the fold, `planReduction`) with
  no Mongo; they run sub-second.
- **Integration tests** run against a real in-memory Mongo (E11000, partial indexes, atomic
  `findOneAndUpdate` are real, never mocked). The background workers are tested as plain
  classes with fakes - the zombie-fencing and crash-recovery cases are deterministic, driven
  tick by tick, with no sleeps.
- **The chaos script** is the end-to-end crash proof and lives outside `npm test` (it needs
  Docker, a port, a real SIGKILL and a real clock - the usual flakiness sources). Its oracle asserts
  per-patient order, not only counts: each patient's folded state must match an independent in-order
  computation, so a scrambled fold fails it. A `CHAOS_MODE=paced` variant runs the same assertions
  under a paced send at the real ~5s delay with a mid-run crash, and reports the achieved rate and
  drain time rather than extrapolating.

## Capacity

The two numbers in the brief multiply: ~1000 events/min is ~16.7/s, and each event occupies a
worker for ~5s (the external call). By Little's law the steady state needs ~16.7 x 5 ~ 84 workers
in flight; `CONCURRENCY` defaults to 100, ~20% over today's load. That is the sustained ceiling at
the real 5s duration: ~100/5 = 20 events/s ~ 1200/min. (The committing worker also triggers the
reduction, so its real occupancy is slightly over 5s - a reason the headroom matters.) Growth past
that is more workers and more instances, until the refold below becomes the limit.

## The independence premise (and where it breaks)

The two-stage split assumes the per-event external `effect` is a function of the event alone, not of
the patient's prior state. That is what lets stage 1 run fully parallel (any worker, any order) and
stage 2 be a pure replay. If the real external call were instead state-dependent - its result for
event N depends on the folded state through N-1 - the model degrades sharply: events for one patient
would have to be processed strictly in order, one at a time, so a single patient's throughput would
collapse to ~1 event per external call (~12/min at 5s), and the fold would no longer be a cheap
replay of precomputed effects. The design would then need a per-patient serial lane (the claim keyed
by patient, not global FIFO) and stage 2 folded inline. The simulated external here is
state-independent by construction, so the premise holds for this exercise; it is the first thing to
confirm against the real integration before trusting the parallelism.

## Scalability path

Running N instances is safe as-is - claim, fence, and reaper are concurrency-safe, so more
instances just add workers - but it is not free: they contend on the same Mongo, on the claim
index, and on per-patient work. The one structural limit is the per-patient refold: `planReduction`
recomputes the whole contiguous ready prefix on each run (O(history)), published under an optimistic
version CAS, not an exclusive lock - so concurrent runs for one patient recompute and the losers are
discarded by the CAS. A patient with a long history and a hot event rate is therefore the
bottleneck, and it grows with time, independent of hardware. The defence already in place is a pure
fold plus an ordered replay designed so the reducer can be swapped; the next step is an incremental
fold that applies only the new tail (a late event behind the cursor still needs a bounded recompute
from a checkpoint). The recovery sweep itself is bounded: failed-patient discovery runs on a partial
index (cardinality = failed events, not history), a patient whose snapshot is already blocked is
dropped from the failed sweep, and the orphan sweep drops a ready event stranded strictly behind a
failed gap (it cannot fold until the gap clears, which the worker trigger handles) - so the reaper
never re-pays an O(history) refold tick after tick for a patient whose state cannot change. The one
cost that is still history-shaped is the gauge aggregate (`countsByStatus`, a `$group` over all
events): it runs on its own loop, off the reaper's recovery *await* path, so a slow gauge cannot
stall lease reclaim, but it does share the one Mongo. Bounding it (a maintained counter, or storage
tiering that archives folded history) is a later concern, and `/stats` is explicitly a cut.

## Where the detail lives

The full analysis (ADRs, edge-case guards C1-C16, observability, auditability, security,
error taxonomy, scalability, testability) is internal prep and is not committed. This file
plus the README are the delivery-facing documentation; the README enumerates which guards
ship as code and which are argued but intentionally not built.

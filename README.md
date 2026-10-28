# Ingest Service

A service that ingests clinical events from unreliable third-party senders and folds them into a
per-patient snapshot. Mongo is the durable queue; there is no Kafka/Redis/Bull.

The senders retry, duplicate, and deliver out of order; per-patient order matters; the system must
never lose or double-apply an event, must survive a crash mid-work, and must answer the sender
immediately. Those constraints (F1-F6) drive every decision below. The architecture rationale is in
[`docs/design-notes.md`](docs/design-notes.md).

## Architecture

```
POST /events ──► validate + dedup ──► persist (queued) ──► 202
                                           │
                 worker: claim (fence+lease) ─► external effect ─► commit (ready)
                                           │
                 reducer: fold the contiguous ready prefix ─► snapshot (per patient)
                                           │
                 reaper (~1s): requeue expired leases · reprocess crash orphans
```

- **Ingestion** persists and answers `202` only once the write is durable (`j:true`); it does no
  processing, so an immediate answer never costs durability.
- **Worker** claims a queued event atomically, runs the external side-effect under a timeout, and
  commits the result under a fencing token.
- **Reducer** folds each patient's contiguous ready prefix into a snapshot, under an optimistic
  version lock.
- **Reaper** requeues work whose lease expired and reprocesses events orphaned by a crash. It is a
  component, not a cron: it is how crash recovery happens.

`src/domain` is pure (fold, canonical hashing, input guards, the Clock/ExternalProcessor ports) and
imports neither Nest nor the driver. `src/records` is the one repository whose method names recite
the atomic protocol. `src/pipeline` holds the background workers. `src/ingest` and `src/stats` are
the HTTP slices.

A note on the two-word vocabulary of stage 2: `planReduction` decides which contiguous ready
prefix to apply and whether it is safe to publish; `fold` is the pure accumulator that turns that
prefix into state. The persisted cursor (the last folded event) is `appliedThrough`.

## Run it (2 commands)

```bash
docker compose up --build    # mongo + the service on :3000
```

The service connects to Mongo and creates its indexes before it listens; a bad connection or a
missing index fails the boot rather than serving without the dedup index.

```bash
curl -s -XPOST localhost:3000/events -H 'content-type: application/json' \
  -d '{"patientId":"p1","type":"observation","ts":"2026-01-01T00:00:00Z","data":{"hr":80}}'
# -> 202 {"eventId":"...","status":"queued"}

curl -s localhost:3000/stats
# -> {"startedAt":"...","updatedAt":"...","counts":{"queued":0,"processing":0,"ready":1,"failed":0},
#     "oldestUnresolvedAgeMs":0}   (updatedAt is null until the first refresh; the age counts any
#     unsettled event - queued, processing, or ready-but-not-yet-folded - so a stalled second stage
#     cannot hide behind a healthy gauge)
```

## Test it

Tests run without Docker, against an in-memory MongoDB (downloaded and cached on first run, so the
first `npm test` needs network and later runs do not). `MONGO_URI` is a suite-only escape hatch
(point the integration suite at an existing mongod); the service itself reads `MONGO_URL`, not
`MONGO_URI`.

```bash
npm ci
npm test                # unit (pure domain) + integration (real Mongo)
npm run test:unit       # pure domain only, no Mongo, sub-second
npm run test:integration # integration only, against in-memory Mongo
npm run chaos           # standalone crash demo (needs `docker compose up -d mongo` first)
CHAOS_MODE=paced npm run chaos   # sustained-load variant at the real ~5s delay
```

`npm run chaos` bursts duplicated, out-of-order events, SIGKILLs the service mid-flight, restarts
it, and once the queue drains asserts **conservation and per-patient order**: every acknowledged
event is persisted exactly once (by id-set, not just count), nothing is left queued/processing or
ready-but-unfolded, and each patient's folded state matches an independent in-order computation (a
scrambled fold fails the oracle, not only a miscount). `CHAOS_MODE=paced` runs the same assertions
under a paced send at the real ~5s external delay with a mid-run crash, and reports the achieved
rate and drain time (`PATIENTS`, `EVENTS_PER_PATIENT`, `RATE_PER_MIN`, `EXTERNAL_MS`, `CONCURRENCY`
are overridable). It reports its run, it does not extrapolate to hours.

## HTTP contract

The error body is `{ "error": { "code": "<code>" } }` with a fixed `code`. The `status` in a `202`
body is the event's state (`queued|processing|ready|failed`), not the HTTP status.

An optional `Idempotency-Key` request header sets the event's identity: when present, two deliveries
with the same key (same patient) are the same event even if the body or `ts` drift on a retry, and
two distinct observations that happen to share a body stay separate. Without it, the identity is the
content hash (see Known limitations). The body contract is unchanged, so the header is purely additive.
The key is occurrence identity, so the body is not part of it: if a sender reuses one key for two
genuinely different events, the first body wins and the second is dropped as a duplicate (the 202
carries the first event's status, with no conflict signal - the same reasoning as the deliberate lack
of a 409). Key uniqueness per occurrence is the sender's responsibility; the content-hash walk (C13)
still runs on `data` in both paths, so a key never bypasses input validation.

| Status | `code` | When | Sender should |
|--------|--------|------|---------------|
| `202` | - | persisted (new or dedup hit); body carries the real `status` | read `status`, do not resend |
| `400` | `validation_failed` | invalid DTO, out-of-bounds `ts`, or hostile `data` | fix the body, do not resend as-is |
| `413` | `payload_too_large` | body over the 1 MB limit | fix |
| `503` | `persistence_unavailable` | the write could not be confirmed durable (Mongo down/timeout); it may or may not have landed | resend the same body (dedup-safe) |
| `500` | `index_conflict` / `internal` | e.g. a unique conflict on an index other than `eventId` | resend (dedup makes it safe) |

There is deliberately no `409`: it would tempt a sender to "fix" a duplicate by changing the `ts`
and thereby store a second event.

## Correctness guards that ship as code

The code carries only the guards that make an invariant falsifiable (each has a test that goes red
without it). Each is small code inside what would be written anyway.

| Guard | What it protects |
|-------|------------------|
| C1 | a late event behind the cursor enters the state once ready (full refold) |
| C2 | fenced commit: a zombie worker whose lease was reclaimed cannot overwrite |
| C3 | snapshot written under the version predicate: no last-write-wins |
| C4 | a retroactive gap never republishes a shorter prefix; blocked only on a failed gap |
| C5 | reaper reprocesses a ready-but-unfolded event (crash between stages) |
| C6 | honest E11000: dedup only on `eventId`, 202 carries the real status; other index = 500 |
| C7 | 202 only after a durable write; a failed write is 5xx, never a silent accept |
| C8 | external timeout < lease, so a slow call cannot livelock into mass failure |
| C9 | pure, tested canonical hashing (recursive sort, NFC, epoch-ms ts) |
| C10 | partial indexes created and verified at boot |
| C12 | `ts` bounds (clock-skew defence) |
| C13 | one hostile-input walk inside the hash: depth/node caps, `$`/dotted/prototype keys, non-finite |
| C14 | `failed` only from the attempts budget; infra/fence errors never change status |
| C15 | a fold error is contained per patient, never fails a worker turn |
| C16 | fail-fast at boot (indexes, config); contained errors in every loop |

## Deliberately not built (named, defensible cuts)

Designed in the analysis, left out to keep the solution modest and readable. Dead code (a field no
one reads) would cost more on the heaviest criterion than a documented cut.

- **Admin unlock endpoint (C11):** events that exhaust the attempts budget become `failed` and mark
  the patient's snapshot `blocked`. Re-queueing them is a documented manual Mongo update
  (`status: failed -> queued`); with the simulated external (which never fails), this path does not
  arise in the demo.
- **Audit endpoint and fields:** no `foldedAt`, `ops`, `inputsHash`, `reducerVersion`, or
  `GET /admin/audit`. The discipline remains (immutable hash-sealed core; operational fields move
  only through named repository commands), and re-reading an event recomputes the same `eventId`.
- **Rich observability:** `/stats` is four numbers, not rates/splits/restart history.
- **Security beyond the DTO, body limit, and input walk:** auth, TLS, rate limiting, WAF, a clinical
  schema for `data`. The admin path would sit behind auth and network controls in production.
- **Scale-out machinery:** the design is already safe to run as N instances (claim/fence/reaper are
  concurrency-safe); what is not built is sharding, incremental fold, or storage tiering.

## Known limitations

- **Identity without a key falls back to content hash.** An optional `Idempotency-Key` gives true
  occurrence identity (above); without it, dedup is by content hash, so a retry that regenerates the
  `ts` would hash differently (counted twice) and two genuinely-identical events would collapse into
  one. The content-hash premise is that a retry repeats the body; the key removes the premise for
  any sender that can set it.
- **`ts` does not guarantee absolute order** (ms ties, unbounded delay, clock skew). Ties break by
  `eventId` - stable but clinically arbitrary. Strict ordering would need a per-patient authoritative
  sequence.
- **The external call is at-least-once** unless its destination deduplicates by `eventId`; the Mongo
  effect is exactly-once. The lease is a wall-clock `Date`, so severe clock skew across instances can
  make a reclaim (and thus a second external call) fire early - the at-least-once case becomes more
  common, not just crash-triggered. A shared clock source or a monotonic fence bound would tighten it.
- **Per-patient fold is O(history)**, recomputed under an optimistic version CAS (not an exclusive
  lock): the one scaling limit, addressed by an incremental fold next (the pure fold is designed to
  be swapped). A hot patient with a long history pays that O(history) on each real advance - that
  cost is not removed. What the recovery sweeps avoid is paying it *for nothing*: a permanently
  blocked patient and a ready event stranded behind a failed gap are both excluded from the per-tick
  sweep, so the reaper never re-folds a patient whose state cannot change. See the design notes.
- **`blocked` can be briefly stale.** It flips only on a reducer run, so in the window between a
  failed gap being requeued (manual unlock) and the requeued event being processed, the snapshot may
  still read `blocked` though the current gap is no longer a failed event. It self-heals on the next
  commit; a consumer treating `blocked` as "stuck" sees a conservative, not a false-negative, signal.
- **Single-node Mongo, atomicity per document** (no multi-document transaction, by design): the
  single document is the unit of work; consistency comes from idempotency + write order + reaper.

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port |
| `MONGO_URL` | `mongodb://localhost:27017` | connection string |
| `MONGO_DB` | `ingest` | database name |
| `LEASE_MS` | `30000` | worker lease before the reaper may reclaim |
| `EXTERNAL_TIMEOUT_MS` | `10000` | external-call timeout (must be `< LEASE_MS`) |
| `EXTERNAL_MS` | `5000` | simulated external duration |
| `MAX_ATTEMPTS` | `5` | attempts before an event is parked as failed |
| `CONCURRENCY` | `100` | concurrent worker loops; ~1000/min x 5s ~ 84 in flight (Little's law), so 100 is ~20% headroom |
| `IDLE_MS` | `200` | worker backoff when there is no work to claim |
| `REAPER_MS` | `1000` | reaper sweep interval |

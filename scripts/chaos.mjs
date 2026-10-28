// Standalone chaos / acceptance harness (not part of `npm test`: it needs Docker, a port, a real
// SIGKILL and a real clock - the top sources of flakiness).
//
// Two modes:
//   default ("crash")  - fast crash-recovery proof: burst duplicated, out-of-order events, SIGKILL
//                        the app mid-flight, restart, then assert CONSERVATION and per-patient
//                        ORDER once the queue drains. Runs in seconds (EXTERNAL_MS=40).
//   CHAOS_MODE=paced   - capacity/recovery under load: send at a target rate (default 1200/min) at
//                        the REAL ~5s external delay, SIGKILL once mid-run, and report the drain
//                        time and achieved rate alongside the same conservation + order oracle.
//                        Reports its run duration and configuration; it does not extrapolate.
//
// Usage: `docker compose up -d mongo` first, then `npm run chaos` (or `CHAOS_MODE=paced npm run chaos`).
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
// Fixed, never inherited: this script runs deleteMany, so it must not point at the demo db even
// if MONGO_DB is exported in the shell.
const MONGO_DB = 'ingest_chaos';
const PORT = Number(process.env.PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const MODE = process.env.CHAOS_MODE === 'paced' ? 'paced' : 'crash';
const DRAIN_TIMEOUT_MS = 120_000;

// Per-mode shape. Both keep a fixed number of events per patient so the order oracle (below) can
// assert the folded state against an independent in-order computation.
const CONFIG =
  MODE === 'paced'
    ? {
        patients: Number(process.env.PATIENTS ?? 30),
        eventsPerPatient: Number(process.env.EVENTS_PER_PATIENT ?? 20),
        ratePerMin: Number(process.env.RATE_PER_MIN ?? 1200),
        external: {
          EXTERNAL_MS: process.env.EXTERNAL_MS ?? '5000',
          EXTERNAL_TIMEOUT_MS: '8000',
          LEASE_MS: '30000',
          CONCURRENCY: process.env.CONCURRENCY ?? '120',
          IDLE_MS: '100',
          REAPER_MS: '1000',
          MAX_ATTEMPTS: '10',
        },
      }
    : {
        patients: 5,
        eventsPerPatient: 20,
        ratePerMin: 0, // open-loop burst, unpaced
        external: {
          EXTERNAL_MS: '40',
          EXTERNAL_TIMEOUT_MS: '1000',
          LEASE_MS: '2000',
          CONCURRENCY: '20',
          IDLE_MS: '50',
          REAPER_MS: '400',
          MAX_ATTEMPTS: '10',
        },
      };

const APP_ENV = { ...process.env, PORT: String(PORT), MONGO_URL, MONGO_DB, ...CONFIG.external };

const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

// Each event's data carries its seq; the simulated external echoes data into the effect and the
// fold is last-writer-wins, so a patient's folded state.values.data.seq is the seq of its
// last-applied event. With distinct per-second timestamps, the last-applied event (max cursor) is
// always the highest seq IF the reducer folds in (ts, eventId) order - which is exactly what the
// order oracle checks.
function buildEvents() {
  const events = [];
  for (let p = 0; p < CONFIG.patients; p++) {
    const patientId = `patient-${p}`;
    for (let i = 0; i < CONFIG.eventsPerPatient; i++) {
      events.push({
        patientId,
        type: 'obs',
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        data: { seq: i, v: randomUUID() },
      });
    }
  }
  return events;
}

// Tracked so the finally block can guarantee no orphaned child survives the run.
const children = new Set();
function spawnApp() {
  const app = spawn('node', ['dist/main.js'], { env: APP_ENV, stdio: 'ignore' });
  children.add(app);
  app.once('exit', () => children.delete(app));
  return app;
}
async function killApp(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) {
    return;
  }
  app.kill('SIGKILL');
  await once(app, 'exit'); // wait for the real process death before restarting, no timing guesses
}

async function waitForHealth(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`${BASE}/stats`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('app did not become healthy');
}

async function counts(db) {
  const rows = await db
    .collection('records')
    .aggregate([{ $match: { kind: 'event' } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray();
  const c = { queued: 0, processing: 0, ready: 0, failed: 0 };
  for (const r of rows) c[r._id] = r.n;
  const orphans = await db
    .collection('records')
    .countDocuments({ kind: 'event', status: 'ready', folded: false });
  const events = await db.collection('records').countDocuments({ kind: 'event' });
  const snapshots = await db.collection('records').countDocuments({ kind: 'snapshot' });
  return { ...c, orphans, events, snapshots };
}

// The sender contract: a connection error or 5xx means "unknown", so resend the same body (dedup
// makes the resend safe). Each 202 records the real persisted eventId. This models an honest sender
// and lets us assert conservation over acknowledged events, not raw attempts.
function makeSender(acked, counters) {
  return async (e) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const res = await fetch(`${BASE}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(e),
        });
        if (res.status === 202) {
          const body = await res.json();
          acked.set(body.eventId, e.patientId);
          return;
        }
      } catch {
        // connection refused while the app is down - retry
      }
      await sleep(100);
    }
    // all retries spent without a 202: a real delivery failure, not conservation. Counted so a
    // stuck sender fails the run instead of silently shrinking the expected set.
    counters.undelivered += 1;
  };
}

// Conservation (by id-set, not just count) AND per-patient order, asserted once the queue drains.
async function assertOutcome(db, acked, counters, last) {
  const distinctAcked = acked.size;
  const ackedPatients = new Set(acked.values()).size;

  const ackedIds = [...acked.keys()];
  const ackedDocs = await db
    .collection('records')
    .countDocuments({ kind: 'event', eventId: { $in: ackedIds } });

  // Order oracle: every patient folded ALL of its events, and the LAST-applied event is the one
  // with the maximum cursor (highest seq). A scrambled fold (events applied in arrival order
  // instead of (ts, eventId) order) would leave a different seq as the last value and fail here -
  // a count-only check would not catch it.
  const expectLastSeq = CONFIG.eventsPerPatient - 1;
  const maxTsMs = Date.UTC(2026, 0, 1, 0, 0, CONFIG.eventsPerPatient - 1);
  const snapshots = await db.collection('records').find({ kind: 'snapshot' }).toArray();
  const allInOrder = snapshots.every(
    (s) =>
      s.state.appliedCount === CONFIG.eventsPerPatient &&
      s.state.values?.data?.seq === expectLastSeq &&
      s.appliedThrough &&
      new Date(s.appliedThrough.ts).getTime() === maxTsMs,
  );

  const ok =
    counters.undelivered === 0 &&
    last.queued === 0 &&
    last.processing === 0 &&
    last.orphans === 0 &&
    last.failed === 0 &&
    last.events === distinctAcked &&
    ackedDocs === distinctAcked &&
    last.ready === distinctAcked &&
    last.snapshots === ackedPatients &&
    allInOrder;

  return { ok, distinctAcked, ackedPatients, ackedDocs, allInOrder };
}

async function drain(db) {
  const start = Date.now();
  let last;
  while (Date.now() - start < DRAIN_TIMEOUT_MS) {
    last = await counts(db);
    if (last.queued === 0 && last.processing === 0 && last.orphans === 0) break;
    await sleep(300);
  }
  return { last, ms: Date.now() - start };
}

async function crashDemo(db) {
  const logical = buildEvents();
  const uniqueLogical = logical.length;

  let app = spawnApp();
  await waitForHealth(20_000);
  console.log(`service up on ${PORT}; bursting ${uniqueLogical} events (x2 duplicates)...`);

  const acked = new Map();
  const counters = { undelivered: 0 };
  const send = makeSender(acked, counters);

  // open-loop burst: every event sent twice, shuffled across patients
  const sends = shuffle([...logical, ...logical]).map((e) => send(e));

  // crash the app mid-flight, then restart it; the in-flight sends retry against the new process
  const burstStart = Date.now();
  while ((await counts(db)).processing === 0) {
    if (Date.now() - burstStart > 20_000) {
      throw new Error('no event ever reached processing - the pipeline is not consuming');
    }
    await sleep(20);
  }
  console.log('processing in flight -> SIGKILL the app (simulated crash)');
  await killApp(app);
  app = spawnApp();
  await waitForHealth(20_000);
  await Promise.allSettled(sends);
  console.log('all events acknowledged; waiting for the queue to drain...');

  const { last, ms } = await drain(db);
  await killApp(app);

  const outcome = await assertOutcome(db, acked, counters, last);
  report({ title: 'crash', uniqueLogical, sentFactor: 2, counters, last, outcome, recoveryMs: ms });
  return outcome.ok;
}

async function pacedRun(db) {
  const logical = buildEvents();
  const total = logical.length;
  const intervalMs = 60_000 / CONFIG.ratePerMin;

  let app = spawnApp();
  await waitForHealth(20_000);
  console.log(
    `service up on ${PORT}; paced send of ${total} events at ~${CONFIG.ratePerMin}/min ` +
      `(EXTERNAL_MS=${CONFIG.external.EXTERNAL_MS}, CONCURRENCY=${CONFIG.external.CONCURRENCY})...`,
  );

  const acked = new Map();
  const counters = { undelivered: 0 };
  const send = makeSender(acked, counters);

  const order = shuffle([...logical]);
  const crashAt = Math.floor(total * 0.4);
  const sends = [];
  const sendStart = Date.now();
  let crashed = false;
  for (let i = 0; i < order.length; i++) {
    sends.push(send(order[i]));
    if (!crashed && i >= crashAt) {
      crashed = true;
      console.log(`~${i}/${total} sent -> SIGKILL the app mid-run`);
      await killApp(app);
      app = spawnApp();
      await waitForHealth(20_000);
    }
    await sleep(intervalMs);
  }
  const sendMs = Date.now() - sendStart;
  await Promise.allSettled(sends);
  console.log('all events acknowledged; waiting for the queue to drain at the real delay...');

  const { last, ms } = await drain(db);
  await killApp(app);

  const outcome = await assertOutcome(db, acked, counters, last);
  const achievedRate = Math.round((total / sendMs) * 60_000);
  report({
    title: 'paced',
    uniqueLogical: total,
    sentFactor: 1,
    counters,
    last,
    outcome,
    recoveryMs: ms,
    extra: [
      `target rate            : ${CONFIG.ratePerMin}/min`,
      `achieved send rate     : ${achievedRate}/min over ${(sendMs / 1000).toFixed(1)}s`,
      `external delay         : ${CONFIG.external.EXTERNAL_MS} ms (real), concurrency ${CONFIG.external.CONCURRENCY}`,
      `note                   : uniform load; patient skew and preloaded history are not modeled`,
    ],
  });
  return outcome.ok;
}

function report({ title, uniqueLogical, sentFactor, counters, last, outcome, recoveryMs, extra = [] }) {
  console.log(`\n--- chaos result (${title}) ---`);
  console.log(`events sent (x${sentFactor})       : ${uniqueLogical * sentFactor}`);
  console.log(`distinct acked (202)    : ${outcome.distinctAcked}`);
  console.log(`undelivered (gave up)   : ${counters.undelivered}`);
  console.log(`persisted events        : ${last.events} (dedup collapsed resends + duplicates)`);
  console.log(`acked ids present once  : ${outcome.ackedDocs} / ${outcome.distinctAcked}`);
  console.log(`ready / folded          : ${last.ready}, orphans: ${last.orphans}`);
  console.log(`queued / processing     : ${last.queued} / ${last.processing}`);
  console.log(`failed                  : ${last.failed}`);
  console.log(`snapshots               : ${last.snapshots} (acked patients: ${outcome.ackedPatients})`);
  console.log(`all patients in order   : ${outcome.allInOrder} (count + last-applied = max cursor)`);
  for (const line of extra) console.log(line);
  console.log(`recovery/drain time     : ${recoveryMs} ms (reported, not asserted)`);
  console.log(`conservation + order    : ${outcome.ok ? 'PASS' : 'FAIL'}`);
}

async function main() {
  console.log(`building... (mode=${MODE})`);
  execSync('npm run build', { stdio: 'inherit' });

  const client = await MongoClient.connect(MONGO_URL);
  const db = client.db(MONGO_DB);
  try {
    // dedicated chaos db: drop the whole collection (indexes included) for a clean slate, so the
    // app's ensureIndexes starts from nothing
    await db.collection('records').drop().catch(() => undefined);
    const ok = MODE === 'paced' ? await pacedRun(db) : await crashDemo(db);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.close();
    await Promise.allSettled([...children].map((c) => killApp(c)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

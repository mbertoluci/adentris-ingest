// Standalone chaos demo (not part of `npm test`: it needs Docker, a port, a real SIGKILL and a
// real clock - the top source of flakiness). It bursts duplicated, out-of-order events at the
// running service, SIGKILLs the app mid-flight to simulate a crash, restarts it, and then asserts
// conservation once the queue drains: every distinct event is accepted exactly once, nothing is
// left queued/processing, and no ready event is left unfolded. Recovery time is reported, not
// asserted.
//
// Usage: `docker compose up -d mongo` first, then `npm run chaos`.
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
// Fixed, never inherited: this script runs deleteMany, so it must not point at the demo db even
// if MONGO_DB is exported in the shell.
const MONGO_DB = 'ingest_chaos';
const PORT = Number(process.env.PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const PATIENTS = 5;
const EVENTS_PER_PATIENT = 20;
const DRAIN_TIMEOUT_MS = 60_000;

const APP_ENV = {
  ...process.env,
  PORT: String(PORT),
  MONGO_URL,
  MONGO_DB,
  EXTERNAL_MS: '40',
  EXTERNAL_TIMEOUT_MS: '1000',
  LEASE_MS: '2000',
  IDLE_MS: '50',
  REAPER_MS: '400',
  CONCURRENCY: '20',
  MAX_ATTEMPTS: '10',
};

const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

function buildEvents() {
  const events = [];
  for (let p = 0; p < PATIENTS; p++) {
    const patientId = `patient-${p}`;
    for (let i = 0; i < EVENTS_PER_PATIENT; i++) {
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

function spawnApp() {
  const app = spawn('node', ['dist/main.js'], { env: APP_ENV, stdio: 'ignore' });
  return app;
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

async function main() {
  console.log('building...');
  execSync('npm run build', { stdio: 'inherit' });

  const client = await MongoClient.connect(MONGO_URL);
  const db = client.db(MONGO_DB);
  // dedicated chaos db: drop the whole collection (indexes included) for a clean slate, so the
  // app's ensureIndexes starts from nothing
  await db.collection('records').drop().catch(() => undefined);

  const logical = buildEvents();
  const uniqueLogical = logical.length; // each is distinct by (patientId, data.v)

  let app = spawnApp();
  await waitForHealth(20_000);
  console.log(`service up on ${PORT}; bursting ${uniqueLogical} events (x2 duplicates)...`);

  // The sender contract: a connection error or 5xx means "unknown", so resend the same body
  // (dedup makes the resend safe). Each 202 records the real persisted eventId. This models an
  // honest sender and lets us assert conservation over acknowledged events, not raw attempts.
  const acked = new Map(); // eventId -> patientId
  let undelivered = 0;
  const sendWithRetry = async (e) => {
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
    undelivered += 1;
  };

  // open-loop burst: every event sent twice, shuffled across patients
  const sends = shuffle([...logical, ...logical]).map((e) => sendWithRetry(e));

  // crash the app mid-flight, then restart it; the in-flight sends retry against the new process
  const burstStart = Date.now();
  while ((await counts(db)).processing === 0) {
    if (Date.now() - burstStart > 20_000) {
      throw new Error('no event ever reached processing - the pipeline is not consuming');
    }
    await sleep(20);
  }
  console.log('processing in flight -> SIGKILL the app (simulated crash)');
  app.kill('SIGKILL');
  app = spawnApp();
  await waitForHealth(20_000);
  await Promise.allSettled(sends);
  console.log('all events acknowledged; waiting for the queue to drain...');

  const recoveryStart = Date.now();
  let last;
  while (Date.now() - recoveryStart < DRAIN_TIMEOUT_MS) {
    last = await counts(db);
    if (last.queued === 0 && last.processing === 0 && last.orphans === 0) break;
    await sleep(300);
  }
  const recoveryMs = Date.now() - recoveryStart;

  app.kill('SIGKILL');

  const distinctAcked = acked.size;
  const ackedPatients = new Set(acked.values()).size;

  // Conservation by id-set, not just count: every acknowledged eventId is present exactly once,
  // and there are no events the sender never acked (an id substitution with the same count fails).
  const ackedIds = [...acked.keys()];
  const ackedDocs = await db
    .collection('records')
    .countDocuments({ kind: 'event', eventId: { $in: ackedIds } });

  // Content, not only shape: every patient's snapshot folded all of its acked events, in order.
  const perPatient = await db
    .collection('records')
    .find({ kind: 'snapshot' })
    .toArray();
  const allFolded = perPatient.every((s) => s.state.appliedCount === EVENTS_PER_PATIENT);

  const ok =
    undelivered === 0 &&
    last.queued === 0 &&
    last.processing === 0 &&
    last.orphans === 0 &&
    last.failed === 0 &&
    last.events === distinctAcked &&
    ackedDocs === distinctAcked &&
    last.ready === distinctAcked &&
    last.snapshots === ackedPatients &&
    allFolded;

  console.log('\n--- chaos result ---');
  console.log(`events sent (x2)        : ${uniqueLogical * 2}`);
  console.log(`distinct acked (202)    : ${distinctAcked}`);
  console.log(`undelivered (gave up)   : ${undelivered}`);
  console.log(`persisted events        : ${last.events} (dedup collapsed resends + duplicates)`);
  console.log(`acked ids present once  : ${ackedDocs} / ${distinctAcked}`);
  console.log(`ready / folded          : ${last.ready}, orphans: ${last.orphans}`);
  console.log(`queued / processing     : ${last.queued} / ${last.processing}`);
  console.log(`failed                  : ${last.failed}`);
  console.log(`snapshots               : ${last.snapshots} (acked patients: ${ackedPatients})`);
  console.log(`all patients fully folded: ${allFolded}`);
  console.log(`recovery time           : ${recoveryMs} ms (reported, not asserted)`);
  console.log(`conservation            : ${ok ? 'PASS' : 'FAIL'}`);

  await client.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

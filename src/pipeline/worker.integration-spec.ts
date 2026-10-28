import { Db } from 'mongodb';
import { closeMongo, getMongo, resetRecords } from '../../test/mongo';
import { MongoService } from '../database/mongo.service';
import { Clock, ExternalInput, ExternalProcessor } from '../domain/ports';
import { EventDoc, RECORDS_COLLECTION } from '../records/record.types';
import { RecordsRepository } from '../records/records.repository';
import { Reaper } from './reaper';
import { Reducer } from './reducer';
import { ReductionTrigger, Worker } from './worker';

const LEASE = 30_000;
const TIMEOUT = 10_000;
const MAX_ATTEMPTS = 5;

class RecordingReduction implements ReductionTrigger {
  readonly calls: string[] = [];
  async run(patientId: string): Promise<void> {
    this.calls.push(patientId);
  }
}

const noop: ReductionTrigger = { async run(): Promise<void> {} };

class MutableClock implements Clock {
  constructor(private t = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return this.t;
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

class InstantExternal implements ExternalProcessor {
  constructor(private readonly tag: string) {}
  async process(_event: ExternalInput): Promise<Record<string, unknown>> {
    return { by: this.tag };
  }
}

class RejectingExternal implements ExternalProcessor {
  async process(_event: ExternalInput): Promise<Record<string, unknown>> {
    throw new Error('external boom');
  }
}

class GatedExternal implements ExternalProcessor {
  private open!: () => void;
  readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  constructor(private readonly tag: string) {}
  release(): void {
    this.open();
  }
  async process(_event: ExternalInput): Promise<Record<string, unknown>> {
    await this.gate;
    return { by: this.tag };
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Worker (C2 fencing, C8 timeout)', () => {
  let db: Db;
  let repo: RecordsRepository;
  const clock = new MutableClock();

  const insertQueued = (eventId: string, patientId = 'p1') =>
    db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId,
      patientId,
      type: 't',
      data: {},
      ts: clock.now(),
      receivedAt: clock.now(),
      status: 'queued',
      folded: false,
      attempts: 0,
    });

  const find = (eventId: string) =>
    db.collection(RECORDS_COLLECTION).findOne({ eventId }) as Promise<EventDoc | null>;

  beforeAll(async () => {
    db = await getMongo();
    repo = new RecordsRepository({ db } as unknown as MongoService);
  });

  beforeEach(async () => {
    await resetRecords();
  });

  afterAll(async () => {
    await closeMongo();
  });

  it('claims the oldest queued event, commits it ready, and triggers reduction', async () => {
    await insertQueued('e1');
    const reduction = new RecordingReduction();
    const worker = new Worker(repo, clock, new InstantExternal('ok'), reduction, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });

    expect(await worker.processOne()).toBe(true);

    const doc = await find('e1');
    expect(doc?.status).toBe('ready');
    expect(doc?.effect).toEqual({ by: 'ok' });
    expect(doc?.fence).toBeUndefined();
    expect(reduction.calls).toEqual(['p1']);
  });

  it('returns false when there is nothing to claim', async () => {
    const worker = new Worker(repo, clock, new InstantExternal('ok'), noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });
    expect(await worker.processOne()).toBe(false);
  });

  it('rejects a zombie commit after the lease was reclaimed (C2)', async () => {
    await insertQueued('e1');
    const gatedA = new GatedExternal('A');
    const workerA = new Worker(repo, clock, gatedA, noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });
    const workerB = new Worker(repo, clock, new InstantExternal('B'), noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });

    // A claims the event (fence A) and hangs inside the external call
    const aTurn = workerA.processOne();
    await waitFor(async () => (await find('e1'))?.status === 'processing');

    // the lease expires and the reaper requeues it (simulated as a direct requeue here)
    await db
      .collection(RECORDS_COLLECTION)
      .updateOne({ eventId: 'e1' }, { $set: { status: 'queued' }, $unset: { fence: '', leaseUntil: '' } });

    // B claims the requeued event (fence B) and commits instantly
    expect(await workerB.processOne()).toBe(true);
    expect((await find('e1'))?.effect).toEqual({ by: 'B' });

    // A now finishes and tries to commit under the stale fence A - it must not land
    gatedA.release();
    await aTurn;

    const final = await find('e1');
    expect(final?.status).toBe('ready');
    expect(final?.effect).toEqual({ by: 'B' });
  });

  it('abandons a timed-out external call without flipping to ready (C8)', async () => {
    await insertQueued('e1');
    const gated = new GatedExternal('slow'); // never released before the timeout
    const worker = new Worker(repo, clock, gated, noop, { leaseMs: LEASE, externalTimeoutMs: 20 });

    expect(await worker.processOne()).toBe(true);

    const doc = await find('e1');
    expect(doc?.status).toBe('processing'); // left for the reaper to requeue
    expect(doc?.effect).toBeUndefined();
    gated.release();
  });

  it('a rejected external call leaves the event processing and burns one attempt (C14)', async () => {
    await insertQueued('e1');
    const worker = new Worker(repo, clock, new RejectingExternal(), noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });

    expect(await worker.processOne()).toBe(true);

    const doc = await find('e1');
    expect(doc?.status).toBe('processing'); // only the reaper budget decides failed
    expect(doc?.effect).toBeUndefined();
    expect(doc?.attempts).toBe(1);
  });

  it('N workers racing one queued event: exactly one claims it', async () => {
    await insertQueued('e1');
    const workers = Array.from(
      { length: 8 },
      (_unused, i) => new Worker(repo, clock, new InstantExternal(`w${i}`), noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT }),
    );

    const results = await Promise.all(workers.map((w) => w.processOne()));

    expect(results.filter(Boolean).length).toBe(1); // the atomic claim admits exactly one
    expect((await find('e1'))?.status).toBe('ready');
  });

  it('N workers racing M queued events: each event is claimed once', async () => {
    for (let i = 0; i < 5; i++) {
      await insertQueued(`e${i}`, `p${i}`);
    }
    const workers = Array.from(
      { length: 8 },
      () => new Worker(repo, clock, new InstantExternal('x'), noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT }),
    );

    await Promise.all(
      workers.map(async (w) => {
        while (await w.processOne()) {
          /* drain until idle */
        }
      }),
    );

    const ready = await db
      .collection(RECORDS_COLLECTION)
      .countDocuments({ kind: 'event', status: 'ready' });
    expect(ready).toBe(5); // none claimed (and processed) twice
  });

  it('a throwing reduction does not fail the committed turn (C15)', async () => {
    await insertQueued('e1');
    const throwing: ReductionTrigger = {
      async run(): Promise<void> {
        throw new Error('fold boom');
      },
    };
    const worker = new Worker(repo, clock, new InstantExternal('ok'), throwing, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });

    expect(await worker.processOne()).toBe(true);
    expect((await find('e1'))?.status).toBe('ready'); // committed despite the reduce throw
  });

  it('zombie end-to-end via the real reaper: B wins, stale fence A bounces (C2)', async () => {
    const localClock = new MutableClock();
    await insertQueued('e1');
    const gatedA = new GatedExternal('A');
    const workerA = new Worker(repo, localClock, gatedA, noop, { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });
    const workerB = new Worker(repo, localClock, new InstantExternal('B'), new Reducer(repo), { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });
    const reaper = new Reaper(repo, localClock, new Reducer(repo), MAX_ATTEMPTS);

    const aTurn = workerA.processOne(); // claims (fence A), hangs inside the external call
    await waitFor(async () => (await find('e1'))?.status === 'processing');

    // A's lease expires and the REAL reaper requeues it (no manual updateOne)
    localClock.advance(LEASE + 1_000);
    expect((await reaper.tick()).requeued).toBe(1);

    // B claims the requeued event and commits
    expect(await workerB.processOne()).toBe(true);
    expect((await find('e1'))?.effect).toEqual({ by: 'B' });

    // A finishes and tries to commit under the stale fence A - it must not land
    gatedA.release();
    await aTurn;
    const final = await find('e1');
    expect(final?.status).toBe('ready');
    expect(final?.effect).toEqual({ by: 'B' });
  });
});

import { Db } from 'mongodb';
import { closeMongo, getMongo, resetRecords } from '../../test/mongo';
import { MongoService } from '../database/mongo.service';
import { Clock, ExternalInput, ExternalProcessor } from '../domain/ports';
import { EventDoc, RECORDS_COLLECTION, SnapshotDoc } from '../records/record.types';
import { RecordsRepository } from '../records/records.repository';
import { Reaper } from './reaper';
import { Reducer } from './reducer';
import { ReductionTrigger, Worker, WorkerRepo } from './worker';

const MAX_ATTEMPTS = 5;
const LEASE = 30_000;
const TIMEOUT = 10_000;
const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec));

class MutableClock implements Clock {
  constructor(private t: Date) {}
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

class RecordingReduction implements ReductionTrigger {
  readonly calls: string[] = [];
  async run(patientId: string): Promise<void> {
    this.calls.push(patientId);
  }
}

describe('Reaper (F5 recovery, C5, C14)', () => {
  let db: Db;
  let repo: RecordsRepository;

  const find = (eventId: string) =>
    db.collection(RECORDS_COLLECTION).findOne({ eventId }) as Promise<EventDoc | null>;
  const snapshot = (patientId: string) =>
    db.collection(RECORDS_COLLECTION).findOne({ kind: 'snapshot', patientId }) as Promise<SnapshotDoc | null>;

  const insertProcessing = (eventId: string, attempts: number, leaseUntil: Date) =>
    db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId,
      patientId: 'p1',
      type: 't',
      data: {},
      ts: at(1),
      receivedAt: at(1),
      status: 'processing',
      folded: false,
      attempts,
      fence: 'fence-old',
      leaseUntil,
    });

  const insertQueued = (eventId: string, patientId = 'p1') =>
    db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId,
      patientId,
      type: 't',
      data: {},
      ts: at(1),
      receivedAt: at(1),
      status: 'queued',
      folded: false,
      attempts: 0,
    });

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

  it('requeues an event whose lease expired (attempts under budget)', async () => {
    await insertProcessing('e1', 1, at(50));
    const clock = new MutableClock(at(100));
    const reaper = new Reaper(repo, clock, new RecordingReduction(), MAX_ATTEMPTS);

    const result = await reaper.tick();

    expect(result.requeued).toBe(1);
    const doc = await find('e1');
    expect(doc?.status).toBe('queued');
    expect(doc?.fence).toBeUndefined();
    expect(doc?.leaseUntil).toBeUndefined();
  });

  it('parks an event as failed once the attempts budget is spent (C14)', async () => {
    await insertProcessing('e1', MAX_ATTEMPTS, at(50));
    const clock = new MutableClock(at(100));
    const reaper = new Reaper(repo, clock, new RecordingReduction(), MAX_ATTEMPTS);

    const result = await reaper.tick();

    expect(result.failed).toBe(1);
    const doc = await find('e1');
    expect(doc?.status).toBe('failed');
    expect(doc?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('leaves a still-valid lease untouched', async () => {
    await insertProcessing('e1', 1, at(200)); // lease in the future
    const clock = new MutableClock(at(100));
    const reaper = new Reaper(repo, clock, new RecordingReduction(), MAX_ATTEMPTS);

    const result = await reaper.tick();

    expect(result.requeued).toBe(0);
    expect((await find('e1'))?.status).toBe('processing');
  });

  it('re-triggers reduction for a patient with an orphan ready event (C5)', async () => {
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId: 'e1',
      patientId: 'pX',
      type: 't',
      data: {},
      ts: at(1),
      receivedAt: at(1),
      status: 'ready',
      folded: false,
      attempts: 1,
      effect: {},
    });
    const clock = new MutableClock(at(100));
    const reduction = new RecordingReduction();
    const reaper = new Reaper(repo, clock, reduction, MAX_ATTEMPTS);

    const result = await reaper.tick();

    expect(result.reduced).toBe(1);
    expect(reduction.calls).toEqual(['pX']);
  });

  it('recovers a crashed in-flight event: reaper requeues, a worker completes it (F5)', async () => {
    const clock = new MutableClock(at(0));
    await insertQueued('e1', 'p1');

    // worker A claims it and then "crashes" (we just abandon the claim)
    await repo.claimNext(clock.now(), LEASE, 'fence-A');
    expect((await find('e1'))?.status).toBe('processing');

    // its lease expires
    clock.advance(LEASE + 1_000);
    const reaper = new Reaper(repo, clock, new Reducer(repo), MAX_ATTEMPTS);
    expect((await reaper.tick()).requeued).toBe(1);

    // a healthy worker picks up the requeued event and drives it to a snapshot
    const worker = new Worker(repo, clock, new InstantExternal('ok'), new Reducer(repo), { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });
    expect(await worker.processOne()).toBe(true);

    expect((await find('e1'))?.status).toBe('ready');
    expect((await snapshot('p1'))?.appliedThrough?.eventId).toBe('e1');
  });

  it('flips the snapshot blocked when a retroactive failed gap appears, via the reaper (C4)', async () => {
    const clock = new MutableClock(at(100));
    // b (ts=10) is published and folded; the snapshot is not blocked
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId: 'b',
      patientId: 'p1',
      type: 't',
      data: {},
      ts: at(10),
      receivedAt: at(10),
      status: 'ready',
      folded: false,
      attempts: 0,
      effect: { v: 'b' },
    });
    await new Reducer(repo).run('p1');
    expect((await snapshot('p1'))?.blocked).toBe(false);

    // an earlier event is now failed (budget spent) - it raises no ready orphan
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId: 'a',
      patientId: 'p1',
      type: 't',
      data: {},
      ts: at(5),
      receivedAt: at(5),
      status: 'failed',
      folded: false,
      attempts: MAX_ATTEMPTS,
    });

    // the reaper reconciles blocked without any manual reducer call
    const reaper = new Reaper(repo, clock, new Reducer(repo), MAX_ATTEMPTS);
    await reaper.tick();

    const snap = await snapshot('p1');
    expect(snap?.blocked).toBe(true);
    expect(snap?.appliedThrough?.eventId).toBe('b'); // state preserved, not regressed
  });

  it('does not refold a patient whose snapshot is already blocked (bounded sweep)', async () => {
    const clock = new MutableClock(at(100));
    // a failed event with an already-blocked snapshot: the stable state, nothing left to do
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId: 'a',
      patientId: 'p1',
      type: 't',
      data: {},
      ts: at(5),
      receivedAt: at(5),
      status: 'failed',
      folded: false,
      attempts: MAX_ATTEMPTS,
    });
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'snapshot',
      patientId: 'p1',
      version: 1,
      state: { appliedCount: 0, lastType: null, values: {} },
      appliedThrough: null,
      blocked: true,
    });

    // a recording trigger proves the already-blocked patient is dropped from the sweep: no O(history)
    // refold is paid tick after tick for a permanently blocked patient.
    const reduction = new RecordingReduction();
    const reaper = new Reaper(repo, clock, reduction, MAX_ATTEMPTS);
    const result = await reaper.tick();

    expect(reduction.calls).toEqual([]); // not re-reduced
    expect(result.reduced).toBe(0);
  });

  it('does not refold a blocked patient for a ready event stranded behind the failed gap', async () => {
    const clock = new MutableClock(at(100));
    // first event failed (blocked, no published prefix), then a later ready event arrives: it sits
    // strictly after the failed gap and can never fold until the gap is requeued. It must NOT drive
    // a full-history refold every tick.
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event', eventId: 'a', patientId: 'p1', type: 't', data: {},
      ts: at(5), receivedAt: at(5), status: 'failed', folded: false, attempts: MAX_ATTEMPTS,
    });
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event', eventId: 'b', patientId: 'p1', type: 't', data: {},
      ts: at(10), receivedAt: at(10), status: 'ready', folded: false, attempts: 0, effect: {},
    });
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'snapshot', patientId: 'p1', version: 1,
      state: { appliedCount: 0, lastType: null, values: {} }, appliedThrough: null, blocked: true,
    });

    const reduction = new RecordingReduction();
    const result = await new Reaper(repo, clock, reduction, MAX_ATTEMPTS).tick();

    expect(reduction.calls).toEqual([]); // stranded ready is not a sweep target
    expect(result.reduced).toBe(0);
  });

  it('still sweeps a genuine C5 orphan inside a blocked patient prefix', async () => {
    const clock = new MutableClock(at(100));
    // published prefix through b (ts=10), a later failed gap makes the snapshot blocked, and b is a
    // crash orphan (snapshot written, markFolded not reached): b is WITHIN the prefix, so it must
    // still be reconciled.
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event', eventId: 'b', patientId: 'p1', type: 't', data: {},
      ts: at(10), receivedAt: at(10), status: 'ready', folded: false, attempts: 0, effect: {},
    });
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event', eventId: 'c', patientId: 'p1', type: 't', data: {},
      ts: at(15), receivedAt: at(15), status: 'failed', folded: false, attempts: MAX_ATTEMPTS,
    });
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'snapshot', patientId: 'p1', version: 1,
      state: { appliedCount: 1, lastType: 't', values: {} },
      appliedThrough: { ts: at(10), eventId: 'b' }, blocked: true,
    });

    const reduction = new RecordingReduction();
    const result = await new Reaper(repo, clock, reduction, MAX_ATTEMPTS).tick();

    expect(reduction.calls).toEqual(['p1']); // in-prefix orphan is still reconciled
    expect(result.reduced).toBe(1);
  });

  it('a throwing reduction for one patient does not abort the tick (C15)', async () => {
    for (const [eventId, patientId] of [
      ['e1', 'pA'],
      ['e2', 'pB'],
    ]) {
      await db.collection(RECORDS_COLLECTION).insertOne({
        kind: 'event',
        eventId,
        patientId,
        type: 't',
        data: {},
        ts: at(1),
        receivedAt: at(1),
        status: 'ready',
        folded: false,
        attempts: 1,
        effect: {},
      });
    }
    const throwing: ReductionTrigger = {
      async run(patientId: string): Promise<void> {
        if (patientId === 'pA') {
          throw new Error('boom');
        }
      },
    };
    const reaper = new Reaper(repo, new MutableClock(at(100)), throwing, MAX_ATTEMPTS);

    const result = await reaper.tick();
    expect(result.reduced).toBe(1); // the other patient was still reduced
  });

  it('an unavailable commit never burns the attempts budget (C14)', async () => {
    const clock = new MutableClock(at(0));
    await insertQueued('e1');

    // the external call always succeeds, but the first few commits hit infra trouble
    let commitFails = 3;
    const flakyRepo: WorkerRepo = {
      claimNext: (now, lease, fence) => repo.claimNext(now, lease, fence),
      commitReady: async (id, fence, effect) => {
        if (commitFails > 0) {
          commitFails -= 1;
          throw new Error('mongo unavailable');
        }
        return repo.commitReady(id, fence, effect);
      },
      recordExternalFailure: (id, fence, now) => repo.recordExternalFailure(id, fence, now),
    };
    const worker = new Worker(flakyRepo, clock, new InstantExternal('ok'), new Reducer(repo), { leaseMs: LEASE, externalTimeoutMs: TIMEOUT });
    const reaper = new Reaper(repo, clock, new Reducer(repo), MAX_ATTEMPTS);

    for (let i = 0; i < 6; i++) {
      await worker.processOne();
      clock.advance(LEASE + 1_000);
      await reaper.tick();
      if ((await find('e1'))?.status === 'ready') {
        break;
      }
    }

    const doc = await find('e1');
    expect(doc?.status).toBe('ready'); // recovered, never parked as failed
    expect(doc?.attempts).toBe(0); // infra never incremented the budget
  });
});

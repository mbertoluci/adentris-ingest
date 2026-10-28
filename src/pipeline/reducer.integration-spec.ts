import { Db } from 'mongodb';
import { closeMongo, getMongo, resetRecords } from '../../test/mongo';
import { MongoService } from '../database/mongo.service';
import { EventStatus, RECORDS_COLLECTION, SnapshotDoc } from '../records/record.types';
import { RecordsRepository } from '../records/records.repository';
import { Reducer, ReducerRepo } from './reducer';

const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec));

describe('Reducer (F3 / C1 / C4 / C5 / C3)', () => {
  let db: Db;
  let repo: RecordsRepository;
  let reducer: Reducer;

  const insert = (
    eventId: string,
    sec: number,
    status: EventStatus,
    effect?: Record<string, unknown>,
  ) =>
    db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId,
      patientId: 'p1',
      type: 't',
      data: {},
      ts: at(sec),
      receivedAt: at(sec),
      status,
      folded: status === 'ready' ? false : false,
      attempts: 1,
      ...(effect ? { effect } : {}),
    });

  const snapshot = () =>
    db.collection(RECORDS_COLLECTION).findOne({ kind: 'snapshot', patientId: 'p1' }) as Promise<SnapshotDoc | null>;

  const foldedIds = async () =>
    (
      await db
        .collection(RECORDS_COLLECTION)
        .find({ kind: 'event', folded: true })
        .toArray()
    )
      .map((d) => d.eventId as string)
      .sort();

  beforeAll(async () => {
    db = await getMongo();
    repo = new RecordsRepository({ db } as unknown as MongoService);
    reducer = new Reducer(repo);
  });

  beforeEach(async () => {
    await resetRecords();
  });

  afterAll(async () => {
    await closeMongo();
  });

  it('folds a ready prefix into a snapshot and marks it folded', async () => {
    await insert('a', 1, 'ready', { v: 1 });
    await insert('b', 2, 'ready', { v: 2 });

    await reducer.run('p1');

    const snap = await snapshot();
    expect(snap?.version).toBe(1);
    expect(snap?.state.values).toEqual({ v: 2 });
    expect(snap?.appliedThrough).toEqual({ ts: at(2), eventId: 'b' });
    expect(await foldedIds()).toEqual(['a', 'b']);
  });

  it('stops at a transient gap and advances once it clears', async () => {
    await insert('a', 1, 'ready', { v: 1 });
    await insert('b', 2, 'queued'); // gap
    await insert('c', 3, 'ready', { v: 3 });

    await reducer.run('p1');
    expect((await snapshot())?.appliedThrough).toEqual({ ts: at(1), eventId: 'a' });
    expect(await foldedIds()).toEqual(['a']);

    // the gap clears
    await db
      .collection(RECORDS_COLLECTION)
      .updateOne({ eventId: 'b' }, { $set: { status: 'ready', effect: { v: 2 } } });
    await reducer.run('p1');

    const snap = await snapshot();
    expect(snap?.appliedThrough).toEqual({ ts: at(3), eventId: 'c' });
    expect(snap?.state.values).toEqual({ v: 3 });
    expect(await foldedIds()).toEqual(['a', 'b', 'c']);
  });

  it('does not regress the snapshot when a retroactive gap appears behind the cursor (C4)', async () => {
    await insert('x', 10, 'ready', { v: 'x' });
    await reducer.run('p1');
    const before = await snapshot();
    expect(before?.appliedThrough).toEqual({ ts: at(10), eventId: 'x' });

    // a late, earlier event arrives still queued
    await insert('early', 5, 'queued');
    await reducer.run('p1');

    const after = await snapshot();
    expect(after?.version).toBe(before?.version); // unchanged, no republish
    expect(after?.appliedThrough).toEqual({ ts: at(10), eventId: 'x' });

    // once the late event becomes ready, the full refold picks it up (C1)
    await db
      .collection(RECORDS_COLLECTION)
      .updateOne({ eventId: 'early' }, { $set: { status: 'ready', effect: { late: true } } });
    await reducer.run('p1');

    const final = await snapshot();
    expect(final?.state.appliedCount).toBe(2);
    expect(await foldedIds()).toEqual(['early', 'x']);
  });

  it('blocks the snapshot only when the gap is a failed event (C4)', async () => {
    await insert('a', 1, 'ready', { v: 1 });
    await insert('b', 2, 'failed');
    await reducer.run('p1');
    expect((await snapshot())?.blocked).toBe(true);
  });

  it('reconciles an orphan: a ready event not yet folded gets folded on the next run (C5)', async () => {
    // simulate a crash after the snapshot write but before markFolded
    await insert('a', 1, 'ready', { v: 1 });
    await db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'snapshot',
      patientId: 'p1',
      version: 1,
      state: { appliedCount: 1, lastType: 't', values: { v: 1 } },
      appliedThrough: { ts: at(1), eventId: 'a' },
      blocked: false,
    });
    expect(await foldedIds()).toEqual([]); // orphan: ready but folded=false

    await reducer.run('p1');
    expect(await foldedIds()).toEqual(['a']);
  });

  it('folds same-ms events in a stable (ts, eventId) order', async () => {
    await insert('b', 5, 'ready', { v: 'B' });
    await insert('a', 5, 'ready', { v: 'A' });

    await reducer.run('p1');

    const snap = await snapshot();
    expect(snap?.appliedThrough?.eventId).toBe('b'); // a sorts before b at the same ms
    expect(snap?.state.values.v).toBe('B'); // b is applied last
  });

  it('rejects a snapshot write under a stale version (C3)', async () => {
    await insert('a', 1, 'ready', { v: 1 });
    await reducer.run('p1'); // snapshot at version 1
    const v1 = (await snapshot())?.version;
    expect(v1).toBe(1);

    // a writer holding version 1 wins once (-> version 2)
    const first = await repo.saveSnapshot('p1', 1, {
      state: { appliedCount: 9, lastType: 't', values: { w: 'first' } },
      appliedThrough: { ts: at(1), eventId: 'a' },
      blocked: false,
    });
    expect(first).toBe(true);

    // a second writer still holding the stale version 1 must lose
    const second = await repo.saveSnapshot('p1', 1, {
      state: { appliedCount: 9, lastType: 't', values: { w: 'second' } },
      appliedThrough: { ts: at(1), eventId: 'a' },
      blocked: false,
    });
    expect(second).toBe(false);
    expect((await snapshot())?.state.values).toEqual({ w: 'first' });
  });

  it('a concurrent publish between the two reads does not cause an overwrite (C3 read-order)', async () => {
    // b (ts=10) is folded and published; the snapshot sits at it
    await insert('b', 10, 'ready', { v: 'b' });
    await reducer.run('p1');
    expect((await snapshot())?.state.appliedCount).toBe(1);

    // Inject, exactly once, right after the reducer's FIRST repository read: a late earlier event
    // becomes ready and a competing reducer publishes [a, b] and folds both. Whichever read comes
    // first (snapshot, with the fix; events, without it), the racing reducer then holds a stale
    // input and must not regress the published state.
    let injected = false;
    const inject = async (): Promise<void> => {
      if (injected) {
        return;
      }
      injected = true;
      await insert('a', 5, 'ready', { v: 'a' });
      await new Reducer(repo).run('p1');
    };
    const racingRepo: ReducerRepo = {
      getSnapshot: async (p) => {
        const s = await repo.getSnapshot(p);
        await inject();
        return s;
      },
      findEventsByPatient: async (p) => {
        const e = await repo.findEventsByPatient(p);
        await inject();
        return e;
      },
      saveSnapshot: (p, v, patch) => repo.saveSnapshot(p, v, patch),
      markFolded: (ids) => repo.markFolded(ids),
    };

    await new Reducer(racingRepo).run('p1');

    const snap = await snapshot();
    expect(snap?.state.appliedCount).toBe(2); // never regressed to 1
    expect(await foldedIds()).toEqual(['a', 'b']);
  });
});

import { Db } from 'mongodb';
import { closeMongo, getMongo, resetRecords } from '../../test/mongo';
import { MongoService } from '../database/mongo.service';
import { Clock } from '../domain/ports';
import { RECORDS_COLLECTION } from '../records/record.types';
import { RecordsRepository } from '../records/records.repository';
import { StatsService } from './stats.service';

const at = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec));

class FixedClock implements Clock {
  constructor(private readonly t: Date) {}
  now(): Date {
    return this.t;
  }
}

describe('StatsService gauge', () => {
  let db: Db;
  let repo: RecordsRepository;

  const insertEvent = (eventId: string, status: string, folded: boolean, receivedSec: number) =>
    db.collection(RECORDS_COLLECTION).insertOne({
      kind: 'event',
      eventId,
      patientId: 'p1',
      type: 't',
      data: {},
      ts: at(receivedSec),
      receivedAt: at(receivedSec),
      status,
      folded,
      attempts: 0,
      ...(status === 'ready' ? { effect: {} } : {}),
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

  it('counts a ready-but-unfolded event as unsettled: a stalled second stage shows a growing age', async () => {
    await insertEvent('e1', 'ready', false, 10); // committed but not folded (reducer stalled/crashed)
    const stats = new StatsService(repo, new FixedClock(at(100)));

    await stats.refresh();

    const gauge = stats.get();
    expect(gauge.counts.ready).toBe(1);
    expect(gauge.oldestUnresolvedAgeMs).toBe(90_000); // 100s - 10s, not hidden as "resolved"
  });

  it('a fully folded ready event is settled: it does not inflate the backlog age', async () => {
    await insertEvent('e1', 'ready', true, 10); // folded = applied to the snapshot
    const stats = new StatsService(repo, new FixedClock(at(100)));

    await stats.refresh();

    expect(stats.get().oldestUnresolvedAgeMs).toBe(0);
  });
});

import { Db, MongoServerError } from 'mongodb';
import { closeMongo, getMongo, resetRecords } from '../../test/mongo';
import { RECORDS_COLLECTION } from './record.types';

describe('ensureIndexes (C10)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await getMongo();
  });

  beforeEach(async () => {
    await resetRecords();
  });

  afterAll(async () => {
    await closeMongo();
  });

  it('creates every named index', async () => {
    const names = (await db.collection(RECORDS_COLLECTION).indexes()).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'uniq_event_id',
        'uniq_snapshot_patient',
        'queued_fifo',
        'processing_lease',
        'patient_order',
        'ready_orphan',
      ]),
    );
  });

  it('rejects a duplicate eventId with E11000 (the dedup is the index, not app code)', async () => {
    const records = db.collection(RECORDS_COLLECTION);
    const doc = { kind: 'event', eventId: 'hash-1', patientId: 'p1', status: 'queued' };
    await records.insertOne({ ...doc });

    const err = await records.insertOne({ ...doc }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MongoServerError);
    expect((err as MongoServerError).code).toBe(11000);
  });

  it('allows the same eventId value on a non-event document (partial filter is scoped)', async () => {
    const records = db.collection(RECORDS_COLLECTION);
    await records.insertOne({ kind: 'event', eventId: 'hash-2', patientId: 'p1' });
    // a snapshot is outside the unique-event partial filter, so this must not collide
    await expect(
      records.insertOne({ kind: 'snapshot', eventId: 'hash-2', patientId: 'p2' }),
    ).resolves.toBeDefined();
  });

  it('rejects a second snapshot for the same patient', async () => {
    const records = db.collection(RECORDS_COLLECTION);
    await records.insertOne({ kind: 'snapshot', patientId: 'p1' });

    const err = await records
      .insertOne({ kind: 'snapshot', patientId: 'p1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MongoServerError);
    expect((err as MongoServerError).code).toBe(11000);
  });
});

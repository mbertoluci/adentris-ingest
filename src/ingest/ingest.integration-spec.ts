import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Db, MongoNetworkError, MongoServerError } from 'mongodb';
import request from 'supertest';
import { closeMongo, getMongo, resetRecords } from '../../test/mongo';
import { configureApp } from '../app-setup';
import { CommonModule } from '../common/common.module';
import { IndexConflict, PersistenceUnavailable } from '../common/errors/app-exception';
import { DatabaseModule } from '../database/database.module';
import { MongoService } from '../database/mongo.service';
import { EventDoc, RECORDS_COLLECTION } from '../records/record.types';
import { RecordsModule } from '../records/records.module';
import { RecordsRepository } from '../records/records.repository';
import { IngestModule } from './ingest.module';

describe('POST /events (C6/C7/C12/C13)', () => {
  let app: INestApplication;
  let db: Db;

  const valid = () => ({
    patientId: 'p1',
    type: 'observation',
    ts: '2026-01-01T00:00:00.000Z',
    data: { heartRate: 80 },
  });

  const eventCount = () =>
    db.collection(RECORDS_COLLECTION).countDocuments({ kind: 'event' });

  beforeAll(async () => {
    db = await getMongo();
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule, DatabaseModule, RecordsModule, IngestModule],
    })
      // the app only ever uses MongoService.db, so the tests hand it the raw Db of the
      // in-memory server and never the lifecycle/connection the real service owns
      .overrideProvider(MongoService)
      .useValue({ db } as unknown as MongoService)
      .compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await resetRecords();
  });

  afterAll(async () => {
    await app.close();
    await closeMongo();
  });

  it('persists a valid event and answers 202 queued', async () => {
    const res = await request(app.getHttpServer()).post('/events').send(valid());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ eventId: expect.any(String), status: 'queued' });
    expect(await eventCount()).toBe(1);
  });

  it('deduplicates an identical resend: 202 again, still one event (C6)', async () => {
    const first = await request(app.getHttpServer()).post('/events').send(valid());
    const second = await request(app.getHttpServer()).post('/events').send(valid());
    expect(second.status).toBe(202);
    expect(second.body.eventId).toBe(first.body.eventId);
    expect(second.body.status).toBe('queued');
    expect(await eventCount()).toBe(1);
  });

  it('a dedup hit returns the REAL persisted status, not a hardcoded queued (C6)', async () => {
    const first = await request(app.getHttpServer()).post('/events').send(valid());
    // force the stored event to failed, then resend the same body
    await db
      .collection(RECORDS_COLLECTION)
      .updateOne({ eventId: first.body.eventId }, { $set: { status: 'failed' } });

    const again = await request(app.getHttpServer()).post('/events').send(valid());
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('failed'); // honest: does not claim a failed event is queued
  });

  it('an Idempotency-Key dedups across a mutated body (occurrence identity)', async () => {
    // same key, same patient, but the sender regenerated ts and nudged the data on retry: with a
    // content hash these would be two events; the key makes them one (never counted twice).
    const first = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'op-123')
      .send(valid());
    const retry = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'op-123')
      .send({ ...valid(), ts: '2026-01-01T00:00:05.000Z', data: { heartRate: 81 } });

    expect(retry.status).toBe(202);
    expect(retry.body.eventId).toBe(first.body.eventId);
    expect(await eventCount()).toBe(1);
  });

  it('distinct Idempotency-Keys keep identical bodies as separate events', async () => {
    // two genuinely distinct observations that happen to carry the same payload: a content hash
    // would collapse them (lost event); distinct keys keep them apart.
    const a = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'op-A')
      .send(valid());
    const b = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'op-B')
      .send(valid());

    expect(a.body.eventId).not.toBe(b.body.eventId);
    expect(await eventCount()).toBe(2);
  });

  it('rejects an over-long Idempotency-Key with 400, never stores it', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'x'.repeat(201))
      .send(valid());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(await eventCount()).toBe(0);
  });

  it('still enforces the C13 input guard WITH an Idempotency-Key (no validation bypass)', async () => {
    // the occurrence-id path does not hash data, so the hostile-input walk must run independently:
    // a $-prefixed key must be rejected whether or not a key is present.
    const res = await request(app.getHttpServer())
      .post('/events')
      .set('Idempotency-Key', 'op-hostile')
      .send({ ...valid(), data: { $gt: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(await eventCount()).toBe(0);
  });

  it('treats a patientId differing only by Unicode form as the same patient (NFC)', async () => {
    // "José" composed (NFC) vs "Jose" + combining acute (NFD): same identity after NFC, so the
    // dedup key and the stored/grouped patientId must agree - one event, stored in NFC form.
    const composed = { ...valid(), patientId: 'José' };
    const decomposed = { ...valid(), patientId: 'José' };
    const first = await request(app.getHttpServer()).post('/events').send(composed);
    const second = await request(app.getHttpServer()).post('/events').send(decomposed);
    expect(second.body.eventId).toBe(first.body.eventId);
    expect(await eventCount()).toBe(1);
    const stored = await db
      .collection(RECORDS_COLLECTION)
      .findOne<EventDoc>({ kind: 'event' });
    expect(stored?.patientId).toBe('José');
  });

  it('rejects a body over the limit with 413, never 500', async () => {
    const big = { ...valid(), data: { blob: 'x'.repeat(1_200_000) } };
    const res = await request(app.getHttpServer()).post('/events').send(big);
    expect(res.status).toBe(413);
    expect(await eventCount()).toBe(0);
  });

  it('rejects a missing field with 400 validation_failed', async () => {
    const { patientId: _omit, ...body } = valid();
    const res = await request(app.getHttpServer()).post('/events').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(await eventCount()).toBe(0);
  });

  it('rejects an unknown field (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ ...valid(), injected: true });
    expect(res.status).toBe(400);
  });

  it('rejects hostile data with a $-prefixed key (C13)', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ ...valid(), data: { $gt: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(await eventCount()).toBe(0);
  });

  it('rejects data that is an array, not a plain object (C13)', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ ...valid(), data: [1, 2, 3] });
    expect(res.status).toBe(400);
  });

  it('rejects a ts far in the future (C12)', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ ...valid(), ts: '2999-01-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('RecordsRepository.insertEvent error translation (C6/C7)', () => {
  const doc: EventDoc = {
    kind: 'event',
    eventId: 'h1',
    patientId: 'p1',
    type: 't',
    data: {},
    ts: new Date('2026-01-01T00:00:00.000Z'),
    receivedAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'queued',
    folded: false,
    attempts: 0,
  };

  const repoWith = (
    insertOne: () => Promise<unknown>,
    findOne: () => Promise<unknown> = () => Promise.resolve(null),
  ): RecordsRepository => {
    const collection = { insertOne, findOne };
    const mongo = { db: { collection: () => collection } } as unknown as MongoService;
    return new RecordsRepository(mongo);
  };

  const dupKey = (keyPattern: Record<string, number>): MongoServerError => {
    const error = new MongoServerError({ message: 'E11000 duplicate key' });
    (error as { code?: number }).code = 11000;
    (error as { keyPattern?: Record<string, number> }).keyPattern = keyPattern;
    return error;
  };

  it('translates a network error to PersistenceUnavailable (503), never a silent accept', async () => {
    const repo = repoWith(() => Promise.reject(new MongoNetworkError('down')));
    await expect(repo.insertEvent(doc)).rejects.toBeInstanceOf(PersistenceUnavailable);
  });

  it('translates an E11000 on a non-eventId index to IndexConflict (500)', async () => {
    const repo = repoWith(() => Promise.reject(dupKey({ patientId: 1 })));
    await expect(repo.insertEvent(doc)).rejects.toBeInstanceOf(IndexConflict);
  });

  it('treats an eventId E11000 whose document vanished as IndexConflict, not an invented status', async () => {
    const repo = repoWith(() => Promise.reject(dupKey({ eventId: 1 })), () => Promise.resolve(null));
    await expect(repo.insertEvent(doc)).rejects.toBeInstanceOf(IndexConflict);
  });
});

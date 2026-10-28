import { Db } from 'mongodb';
import { RECORDS_COLLECTION } from './record.types';

/**
 * The indexes are a correctness invariant, not an optimization: the unique partial index is
 * the dedup itself, and a partial index in the wrong namespace would turn an E11000 into
 * silent loss. Created at boot before the service listens (C10/C16), and by the same call the
 * tests use - so a test never runs without them. Partial where cardinality must track the
 * backlog (not history), full where the refold needs the whole history.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(RECORDS_COLLECTION).createIndexes([
    // dedup: one event per content hash
    {
      key: { eventId: 1 },
      name: 'uniq_event_id',
      unique: true,
      partialFilterExpression: { kind: 'event' },
    },
    // one snapshot per patient
    {
      key: { patientId: 1 },
      name: 'uniq_snapshot_patient',
      unique: true,
      partialFilterExpression: { kind: 'snapshot' },
    },
    // FIFO claim over the queued backlog; cardinality = backlog, not history
    {
      key: { receivedAt: 1 },
      name: 'queued_fifo',
      partialFilterExpression: { kind: 'event', status: 'queued' },
    },
    // reaper sweep of expired leases; cardinality ~ worker pool
    {
      key: { leaseUntil: 1 },
      name: 'processing_lease',
      partialFilterExpression: { kind: 'event', status: 'processing' },
    },
    // ordered refold per patient; NOT partial - the refold needs the whole history
    {
      key: { patientId: 1, ts: 1, eventId: 1 },
      name: 'patient_order',
    },
    // orphan ready discovery (crash between stages); not a scan of already-folded history
    {
      key: { patientId: 1, status: 1, folded: 1 },
      name: 'ready_orphan',
      partialFilterExpression: { kind: 'event', status: 'ready', folded: false },
    },
    // failed-event discovery for the blocked sweep; cardinality = failed events, not history
    {
      key: { patientId: 1 },
      name: 'failed_patients',
      partialFilterExpression: { kind: 'event', status: 'failed' },
    },
  ]);
}

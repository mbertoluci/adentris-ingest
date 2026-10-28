import { PatientState } from '../domain/fold';
import { Cursor } from '../domain/reduce';

export const RECORDS_COLLECTION = 'records';

export type EventStatus = 'queued' | 'processing' | 'ready' | 'failed';

/**
 * A unit of work. The fields that feed the dedup hash (patientId, type, ts, data) are immutable,
 * and so are eventId (the hash) and receivedAt; the rest is operational and only moves through
 * the repository's named commands.
 */
export interface EventDoc {
  kind: 'event';
  eventId: string;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
  receivedAt: Date;
  status: EventStatus;
  folded: boolean;
  attempts: number;
  leaseUntil?: Date;
  fence?: string;
  effect?: Record<string, unknown>;
}

/** One per patient. `state` is the fold of the contiguous ready prefix. */
export interface SnapshotDoc {
  kind: 'snapshot';
  patientId: string;
  state: PatientState;
  /** Optimistic lock; bumped only when state/appliedThrough/blocked change (C3). */
  version: number;
  /** The last event folded into state; the basis of no-regress (C4). */
  appliedThrough: Cursor | null;
  /** True only when the gap blocking further progress is a failed event (C4). */
  blocked: boolean;
}

export type RecordDoc = EventDoc | SnapshotDoc;

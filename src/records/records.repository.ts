import { Injectable } from '@nestjs/common';
import {
  Collection,
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
} from 'mongodb';
import { IndexConflict, PersistenceUnavailable } from '../common/errors/app-exception';
import { MongoService } from '../database/mongo.service';
import {
  EventDoc,
  EventStatus,
  RECORDS_COLLECTION,
  RecordDoc,
  SnapshotDoc,
} from './record.types';

export interface InsertOutcome {
  /** The persisted status (queued for a new event, or the existing status on a dedup hit). */
  status: EventStatus;
}

/**
 * The single owner of the `records` collection. Its methods are the atomic protocol named by
 * the guards; Mongo specifics (E11000, matchedCount, $set) are translated here and never leak
 * up as driver types.
 */
@Injectable()
export class RecordsRepository {
  constructor(private readonly mongo: MongoService) {}

  private get col(): Collection<RecordDoc> {
    return this.mongo.db.collection<RecordDoc>(RECORDS_COLLECTION);
  }

  /**
   * Atomically claim the oldest queued event (FIFO via the queued partial index): flip it to
   * processing and stamp a fresh fence and a lease. It does NOT count an attempt - the attempts
   * budget tracks external-processing failures (recordExternalFailure), not claims, so a crash or
   * an unavailable commit (infra) never burns it (C14). Only queued events are ever scanned;
   * requeueing processing->queued is the reaper's exclusive job.
   */
  async claimNext(now: Date, leaseMs: number, fence: string): Promise<EventDoc | null> {
    const claimed = await this.col.findOneAndUpdate(
      { kind: 'event', status: 'queued' },
      { $set: { status: 'processing', fence, leaseUntil: new Date(now.getTime() + leaseMs) } },
      { sort: { receivedAt: 1 }, returnDocument: 'after' },
    );
    return (claimed as EventDoc | null) ?? null;
  }

  /**
   * The external call failed (the work itself, not infra): count it against the attempts budget
   * (C14) and expire the lease so the reaper requeues it promptly. Fenced, so a zombie cannot
   * burn the budget of an event that was already reclaimed.
   */
  async recordExternalFailure(eventId: string, fence: string, now: Date): Promise<void> {
    await this.col.updateOne(
      { kind: 'event', eventId, status: 'processing', fence },
      { $inc: { attempts: 1 }, $set: { leaseUntil: now } },
    );
  }

  /**
   * Commit the stage-1 result under the fence (C2): the update only lands if the event is still
   * processing with this exact fence, so a zombie worker whose lease was reclaimed cannot
   * resurrect or overwrite it. Returns whether this worker won the commit.
   */
  async commitReady(
    eventId: string,
    fence: string,
    effect: Record<string, unknown>,
  ): Promise<boolean> {
    const res = await this.col.updateOne(
      { kind: 'event', eventId, status: 'processing', fence },
      { $set: { status: 'ready', effect }, $unset: { leaseUntil: '', fence: '' } },
    );
    return res.matchedCount === 1;
  }

  /** All of a patient's events in fold order (ts, eventId); the reducer needs to see the gap. */
  async findEventsByPatient(patientId: string): Promise<EventDoc[]> {
    return this.col
      .find({ kind: 'event', patientId })
      .sort({ ts: 1, eventId: 1 })
      .toArray() as Promise<EventDoc[]>;
  }

  async getSnapshot(patientId: string): Promise<SnapshotDoc | null> {
    return this.col.findOne({ kind: 'snapshot', patientId }) as Promise<SnapshotDoc | null>;
  }

  /**
   * Publish the snapshot only if its version is still the one the reducer read (C3): a slower
   * reducer that computed from an older read cannot write over a newer state (last-write-wins).
   * expectedVersion 0 means "no snapshot yet": insert it, treating a lost creation race as a
   * failed predicate. Returns whether this write won.
   */
  async saveSnapshot(
    patientId: string,
    expectedVersion: number,
    patch: Pick<SnapshotDoc, 'state' | 'appliedThrough' | 'blocked'>,
  ): Promise<boolean> {
    if (expectedVersion === 0) {
      try {
        await this.col.insertOne({ kind: 'snapshot', patientId, version: 1, ...patch });
        return true;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 11000) {
          return false;
        }
        throw error;
      }
    }
    const res = await this.col.updateOne(
      { kind: 'snapshot', patientId, version: expectedVersion },
      { $set: patch, $inc: { version: 1 } },
    );
    return res.matchedCount === 1;
  }

  /**
   * Reaper sweep (a): requeue events whose lease expired, or park them as failed once the
   * attempts budget is spent (C14). Each update is predicated on the exact fence the reaper read;
   * a worker that re-leased in the meantime holds a different fence (a reclaim goes through
   * queued), so it is never clobbered. Requeueing processing->queued is the reaper's exclusive
   * job, which keeps the claim off this namespace.
   */
  async requeueExpired(
    now: Date,
    maxAttempts: number,
  ): Promise<{ requeued: number; failed: number }> {
    const expired = (await this.col
      .find({ kind: 'event', status: 'processing', leaseUntil: { $lte: now } })
      .toArray()) as EventDoc[];

    let requeued = 0;
    let failed = 0;
    for (const event of expired) {
      const predicate = {
        kind: 'event' as const,
        eventId: event.eventId,
        status: 'processing' as const,
        fence: event.fence,
      };
      if (event.attempts >= maxAttempts) {
        const res = await this.col.updateOne(predicate, {
          $set: { status: 'failed', lastError: 'max attempts exceeded' },
          $unset: { fence: '', leaseUntil: '' },
        });
        failed += res.modifiedCount;
      } else {
        const res = await this.col.updateOne(predicate, {
          $set: { status: 'queued' },
          $unset: { fence: '', leaseUntil: '' },
        });
        requeued += res.modifiedCount;
      }
    }
    return { requeued, failed };
  }

  /** Event counts per status, for the /stats gauge. */
  async countsByStatus(): Promise<Record<EventStatus, number>> {
    const rows = (await this.col
      .aggregate([{ $match: { kind: 'event' } }, { $group: { _id: '$status', n: { $sum: 1 } } }])
      .toArray()) as Array<{ _id: EventStatus; n: number }>;
    const counts: Record<EventStatus, number> = { queued: 0, processing: 0, ready: 0, failed: 0 };
    for (const row of rows) {
      counts[row._id] = row.n;
    }
    return counts;
  }

  /** receivedAt of the oldest unresolved (queued or processing) event, or null if none. */
  async oldestUnresolvedReceivedAt(): Promise<Date | null> {
    const doc = await this.col
      .find({ kind: 'event', status: { $in: ['queued', 'processing'] } })
      .sort({ receivedAt: 1 })
      .limit(1)
      .next();
    return (doc as EventDoc | null)?.receivedAt ?? null;
  }

  /** Reaper sweep (b): patients with a ready event not yet folded (crash between stages, C5). */
  async findOrphanReadyPatients(): Promise<string[]> {
    return this.col.distinct('patientId', {
      kind: 'event',
      status: 'ready',
      folded: false,
    }) as Promise<string[]>;
  }

  /**
   * Reaper sweep (c): patients with a failed event. The reducer sets a snapshot `blocked` only
   * when the gap is a failed event (C4); a failed event raises no ready orphan, so without this
   * sweep a retroactive failed gap would never flip blocked. The reduce is idempotent, so
   * re-feeding an already-correct patient is a cheap no-op.
   */
  async findPatientsWithFailed(): Promise<string[]> {
    return this.col.distinct('patientId', {
      kind: 'event',
      status: 'failed',
    }) as Promise<string[]>;
  }

  /** Mark the folded prefix (ready events only) as folded; idempotent, clears the orphan (C5). */
  async markFolded(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    await this.col.updateMany(
      { kind: 'event', status: 'ready', eventId: { $in: eventIds } },
      { $set: { folded: true } },
    );
  }

  /**
   * Insert an event, or report the existing one on a dedup hit (C6). A duplicate eventId is a
   * dedup hit and the caller still answers 202 with the real persisted status; any other unique
   * conflict is a bug (500), never swallowed. A network/timeout is 503 (unknown, retry the body).
   */
  async insertEvent(doc: EventDoc): Promise<InsertOutcome> {
    try {
      await this.col.insertOne(doc);
      return { status: doc.status };
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        if (error.keyPattern && 'eventId' in error.keyPattern) {
          const existing = (await this.col.findOne({
            kind: 'event',
            eventId: doc.eventId,
          })) as EventDoc | null;
          if (existing) {
            return { status: existing.status };
          }
          // the unique index saw a duplicate but the document is gone: a real conflict, never a
          // dedup hit answered with an invented status
          throw new IndexConflict();
        }
        throw new IndexConflict();
      }
      if (
        error instanceof MongoNetworkError ||
        error instanceof MongoServerSelectionError
      ) {
        throw new PersistenceUnavailable();
      }
      throw error;
    }
  }
}

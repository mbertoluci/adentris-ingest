import { Injectable } from '@nestjs/common';
import {
  Collection,
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
} from 'mongodb';
import { IndexConflict, PersistenceUnavailable } from '../common/errors/app-exception';
import { MongoService } from '../database/mongo.service';
import { Cursor } from '../domain/reduce';
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
          $set: { status: 'failed' },
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

  /**
   * receivedAt of the oldest UNSETTLED event, or null if none. Unsettled is not just queued or
   * processing: a `ready` event that is not yet `folded` is accepted work that has not reached the
   * snapshot (a stalled or crashed reducer, the orphan of C5), so it must count toward the backlog
   * age. Excluding it would let a stuck second stage report a healthy gauge while work piles up.
   */
  async oldestUnsettledReceivedAt(): Promise<Date | null> {
    const doc = await this.col
      .find({
        kind: 'event',
        $or: [
          { status: { $in: ['queued', 'processing'] } },
          { status: 'ready', folded: false },
        ],
      })
      .sort({ receivedAt: 1 })
      .limit(1)
      .next();
    return (doc as EventDoc | null)?.receivedAt ?? null;
  }

  /**
   * Reaper sweep (b): patients with a genuine ready orphan - a ready event not yet folded that sits
   * WITHIN the already-published prefix (the C5 crash between the snapshot write and markFolded).
   *
   * A ready event stranded strictly AFTER a failed gap is also `ready & folded:false`, but it cannot
   * fold until the gap is requeued (which re-triggers reduction through the worker), so re-folding
   * its patient every tick would be wasted O(history) work forever. We exclude those: for a blocked
   * patient we keep it only if it still has an unfolded ready event at or before the snapshot cursor
   * (a real crash orphan). A non-blocked patient is always a candidate (a new ready event extending
   * the prefix, or a crash orphan). Blocked patients are rare, so the per-patient check is bounded.
   */
  async findOrphanReadyPatients(): Promise<string[]> {
    const patients = (await this.col.distinct('patientId', {
      kind: 'event',
      status: 'ready',
      folded: false,
    })) as string[];
    if (patients.length === 0) {
      return [];
    }
    const blocked = (await this.col
      .find({ kind: 'snapshot', patientId: { $in: patients }, blocked: true })
      .project({ patientId: 1, appliedThrough: 1 })
      .toArray()) as Array<{ patientId: string; appliedThrough: Cursor | null }>;
    if (blocked.length === 0) {
      return patients;
    }
    const cursorByPatient = new Map(blocked.map((s) => [s.patientId, s.appliedThrough]));

    const kept: string[] = [];
    for (const patientId of patients) {
      if (!cursorByPatient.has(patientId)) {
        kept.push(patientId); // not blocked: always a candidate
        continue;
      }
      const cursor = cursorByPatient.get(patientId) ?? null;

      // The `blocked` flag can be stale: if the gap was cleared (e.g. a manual unlock requeued the
      // failed event and it committed ready, then the process died before reduction), the first
      // event after the cursor is now ready and the prefix can EXTEND. We must re-fold in that case,
      // or that clinical event is stranded forever with no new traffic. So keep the patient when the
      // next event past the cursor is ready, regardless of what `blocked` still says.
      const afterCursor =
        cursor === null
          ? {}
          : { $or: [{ ts: { $gt: cursor.ts } }, { ts: cursor.ts, eventId: { $gt: cursor.eventId } }] };
      const next = (await this.col
        .find({ kind: 'event', patientId, ...afterCursor })
        .sort({ ts: 1, eventId: 1 })
        .limit(1)
        .next()) as EventDoc | null;
      if (next?.status === 'ready') {
        kept.push(patientId); // the prefix can extend; a stale block will be cleared by the refold
        continue;
      }

      // The head past the cursor is still a non-ready gap, so ready events beyond it are genuinely
      // stranded. Only a crash orphan WITHIN the published prefix (ready & unfolded at or before the
      // cursor) still needs reconciling.
      if (cursor !== null) {
        const inPrefixOrphan = await this.col.countDocuments({
          kind: 'event',
          patientId,
          status: 'ready',
          folded: false,
          $or: [{ ts: { $lt: cursor.ts } }, { ts: cursor.ts, eventId: { $lte: cursor.eventId } }],
        });
        if (inPrefixOrphan > 0) {
          kept.push(patientId);
        }
      }
    }
    return kept;
  }

  /**
   * Reaper sweep (c): patients whose snapshot still needs to be flipped `blocked`. A failed event
   * raises no ready orphan, so without this sweep a retroactive failed gap (C4) would never block.
   * But re-reducing a patient is an O(history) refold, so we must not do it every tick forever: a
   * patient whose snapshot is ALREADY blocked is in its stable state and is dropped from the sweep
   * (it re-enters only when a new ready event arrives, which the worker's own trigger and the
   * orphan sweep already handle). The failed set is indexed (failed_patients) and bounded by the
   * number of failed events, not the history. Two bounded reads instead of a per-tick full refold.
   */
  async findFailedPatientsNeedingBlock(): Promise<string[]> {
    const failed = (await this.col.distinct('patientId', {
      kind: 'event',
      status: 'failed',
    })) as string[];
    if (failed.length === 0) {
      return [];
    }
    const alreadyBlocked = (await this.col
      .find({ kind: 'snapshot', patientId: { $in: failed }, blocked: true })
      .project({ patientId: 1 })
      .toArray()) as Array<{ patientId: string }>;
    const blocked = new Set(alreadyBlocked.map((s) => s.patientId));
    return failed.filter((patientId) => !blocked.has(patientId));
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

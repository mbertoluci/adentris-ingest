import { cursorEq, planReduction, ReduceEvent } from '../domain/reduce';
import { EventDoc, SnapshotDoc } from '../records/record.types';

/** The slice of the repository the reducer drives - the fold half of the protocol. */
export interface ReducerRepo {
  findEventsByPatient(patientId: string): Promise<EventDoc[]>;
  getSnapshot(patientId: string): Promise<SnapshotDoc | null>;
  saveSnapshot(
    patientId: string,
    expectedVersion: number,
    patch: Pick<SnapshotDoc, 'state' | 'appliedThrough' | 'blocked'>,
  ): Promise<boolean>;
  markFolded(eventIds: string[]): Promise<void>;
}

function toReduceEvent(e: EventDoc): ReduceEvent {
  return {
    eventId: e.eventId,
    type: e.type,
    ts: e.ts,
    isReady: e.status === 'ready',
    isFailed: e.status === 'failed',
    effect: e.effect,
  };
}

/**
 * Stage 2. Plain class so it is tested directly. Loads a patient's events in order, folds the
 * contiguous ready prefix (pure planReduction + fold), and publishes the snapshot under the
 * version predicate (C3). When it does publish, it marks the folded prefix even if the state was
 * unchanged, so a crash between the snapshot write and the mark (the orphan, C5) is reconciled on
 * the next run. When it keeps the state (a retroactive gap, or nothing ready), it marks nothing.
 */
export class Reducer {
  constructor(private readonly repo: ReducerRepo) {}

  async run(patientId: string): Promise<void> {
    // Read the snapshot (and its version) BEFORE the events, so the version we later CAS on is
    // never newer than the events we fold. If a concurrent reducer advances the snapshot between
    // these two reads, our saveSnapshot CAS fails and we abandon - the winner's state stands, and
    // any event it left unfolded is recovered by the orphan sweep (C3/C5).
    const snap = await this.repo.getSnapshot(patientId);
    const events = await this.repo.findEventsByPatient(patientId);
    const plan = planReduction(events.map(toReduceEvent), {
      appliedThrough: snap?.appliedThrough ?? null,
    });

    // A retroactive gap behind the cursor, or nothing ready yet: keep any published state.
    if (plan.regress || plan.appliedThrough === null) {
      if (snap) {
        // only the blocked flag may need to move on the existing snapshot (C4)
        if (snap.blocked !== plan.blocked) {
          await this.repo.saveSnapshot(patientId, snap.version, {
            state: snap.state,
            appliedThrough: snap.appliedThrough,
            blocked: plan.blocked,
          });
        }
      } else if (plan.blocked) {
        // No snapshot yet and the head of the history is a failed event: the patient's very first
        // event failed. Create a blocked snapshot so the block is VISIBLE, not silently absent -
        // otherwise /stats and any consumer would see nothing at all for a patient that is stuck.
        await this.repo.saveSnapshot(patientId, 0, {
          state: plan.state,
          appliedThrough: null,
          blocked: true,
        });
      }
      return;
    }

    // The fold output is JSON with deterministic key order, so a string compare is a stable way
    // to tell whether the state actually changed (and thus whether to bump the version).
    const changed =
      !snap ||
      !cursorEq(plan.appliedThrough, snap.appliedThrough) ||
      snap.blocked !== plan.blocked ||
      JSON.stringify(plan.state) !== JSON.stringify(snap.state);

    if (changed) {
      const won = await this.repo.saveSnapshot(patientId, snap?.version ?? 0, {
        state: plan.state,
        appliedThrough: plan.appliedThrough,
        blocked: plan.blocked,
      });
      if (!won) {
        // lost the version race; a re-trigger (worker or orphan reaper) reconciles
        return;
      }
    }

    await this.repo.markFolded(plan.foldedEventIds);
  }
}

import { fold, PatientState } from './fold';

export interface Cursor {
  ts: Date;
  eventId: string;
}

/** An event as the reducer sees it: its order key, whether it is ready/failed, and its effect. */
export interface ReduceEvent {
  eventId: string;
  type: string;
  ts: Date;
  isReady: boolean;
  isFailed: boolean;
  effect?: Record<string, unknown>;
}

export interface ReductionPlan {
  state: PatientState;
  appliedThrough: Cursor | null;
  /** Ids of the ready prefix - marked folded once published (clears the orphan, C5). */
  foldedEventIds: string[];
  /** True only if the gap is a failed event (C4); a transient gap does not block. */
  blocked: boolean;
  /** True if publishing would move the cursor backwards: keep the current state (C4). */
  regress: boolean;
}

export function cursorLt(a: Cursor, b: Cursor): boolean {
  const at = a.ts.getTime();
  const bt = b.ts.getTime();
  return at < bt || (at === bt && a.eventId < b.eventId);
}

export function cursorEq(a: Cursor | null, b: Cursor | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.ts.getTime() === b.ts.getTime() && a.eventId === b.eventId;
}

/**
 * The correctness core (F3). Events arrive ordered by (ts, eventId). We fold the contiguous
 * ready prefix and stop at the first non-ready event (the gap). A full refold means a late event
 * that slots in behind and becomes ready is picked up automatically (C1). We never publish a
 * prefix that moves the cursor backwards - a retroactive gap must not erase a published state
 * (C4) - and we only mark the patient blocked when the gap is a failed event, not a transient one.
 *
 * Named "plan", not "reduce": it does not accumulate (that is fold's job) - it decides which
 * contiguous ready prefix to fold and whether publishing it is safe.
 */
export function planReduction(
  events: ReadonlyArray<ReduceEvent>,
  current: { appliedThrough: Cursor | null },
): ReductionPlan {
  const prefix: ReduceEvent[] = [];
  let gap: ReduceEvent | undefined;
  for (const event of events) {
    if (event.isReady) {
      prefix.push(event);
    } else {
      gap = event;
      break;
    }
  }

  const last = prefix[prefix.length - 1];
  const appliedThrough: Cursor | null = last ? { ts: last.ts, eventId: last.eventId } : null;
  const blocked = gap?.isFailed ?? false;
  const regress =
    current.appliedThrough !== null &&
    (appliedThrough === null || cursorLt(appliedThrough, current.appliedThrough));

  const state = fold(prefix.map((e) => ({ type: e.type, effect: e.effect ?? {} })));

  return { state, appliedThrough, foldedEventIds: prefix.map((e) => e.eventId), blocked, regress };
}

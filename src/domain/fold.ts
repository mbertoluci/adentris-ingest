export interface FoldEvent {
  type: string;
  effect: Record<string, unknown>;
}

export interface PatientState {
  appliedCount: number;
  lastType: string | null;
  values: Record<string, unknown>;
}

export const EMPTY_STATE: PatientState = { appliedCount: 0, lastType: null, values: {} };

/**
 * Pure reduction of an ordered event sequence into patient state. The real clinical logic is
 * out of scope for this exercise; this is a deliberately simple, order-sensitive accumulation
 * (a later effect overwrites an earlier key) that makes ordering observable and keeps the fold
 * trivial to test and to swap. Callers pass events already ordered by (ts, eventId).
 */
export function fold(events: ReadonlyArray<FoldEvent>): PatientState {
  let state = EMPTY_STATE;
  for (const event of events) {
    state = {
      appliedCount: state.appliedCount + 1,
      lastType: event.type,
      values: { ...state.values, ...event.effect },
    };
  }
  return state;
}

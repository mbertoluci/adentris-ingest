import { InvalidInputError } from '../domain/errors';

// C12: a sender's clock skew must not reorder the patient timeline or churn the queue. We bound
// ts to a sane window; a far-future or pre-epoch timestamp is a 400, not stored noise.
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const FLOOR = Date.UTC(2000, 0, 1);

/** Parse the ISO timestamp and assert it is finite and within bounds relative to now. */
export function parseEventTs(iso: string, now: Date): Date {
  const ts = new Date(iso);
  const ms = ts.getTime();
  if (!Number.isFinite(ms)) {
    throw new InvalidInputError('ts is not a valid timestamp');
  }
  if (ms > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new InvalidInputError('ts is too far in the future');
  }
  if (ms < FLOOR) {
    throw new InvalidInputError('ts is before the accepted range');
  }
  return ts;
}

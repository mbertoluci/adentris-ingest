import { createHash } from 'node:crypto';
import { canonicalJSON } from './canonical';

export interface EventIdentity {
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}

/**
 * The dedup key: sha256 over the canonical form of the hash-sealed core. `ts` as epoch ms so a
 * Date and its ISO string agree; the canonicalJSON pass also enforces C13 over `data`.
 */
export function eventId(identity: EventIdentity): string {
  const canonical = canonicalJSON({
    patientId: identity.patientId,
    type: identity.type,
    ts: identity.ts.getTime(),
    data: identity.data,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

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

/**
 * Occurrence identity from a sender-supplied Idempotency-Key, scoped to the patient. Content
 * hashing cannot tell two genuinely-identical observations apart (it collapses them) nor survive a
 * retry that regenerates `ts` (it splits them); a key fixes both because the sender declares which
 * deliveries are the same occurrence. The discriminator keeps this id space disjoint from the
 * content-hash space, and canonicalJSON applies the same NFC/C13 hardening to the inputs.
 */
export function occurrenceId(patientId: string, idempotencyKey: string): string {
  const canonical = canonicalJSON({ v: 'idk', patientId, key: idempotencyKey });
  return createHash('sha256').update(canonical).digest('hex');
}

import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../common/clock';
import { InvalidInputError } from '../domain/errors';
import { eventId, occurrenceId } from '../domain/event-id';
import { Clock } from '../domain/ports';
import { EventDoc, EventStatus } from '../records/record.types';
import { RecordsRepository } from '../records/records.repository';
import { IngestEventDto } from './dto/ingest-event.dto';
import { parseEventTs } from './ts-bounds';

export interface IngestResult {
  eventId: string;
  status: EventStatus;
}

@Injectable()
export class IngestService {
  constructor(
    private readonly repo: RecordsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Validate, derive the dedup id, and persist. The order is DTO -> plain-object + ts bounds ->
   * canonicalJSON/C13 (inside the id) -> persist. The 202 is only returned once the write is
   * durable; a duplicate returns the real persisted status (C6/C7).
   *
   * Identity: when the sender supplies an Idempotency-Key the id is derived from it (occurrence
   * identity, the sender declares which deliveries are the same event); otherwise it falls back to
   * the content hash. The key is optional and the body contract is unchanged, so this is additive.
   */
  async ingest(dto: IngestEventDto, idempotencyKey?: string): Promise<IngestResult> {
    const { data } = dto;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidInputError('data must be a plain object');
    }

    const now = this.clock.now();
    const ts = parseEventTs(dto.ts, now);
    // Canonicalize the identity strings to NFC once, here, so the value we hash is the value we
    // store and group by. canonicalJSON normalizes strings before hashing; without normalizing
    // on the way in, the dedup identity (NFC) and the stored/grouped identity (raw bytes) could
    // disagree for a patientId sent in a different Unicode form.
    const patientId = dto.patientId.normalize('NFC');
    const type = dto.type.normalize('NFC');

    // Always derive the content hash over the FULL envelope. This runs the canonicalJSON hostile-
    // input walk (C13) with the same depth/node budget no matter the identity strategy, so sending
    // an Idempotency-Key can never widen what `data` is allowed to contain (validating only
    // canonicalJSON(data) would use a slightly larger budget than the envelope walk). When a key is
    // present we use the occurrence id for identity; the envelope is validated either way.
    const contentId = eventId({ patientId, type, ts, data });
    const id = this.identify(contentId, patientId, idempotencyKey);

    const doc: EventDoc = {
      kind: 'event',
      eventId: id,
      patientId,
      type,
      data,
      ts,
      receivedAt: now,
      status: 'queued',
      folded: false,
      attempts: 0,
    };

    const outcome = await this.repo.insertEvent(doc);
    return { eventId: id, status: outcome.status };
  }

  private identify(contentId: string, patientId: string, idempotencyKey?: string): string {
    if (idempotencyKey === undefined) {
      return contentId;
    }
    const key = idempotencyKey.trim();
    if (key.length === 0 || key.length > 200) {
      throw new InvalidInputError('Idempotency-Key must be 1-200 characters');
    }
    return occurrenceId(patientId, key);
  }
}

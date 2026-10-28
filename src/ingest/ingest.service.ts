import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../common/clock';
import { InvalidInputError } from '../domain/errors';
import { eventId } from '../domain/event-id';
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
   * canonicalJSON/C13 (inside eventId) -> persist. The 202 is only returned once the write is
   * durable; a duplicate returns the real persisted status (C6/C7).
   */
  async ingest(dto: IngestEventDto): Promise<IngestResult> {
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
    const id = eventId({ patientId, type, ts, data });

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
}

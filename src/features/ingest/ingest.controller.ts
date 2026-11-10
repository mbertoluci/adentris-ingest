import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { API_ROUTES, IDEMPOTENCY_KEY_HEADER } from '../../common/api.constants';
import { IngestEventDto } from './ingest.dto';
import { IngestResult, IngestService } from './ingest.service';

@Controller(API_ROUTES.events)
export class IngestController {
  constructor(private readonly service: IngestService) {}

  // 202: accepted and durably persisted (new event or dedup hit). The body carries the real
  // status so the sender reads it instead of resending. Failures are mapped by the filter.
  // The optional Idempotency-Key header lets a sender declare occurrence identity (so a retry that
  // mutates the body still dedups, and two identical observations stay distinct); without it the
  // identity is the content hash.
  @Post()
  @HttpCode(202)
  ingest(
    @Body() dto: IngestEventDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<IngestResult> {
    return this.service.ingest(dto, idempotencyKey);
  }
}

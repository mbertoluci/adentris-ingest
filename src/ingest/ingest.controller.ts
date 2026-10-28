import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IngestEventDto } from './dto/ingest-event.dto';
import { IngestResult, IngestService } from './ingest.service';

@Controller('events')
export class IngestController {
  constructor(private readonly service: IngestService) {}

  // 202: accepted and durably persisted (new event or dedup hit). The body carries the real
  // status so the sender reads it instead of resending. Failures are mapped by the filter.
  @Post()
  @HttpCode(202)
  ingest(@Body() dto: IngestEventDto): Promise<IngestResult> {
    return this.service.ingest(dto);
  }
}

import { Controller, Get } from '@nestjs/common';
import { StatsGauge, StatsService } from './stats.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  get(): StatsGauge {
    return this.stats.get();
  }
}

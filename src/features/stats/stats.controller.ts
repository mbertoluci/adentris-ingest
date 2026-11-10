import { Controller, Get } from '@nestjs/common';
import { API_ROUTES } from '../../common/api.constants';
import { StatsGauge, StatsService } from './stats.service';

@Controller(API_ROUTES.stats)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  get(): StatsGauge {
    return this.stats.get();
  }
}

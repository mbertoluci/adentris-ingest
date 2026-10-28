import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../common/clock';
import { Clock } from '../domain/ports';
import { EventStatus } from '../records/record.types';
import { RecordsRepository } from '../records/records.repository';

export interface StatsGauge {
  startedAt: string;
  updatedAt: string | null;
  counts: Record<EventStatus, number>;
  oldestUnresolvedAgeMs: number;
}

/**
 * The few numbers that show the pipeline is draining: counts per status, the age of the oldest
 * unresolved event (the backlog signal), and when the process started (plus when the gauge was
 * last refreshed). Held in memory and refreshed on the reaper cadence; the handler just reads it,
 * so /stats never runs an aggregation on the request path.
 */
@Injectable()
export class StatsService {
  private readonly startedAt: Date;
  private gauge: StatsGauge;

  constructor(
    private readonly repo: RecordsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.startedAt = this.clock.now();
    this.gauge = {
      startedAt: this.startedAt.toISOString(),
      updatedAt: null,
      counts: { queued: 0, processing: 0, ready: 0, failed: 0 },
      oldestUnresolvedAgeMs: 0,
    };
  }

  async refresh(): Promise<void> {
    const counts = await this.repo.countsByStatus();
    const oldest = await this.repo.oldestUnresolvedReceivedAt();
    const now = this.clock.now();
    this.gauge = {
      startedAt: this.startedAt.toISOString(),
      updatedAt: now.toISOString(),
      counts,
      oldestUnresolvedAgeMs: oldest ? now.getTime() - oldest.getTime() : 0,
    };
  }

  get(): StatsGauge {
    return this.gauge;
  }
}

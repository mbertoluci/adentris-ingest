import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorText } from '../common/error-text';
import { StatsService } from '../stats/stats.service';
import { delay } from './async';
import { Reaper } from './reaper';
import { Worker } from './worker';

/**
 * Runs the worker loops. Started from main.ts after listen (not onModuleInit, so a test module
 * never leaks a running loop) and stopped cleanly on shutdown. Each loop contains its own
 * errors: one bad turn must not kill the others or the process (C16).
 */
@Injectable()
export class PipelineService implements OnApplicationShutdown {
  private readonly logger = new Logger(PipelineService.name);
  private readonly concurrency: number;
  private readonly idleMs: number;
  private readonly reaperMs: number;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    private readonly worker: Worker,
    private readonly reaper: Reaper,
    private readonly stats: StatsService,
    config: ConfigService,
  ) {
    this.concurrency = config.getOrThrow<number>('CONCURRENCY');
    this.idleMs = config.getOrThrow<number>('IDLE_MS');
    this.reaperMs = config.getOrThrow<number>('REAPER_MS');
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loops = [
      ...Array.from({ length: this.concurrency }, () => this.workerLoop()),
      this.reaperLoop(),
    ];
    this.logger.log(`pipeline started (concurrency=${this.concurrency})`);
  }

  private async workerLoop(): Promise<void> {
    while (this.running) {
      let claimed = false;
      try {
        claimed = await this.worker.processOne();
      } catch (error) {
        this.logger.error(`worker turn failed: ${errorText(error)}`);
      }
      if (!claimed) {
        await delay(this.idleMs);
      }
    }
  }

  private async reaperLoop(): Promise<void> {
    while (this.running) {
      // a dead reaper is the worst failure mode (leases never expire): contain, never crash.
      // Keep the stats refresh in its own catch so a gauge error is not misreported as a reaper
      // failure.
      try {
        await this.reaper.tick();
      } catch (error) {
        this.logger.error(`reaper tick failed: ${errorText(error)}`);
      }
      try {
        await this.stats.refresh();
      } catch (error) {
        this.logger.error(`stats refresh failed: ${errorText(error)}`);
      }
      await delay(this.reaperMs);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }
}

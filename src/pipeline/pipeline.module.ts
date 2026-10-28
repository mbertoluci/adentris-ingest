import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK } from '../common/clock';
import { Clock, ExternalProcessor } from '../domain/ports';
import { RecordsRepository } from '../records/records.repository';
import { StatsModule } from '../stats/stats.module';
import { PipelineService } from './pipeline.service';
import { Reaper } from './reaper';
import { Reducer } from './reducer';
import { EXTERNAL_PROCESSOR, SimulatedExternalProcessor } from './simulated-external';
import { Worker } from './worker';

// Worker, Reducer and Reaper are plain classes (so tests instantiate them directly with fakes);
// this module is the single place that pays the Nest wiring cost, turning config values into
// their constructor arguments.
@Module({
  imports: [StatsModule],
  providers: [
    { provide: EXTERNAL_PROCESSOR, useClass: SimulatedExternalProcessor },
    {
      provide: Reducer,
      inject: [RecordsRepository],
      useFactory: (repo: RecordsRepository) => new Reducer(repo),
    },
    {
      provide: Reaper,
      inject: [RecordsRepository, CLOCK, Reducer, ConfigService],
      useFactory: (
        repo: RecordsRepository,
        clock: Clock,
        reducer: Reducer,
        config: ConfigService,
      ) => new Reaper(repo, clock, reducer, config.getOrThrow<number>('MAX_ATTEMPTS')),
    },
    {
      provide: Worker,
      inject: [RecordsRepository, CLOCK, EXTERNAL_PROCESSOR, Reducer, ConfigService],
      useFactory: (
        repo: RecordsRepository,
        clock: Clock,
        external: ExternalProcessor,
        reducer: Reducer,
        config: ConfigService,
      ) =>
        new Worker(repo, clock, external, reducer, {
          leaseMs: config.getOrThrow<number>('LEASE_MS'),
          externalTimeoutMs: config.getOrThrow<number>('EXTERNAL_TIMEOUT_MS'),
        }),
    },
    PipelineService,
  ],
})
export class PipelineModule {}

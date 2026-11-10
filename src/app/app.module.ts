import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from '../common/common.module';
import { RecordsModule } from '../common/records/records.module';
import { loadConfig } from '../config/configuration';
import { DatabaseModule } from '../database/database.module';
import { IngestModule } from '../features/ingest/ingest.module';
import { PipelineModule } from '../features/pipeline/pipeline.module';
import { StatsModule } from '../features/stats/stats.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] }),
    CommonModule,
    DatabaseModule,
    RecordsModule,
    IngestModule,
    StatsModule,
    PipelineModule,
  ],
})
export class AppModule {}

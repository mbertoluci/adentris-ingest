import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { loadConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { IngestModule } from './ingest/ingest.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { RecordsModule } from './records/records.module';
import { StatsModule } from './stats/stats.module';

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

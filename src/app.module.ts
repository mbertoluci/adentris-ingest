import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { loadConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { RecordsModule } from './records/records.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] }),
    CommonModule,
    DatabaseModule,
    RecordsModule,
  ],
})
export class AppModule {}

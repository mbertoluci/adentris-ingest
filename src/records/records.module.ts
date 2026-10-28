import { Global, Module } from '@nestjs/common';
import { RecordsRepository } from './records.repository';

@Global()
@Module({
  providers: [RecordsRepository],
  exports: [RecordsRepository],
})
export class RecordsModule {}

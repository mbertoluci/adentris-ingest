import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';

@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class CommonModule {}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalInput, ExternalProcessor } from '../domain/ports';
import { delay } from './async';

export const EXTERNAL_PROCESSOR = Symbol('EXTERNAL_PROCESSOR');

/**
 * Stand-in for the real third-party call. It just waits the configured duration and returns a
 * stable effect; the real integration (and its own failure modes) is out of scope. Lowering
 * EXTERNAL_MS drives the chaos script without changing the production default.
 */
@Injectable()
export class SimulatedExternalProcessor implements ExternalProcessor {
  private readonly ms: number;

  constructor(config: ConfigService) {
    this.ms = config.getOrThrow<number>('EXTERNAL_MS');
  }

  async process(event: ExternalInput): Promise<Record<string, unknown>> {
    await delay(this.ms);
    return { source: 'external', type: event.type };
  }
}

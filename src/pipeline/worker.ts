import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { errorText } from '../common/error-text';
import { Clock, ExternalProcessor } from '../domain/ports';
import { EventDoc } from '../records/record.types';
import { withTimeout } from './async';

/** The slice of the repository the worker drives - the claim/commit half of the protocol. */
export interface WorkerRepo {
  claimNext(now: Date, leaseMs: number, fence: string): Promise<EventDoc | null>;
  commitReady(eventId: string, fence: string, effect: Record<string, unknown>): Promise<boolean>;
  recordExternalFailure(eventId: string, fence: string, now: Date): Promise<void>;
}

/** The reduction the worker triggers on the happy path once an event becomes ready. */
export interface ReductionTrigger {
  run(patientId: string): Promise<void>;
}

/**
 * Stage 1. Plain class (no Nest) so it is tested by direct instantiation with fakes. One turn:
 * claim a queued event under a fresh fence, run the external side-effect within a timeout, and
 * commit the result under that fence. A failed or timed-out call is abandoned - the lease
 * expires and the reaper requeues it (the attempts budget and failed status live in the reaper,
 * C14). The commit is fenced (C2): a zombie whose lease was reclaimed cannot overwrite.
 */
export class Worker {
  private readonly logger = new Logger(Worker.name);

  private readonly leaseMs: number;
  private readonly externalTimeoutMs: number;

  constructor(
    private readonly repo: WorkerRepo,
    private readonly clock: Clock,
    private readonly external: ExternalProcessor,
    private readonly reduction: ReductionTrigger,
    options: { leaseMs: number; externalTimeoutMs: number },
  ) {
    this.leaseMs = options.leaseMs;
    this.externalTimeoutMs = options.externalTimeoutMs;
  }

  /** Returns true if an event was claimed (whether or not the commit landed), false if idle. */
  async processOne(): Promise<boolean> {
    const fence = randomUUID();
    const claimed = await this.repo.claimNext(this.clock.now(), this.leaseMs, fence);
    if (!claimed) {
      return false;
    }

    let effect: Record<string, unknown>;
    try {
      effect = await withTimeout(
        this.external.process({
          eventId: claimed.eventId,
          patientId: claimed.patientId,
          type: claimed.type,
          data: claimed.data,
        }),
        this.externalTimeoutMs,
      );
    } catch (error) {
      // The work itself failed (external error/timeout): count it against the budget and release
      // the lease so the reaper requeues it promptly. This is the only path that burns an attempt
      // (C14); the reaper decides failed once the budget is spent.
      await this.repo.recordExternalFailure(claimed.eventId, fence, this.clock.now());
      this.logger.warn(
        `external processing failed for ${claimed.eventId}: ${errorText(error)}`,
      );
      return true;
    }

    try {
      const committed = await this.repo.commitReady(claimed.eventId, fence, effect);
      if (committed) {
        // The worker is the explicit owner of the happy-path reduction trigger; without it the
        // snapshot would only advance via the reaper. Contained: a reduce error must not fail the
        // worker turn (C15).
        try {
          await this.reduction.run(claimed.patientId);
        } catch (error) {
          this.logger.warn(
            `reduction trigger failed for ${claimed.patientId}: ${errorText(error)}`,
          );
        }
      }
    } catch (error) {
      // The work succeeded but the commit hit infra trouble: do NOT burn an attempt. The event
      // stays processing; its lease expires and the reaper requeues it unchanged (C14).
      this.logger.warn(`commit failed for ${claimed.eventId}: ${errorText(error)}`);
    }
    return true;
  }
}

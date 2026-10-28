import { Logger } from '@nestjs/common';
import { errorText } from '../common/error-text';
import { Clock } from '../domain/ports';
import { ReductionTrigger } from './worker';

/** The slice of the repository the reaper drives - the recovery half of the protocol. */
export interface ReaperRepo {
  requeueExpired(now: Date, maxAttempts: number): Promise<{ requeued: number; failed: number }>;
  findOrphanReadyPatients(): Promise<string[]>;
  findFailedPatientsNeedingBlock(): Promise<string[]>;
}

/**
 * The fallback that makes crashes recoverable (F5). Each tick: requeue events whose worker died
 * mid-flight (lease expired), parking them as failed once the attempts budget is spent (C14);
 * then re-trigger reduction for any patient left with a ready-but-unfolded event (the orphan of
 * a crash between the commit and the fold, C5). Plain class, invoked tick-by-tick in tests; the
 * loop contains its errors so a dead reaper never silently freezes the queue (C16).
 */
export class Reaper {
  private readonly logger = new Logger(Reaper.name);

  constructor(
    private readonly repo: ReaperRepo,
    private readonly clock: Clock,
    private readonly reduction: ReductionTrigger,
    private readonly maxAttempts: number,
  ) {}

  async tick(): Promise<{ requeued: number; failed: number; reduced: number }> {
    const { requeued, failed } = await this.repo.requeueExpired(this.clock.now(), this.maxAttempts);

    // Reduce patients left with a genuine ready orphan (crash between stages, C5) and patients whose
    // snapshot still needs to be flipped blocked by a retroactive failed gap (C4). Both sets are
    // bounded: the orphan set excludes a ready event stranded behind a failed gap (it cannot fold
    // until the gap clears, which the worker trigger handles), and the failed set drops patients
    // already blocked. So the tick never degrades into a full-history refold, tick after tick, of a
    // patient permanently blocked or stranded.
    const patients = new Set([
      ...(await this.repo.findOrphanReadyPatients()),
      ...(await this.repo.findFailedPatientsNeedingBlock()),
    ]);
    let reduced = 0;
    for (const patientId of patients) {
      try {
        await this.reduction.run(patientId);
        reduced += 1;
      } catch (error) {
        this.logger.warn(`reduction failed for ${patientId}: ${errorText(error)}`);
      }
    }
    return { requeued, failed, reduced };
  }
}

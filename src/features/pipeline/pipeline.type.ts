export interface ExternalInput {
  eventId: string;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
}

/** The ~5s third-party call of stage 1. Its result (the effect) is folded in stage 2. */
export interface ExternalProcessor {
  process(event: ExternalInput): Promise<Record<string, unknown>>;
}

export type ErrorCode =
  | 'validation_failed'
  | 'payload_too_large'
  | 'unsupported_media'
  | 'persistence_unavailable'
  | 'index_conflict'
  | 'internal';

/**
 * A domain-level failure the HTTP boundary can render without knowing the driver. The
 * repository translates Mongo into these; the filter maps them to a status and a fixed code.
 */
export class AppException extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
  ) {
    super(code);
    this.name = 'AppException';
  }
}

/** Write did not durably land (Mongo down/timeout). Transient: the sender retries the body. */
export class PersistenceUnavailable extends AppException {
  constructor() {
    super('persistence_unavailable', 503);
  }
}

/** E11000 on an index other than eventId: a permanent bug, never swallowed as a dedup hit. */
export class IndexConflict extends AppException {
  constructor() {
    super('index_conflict', 500);
  }
}

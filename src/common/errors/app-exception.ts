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
 * Concrete errors live next to the code that raises them (e.g. records.error.ts).
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

/**
 * Centralized HTTP surface constants, so routes and header names are declared once instead of
 * as string literals scattered across the controllers.
 */
export const API_ROUTES = {
  events: 'events',
  stats: 'stats',
} as const;

/** Optional header a sender uses to declare occurrence identity (see IngestService.identify). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

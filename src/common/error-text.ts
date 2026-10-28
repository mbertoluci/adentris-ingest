/**
 * A log-safe description of a caught value. A promise can reject with anything, so reading
 * `.message` off a non-Error would throw a second time (and could surface arbitrary data); this
 * narrows first and never serializes an unknown value.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'non-error value thrown';
}

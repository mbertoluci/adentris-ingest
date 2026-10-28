/**
 * Thrown by the pure domain when input is unacceptable (C12/C13). The HTTP boundary translates
 * it to a 400; the worker/reducer never let it change a unit-of-work status (C14).
 */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

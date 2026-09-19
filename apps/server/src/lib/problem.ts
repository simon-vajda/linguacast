import { logger } from './log';

const log = logger('error');

/** Mirrors the Problem schema in @linguacast/contract/schemas. */
export interface Problem {
  code: string;
  message: string;
}

/** Errors whose code and message are safe to show a client. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Maps any thrown value to the wire error shape: an AppError keeps its code, anything
 * else becomes internal_error with the original logged. Used by both transports.
 */
export function toProblem(err: unknown): Problem {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message };
  }
  // Name, message and stack only. A socket handler's state carries the event PIN, so
  // reproducing an arbitrary thrown value here would put a listening credential into the
  // log an operator is told to paste into a ticket.
  log.error(`Unhandled error: ${describeThrown(err)}`);
  return { code: 'internal_error', message: 'An unexpected error occurred.' };
}

function describeThrown(err: unknown): string {
  if (!(err instanceof Error)) {
    return `a non-Error ${typeof err} was thrown`;
  }
  return err.stack ?? `${err.name}: ${err.message}`;
}

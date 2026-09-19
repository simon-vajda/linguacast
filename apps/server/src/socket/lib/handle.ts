import type { Ack } from '@linguacast/contract/socket';
import { logger } from '../../lib/log';
import { AppError, toProblem } from '../../lib/problem';

const log = logger('socket');

/**
 * Must stay below the client's 10s ackTimeout, so a wedged handler yields a real
 * `timeout` ack rather than an unexplained client-side timeout.
 */
export const HANDLER_TIMEOUT_MS = 8_000;

function withTimeout<T>(work: Promise<T> | T, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      log.error(`Handler for "${event}" exceeded ${HANDLER_TIMEOUT_MS}ms.`);
      reject(new AppError('timeout', `Handler for "${event}" timed out.`));
    }, HANDLER_TIMEOUT_MS);

    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
      });
  });
}

/**
 * Wraps a handler into the listener shape the contract's derived event map expects.
 * `event` is passed explicitly because a listener cannot recover its own name from
 * socket.on, and without it a hung handler logs an anonymous timeout. `ack` is optional
 * so the same wrapper serves fire-and-forget events.
 */
export function handle<P, R>(event: string, fn: (payload: P) => Promise<R> | R) {
  return async (payload: P, ack?: (res: Ack<R>) => void): Promise<void> => {
    try {
      ack?.({ ok: true, data: await withTimeout(fn(payload), event) });
    } catch (err) {
      ack?.({ ok: false, error: toProblem(err) });
    }
  };
}

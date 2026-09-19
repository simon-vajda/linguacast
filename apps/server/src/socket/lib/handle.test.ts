import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../lib/problem';
import { HANDLER_TIMEOUT_MS, handle } from './handle';

describe('handle', () => {
  it('acks ok with the resolved value', async () => {
    const ack = vi.fn();

    await handle('ping', () => ({ serverTime: 7 }))({}, ack);

    expect(ack).toHaveBeenCalledWith({ ok: true, data: { serverTime: 7 } });
  });

  it('preserves an AppError code and message', async () => {
    const ack = vi.fn();

    await handle('ping', () => {
      throw new AppError('not_allowed', 'Nope.');
    })({}, ack);

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'not_allowed', message: 'Nope.' },
    });
  });

  it('maps any other throw to internal_error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ack = vi.fn();

    await handle('ping', () => {
      throw new TypeError('boom');
    })({}, ack);

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'internal_error', message: 'An unexpected error occurred.' },
    });
  });

  it('does not throw when the event carries no ack callback', async () => {
    await expect(handle('noise', () => 1)({})).resolves.toBeUndefined();
  });

  describe('watchdog', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('acks timeout when the handler never settles', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ack = vi.fn();

      const settled = handle('ping', () => new Promise<number>(() => {}))({}, ack);
      await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS);
      await settled;

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        error: { code: 'timeout', message: 'Handler for "ping" timed out.' },
      });
      // The server log must name the event, or a hung handler is unfindable — and it is
      // always-on, so a wedged handler is visible without the verbose tier.
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('ping'));
      const line = logged.mock.calls.map(String).find((entry) => entry.includes('ping')) ?? '';
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z socket: /);
    });

    it('does not fire the watchdog for a handler that settles in time', async () => {
      const ack = vi.fn();

      const settled = handle('ping', () => ({ serverTime: 1 }))({}, ack);
      await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS * 2);
      await settled;

      expect(ack).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { serverTime: 1 } });
    });
  });
});

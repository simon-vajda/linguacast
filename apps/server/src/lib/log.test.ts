import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock } = vi.hoisted(() => ({ envMock: { LOG_VERBOSE: false } }));
vi.mock('../env', () => ({ env: envMock }));

const { logger, resetOnceWarnings } = await import('./log');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetOnceWarnings();
  envMock.LOG_VERBOSE = false;
  info = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the always-on tier', () => {
  it('writes with the verbose flag unset', () => {
    logger('media').info('a channel went on air');

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toContain('media: a channel went on air');
  });

  it('carries an ISO-8601 timestamp and the subsystem prefix', () => {
    logger('proxy').info('hello');

    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toMatch(ISO);
    expect(line).toMatch(/ proxy: hello$/);
    expect(new Date(line.slice(0, 24)).toISOString()).toBe(line.slice(0, 24));
  });

  it('preserves severity', () => {
    const log = logger('media');
    log.info('informational');
    log.warn('a warning');
    log.error('an error');

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('media: a warning');
    expect(error.mock.calls[0]?.[0]).toContain('media: an error');
  });

  it('passes a cause through to the console alongside the line', () => {
    const cause = new Error('boom');
    logger('media').error('could not start', cause);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('media: could not start'), cause);
  });

  it('writes no second argument when there is no cause', () => {
    logger('media').error('could not start');

    expect(error.mock.calls[0]).toHaveLength(1);
  });
});

describe('the verbose tier', () => {
  it('is suppressed when the flag is unset', () => {
    const log = logger('media');
    log.verbose.info('ice connected');
    log.verbose.warn('ice disconnected');
    log.verbose.error('dtls failed');

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('writes when the flag is set, at each severity', () => {
    envMock.LOG_VERBOSE = true;
    const log = logger('media');
    log.verbose.info('ice connected');
    log.verbose.warn('ice disconnected');
    log.verbose.error('dtls failed');

    expect(info.mock.calls[0]?.[0]).toContain('media: ice connected');
    expect(warn.mock.calls[0]?.[0]).toContain('media: ice disconnected');
    expect(error.mock.calls[0]?.[0]).toContain('media: dtls failed');
  });

  it('reads the flag at call time, so the gate is not baked in at construction', () => {
    const log = logger('media');
    envMock.LOG_VERBOSE = true;
    log.verbose.info('ice connected');

    expect(info).toHaveBeenCalledOnce();
  });
});

describe('warnOnce', () => {
  it('emits on the first call for a key and stays silent afterwards', () => {
    const log = logger('proxy');
    for (let i = 0; i < 100; i++) {
      log.warnOnce('once:first', 'the proxy appends no forwarded header');
    }

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('proxy: the proxy appends no forwarded header');
  });

  it('tracks two keys independently', () => {
    const log = logger('proxy');
    log.warnOnce('once:a', 'first shape');
    log.warnOnce('once:b', 'second shape');
    log.warnOnce('once:a', 'first shape');

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('stops recording new keys past its cap, so a varying key cannot grow without bound', () => {
    const log = logger('proxy');
    for (let i = 0; i < 200; i++) {
      log.warnOnce(`once:cap:${i}`, `address ${i}`);
    }

    expect(warn.mock.calls.length).toBeLessThan(200);
    // A key already recorded before the cap is still honoured rather than re-emitted.
    log.warnOnce('once:cap:0', 'address 0');

    expect(
      warn.mock.calls.map(String).filter((line: string) => line.endsWith('address 0')),
    ).toHaveLength(1);
  });

  it('caps each key family separately, so a full one cannot silence a quiet one', () => {
    const log = logger('proxy');
    for (let i = 0; i < 200; i++) {
      log.warnOnce(`once:varying:${i}`, `address ${i}`);
    }
    warn.mockClear();

    log.warnOnce('once:fixed', 'the condition nobody has reported yet');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('the condition nobody has reported yet');
  });

  it('shares its keys across loggers, so a per-call-site logger still warns once', () => {
    logger('proxy').warnOnce('once:shared', 'same condition');
    logger('proxy').warnOnce('once:shared', 'same condition');

    expect(warn).toHaveBeenCalledOnce();
  });
});

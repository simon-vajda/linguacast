import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, logInfo, logWarn } from './log';

function captured(method: 'info' | 'warn' | 'error'): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, method).mockImplementation(() => undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('client log tiers', () => {
  it('writes narration while the development flag is set', () => {
    vi.stubEnv('DEV', true);
    const info = captured('info');
    const warn = captured('warn');

    logInfo('media: recv transport created');
    logWarn('media: recv transport connection failed');

    expect(info).toHaveBeenCalledWith('media: recv transport created');
    expect(warn).toHaveBeenCalledWith('media: recv transport connection failed');
  });

  it('writes nothing informational or diagnostic once the flag is off', () => {
    vi.stubEnv('DEV', false);
    const info = captured('info');
    const warn = captured('warn');

    logInfo('media: recv transport created');
    logWarn('media: recv transport connection failed');

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps errors in a production build, because a failure degrades what the guest gets', () => {
    vi.stubEnv('DEV', false);
    const error = captured('error');
    const cause = new Error('transport closed');

    logError('media: could not listen', cause);

    expect(error).toHaveBeenCalledWith('media: could not listen', cause);
  });

  it('writes an error with no cause as one argument', () => {
    vi.stubEnv('DEV', false);
    const error = captured('error');

    logError('media: could not listen');

    expect(error).toHaveBeenCalledWith('media: could not listen');
  });
});

/**
 * Possession of a PIN or a speaker code is the whole authorization in this product, so a
 * line that repeats one turns a shared screen or a bug report into a way in. Scanned rather
 * than reviewed: the rule has to hold for call sites nobody is looking at.
 */
const SECRETS = /\b(pin|speakerCode|speaker_code|studioSession|sessionId|password)\b/i;

const SOURCES: Record<string, string> = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('client log call sites', () => {
  it('names no PIN, speaker code, session identifier or password', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(file)) {
        continue;
      }
      source.split('\n').forEach((line, index) => {
        if (/\b(logInfo|logWarn|logError|console\.(info|warn|error|log|debug))\s*\(/.test(line)) {
          if (SECRETS.test(line)) {
            offenders.push(`${file}:${index + 1}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

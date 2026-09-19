import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { logError, logInfo, logWarn } from './log';

function setDevelopmentBuild(value: boolean): void {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = value;
}

afterEach(() => {
  setDevelopmentBuild(true);
  jest.restoreAllMocks();
});

describe('client log tiers', () => {
  it('writes narration while the development flag is set', () => {
    setDevelopmentBuild(true);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    logInfo('media: recv transport created');
    logWarn('media: recv transport connection failed');

    expect(info).toHaveBeenCalledWith('media: recv transport created');
    expect(warn).toHaveBeenCalledWith('media: recv transport connection failed');
  });

  it('writes nothing informational or diagnostic once the flag is off', () => {
    setDevelopmentBuild(false);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    logInfo('media: recv transport created');
    logWarn('media: recv transport connection failed');

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps errors in a release build, because a failure degrades what the guest gets', () => {
    setDevelopmentBuild(false);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('transport closed');

    logError('media: could not listen', cause);

    expect(error).toHaveBeenCalledWith('media: could not listen', cause);
  });

  it('writes an error with no cause as one argument', () => {
    setDevelopmentBuild(false);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

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
const LOG_CALL = /\b(logInfo|logWarn|logError|console\.(info|warn|error|log|debug))\s*\(/;

// Jest runs with the package as its root, and jest-expo compiles to CJS, where
// `import.meta` does not exist.
const APP_ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('client log call sites', () => {
  it('names no PIN, speaker code, session identifier or password', () => {
    const files = [path.join(APP_ROOT, 'app'), path.join(APP_ROOT, 'src')].flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(20);

    const offenders = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          LOG_CALL.test(line) && SECRETS.test(line)
            ? [`${path.relative(APP_ROOT, file)}:${index + 1}`]
            : [],
        ),
    );

    expect(offenders).toEqual([]);
  });
});

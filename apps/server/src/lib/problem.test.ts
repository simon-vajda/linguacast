import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, toProblem } from './problem';

const PIN = '481902';
const SPEAKER_CODE = 'GLASS-OTTER';
const STUDIO_SESSION = 'ssn_7f3a9c1e';

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const written = () => error.mock.calls.flat().map(String).join('\n');

describe('toProblem', () => {
  it('keeps an AppError on the wire and logs nothing', () => {
    expect(toProblem(new AppError('channel_taken', 'Somebody else is broadcasting.'))).toEqual({
      code: 'channel_taken',
      message: 'Somebody else is broadcasting.',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('hides anything else behind internal_error', () => {
    expect(toProblem(new Error('the router rejected it'))).toEqual({
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    });
  });

  it('logs the name, message and stack of a thrown Error', () => {
    toProblem(new TypeError('cannot read properties of undefined'));

    expect(written()).toContain('TypeError');
    expect(written()).toContain('cannot read properties of undefined');
  });

  it('reproduces no credential carried on the thrown value', () => {
    const err = Object.assign(new Error('produce failed'), {
      pin: PIN,
      speakerCode: SPEAKER_CODE,
      studioSession: STUDIO_SESSION,
      payload: { pin: PIN },
    });

    toProblem(err);

    expect(written()).toContain('produce failed');
    expect(written()).not.toContain(PIN);
    expect(written()).not.toContain(SPEAKER_CODE);
    expect(written()).not.toContain(STUDIO_SESSION);
  });

  it('reproduces nothing at all from a non-Error thrown value', () => {
    toProblem({ pin: PIN, speakerCode: SPEAKER_CODE });

    expect(written()).not.toContain(PIN);
    expect(written()).not.toContain(SPEAKER_CODE);
    expect(written()).toContain('non-Error');
  });

  it('is written always-on, so a failure is visible without the verbose tier', () => {
    toProblem(new Error('boom'));

    expect(error).toHaveBeenCalledOnce();
    expect(written()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z error: /);
  });
});

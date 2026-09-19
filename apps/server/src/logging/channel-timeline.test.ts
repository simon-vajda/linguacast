import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '../core/notifications';
import { createChannelTimeline } from './channel-timeline';

const { envMock } = vi.hoisted(() => ({ envMock: { LOG_VERBOSE: false } }));
vi.mock('../env', () => ({ env: envMock }));

const SLUGS = new Map([
  [11, 'de'],
  [12, 'fr'],
]);

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  envMock.LOG_VERBOSE = false;
  info = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const lines = () => info.mock.calls.map((call: unknown[]) => String(call[0]));
const timeline = () => createChannelTimeline((channelId) => SLUGS.get(channelId));

const onAir = (channelId = 11, slug = 'de'): Notification => ({
  type: 'producer-opened',
  eventId: 3,
  channelId,
  slug,
});
const offAir = (channelId = 11, slug = 'de'): Notification => ({
  type: 'producer-closed',
  eventId: 3,
  channelId,
  slug,
  reason: 'ended',
});
const listeners = (count: number, channelId = 11, slug = 'de'): Notification => ({
  type: 'listeners-changed',
  eventId: 3,
  channelId,
  slug,
  count,
});
const claim = (sessionId: string | null, channelId = 11): Notification => ({
  type: 'claim-changed',
  eventId: 3,
  channelId,
  sessionId,
  socketId: sessionId === null ? null : 'sock_1',
});

describe('the channel timeline', () => {
  it('logs going on air and going off air, one line each, named by event and slug', () => {
    const apply = timeline();

    apply(onAir());
    apply(offAir());

    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toContain('event 3 de on air');
    expect(lines()[1]).toContain('event 3 de off air');
  });

  it('writes nothing of its own for listener changes between the boundaries', () => {
    const apply = timeline();
    apply(onAir());
    info.mockClear();

    for (let i = 1; i <= 100; i++) {
      apply(listeners(i));
    }

    expect(info).not.toHaveBeenCalled();
  });

  it('reports the peak reached during the session, not the final count', () => {
    const apply = timeline();
    apply(onAir());
    apply(listeners(40));
    apply(listeners(120));
    apply(listeners(3));

    apply(offAir());

    expect(lines().at(-1)).toContain('3 listening, peak 120');
  });

  it("does not let a second broadcast inherit the first one's peak", () => {
    const apply = timeline();
    apply(onAir());
    apply(listeners(120));
    apply(listeners(0));
    apply(offAir());
    info.mockClear();

    apply(onAir());
    apply(listeners(5));
    apply(offAir());

    expect(lines().at(-1)).toContain('peak 5');
  });

  it('carries the peak through a handover rather than restarting it', () => {
    const apply = timeline();
    apply(onAir());
    apply(listeners(120));

    // What a swap publishes: the incoming producer, then its promotion, with no close in
    // between, because listeners experience one continuous broadcast. The count dips
    // between the two — a listener that has moved is invisible until it is recounted
    // against the producer it moved to.
    apply(onAir());
    apply(listeners(3));
    apply(claim('ssn_second'));
    apply(onAir());
    apply(listeners(118));
    apply(offAir());

    expect(lines().at(-1)).toContain('118 listening, peak 120');
  });

  it('says a channel went on air once across a handover, not once per producer', () => {
    const apply = timeline();
    apply(onAir());
    apply(onAir());
    apply(onAir());

    expect(lines().filter((line: string) => line.includes('on air'))).toHaveLength(1);
  });

  it('still opens a new broadcast after the channel has gone off air', () => {
    const apply = timeline();
    apply(onAir());
    apply(offAir());
    info.mockClear();

    apply(onAir());

    expect(lines().filter((line: string) => line.includes('on air'))).toHaveLength(1);
  });

  it('counts listeners already present when a channel goes on air', () => {
    const apply = timeline();
    apply(listeners(7));

    apply(onAir());

    expect(lines()[0]).toContain('7 listening');
  });

  it('tracks two channels of one event independently', () => {
    const apply = timeline();
    apply(onAir(11, 'de'));
    apply(onAir(12, 'fr'));
    apply(listeners(90, 11, 'de'));
    apply(listeners(4, 12, 'fr'));
    info.mockClear();

    apply(offAir(12, 'fr'));
    apply(offAir(11, 'de'));

    expect(lines()[0]).toContain('event 3 fr off air (ended), 4 listening, peak 4');
    expect(lines()[1]).toContain('event 3 de off air (ended), 90 listening, peak 90');
  });

  it('puts a handover on the same timeline', () => {
    const apply = timeline();

    apply(claim('ssn_first'));
    apply(claim('ssn_second'));
    apply(claim(null));

    expect(lines()[0]).toContain('broadcast rights taken');
    expect(lines()[1]).toContain('broadcast rights handed to another studio');
    expect(lines()[2]).toContain('broadcast rights released');
  });

  it('names a reconnected studio as a rebind rather than a handover', () => {
    const apply = timeline();

    apply(claim('ssn_first'));
    apply(claim('ssn_first'));

    expect(lines()[1]).toContain('rebound');
  });

  it('never writes the studio session that identifies the holder', () => {
    const apply = timeline();

    apply(claim('ssn_first'));
    apply(claim('ssn_second'));

    for (const line of lines()) {
      expect(line).not.toContain('ssn_first');
      expect(line).not.toContain('ssn_second');
      expect(line).not.toContain('sock_1');
    }
  });

  it('resolves the slug of a claim change, which does not carry one', () => {
    const apply = timeline();

    apply(claim('ssn_first', 12));

    expect(lines()[0]).toContain('event 3 fr');
  });

  it('names a vanished channel by its id rather than relabelling it', () => {
    const apply = timeline();

    apply(claim('ssn_first', 99));

    expect(lines()[0]).toContain('event 3 channel 99');
  });

  it('carries no listener address, because none reaches it', () => {
    const apply = timeline();
    apply(onAir());
    apply(listeners(3));
    apply(offAir());

    expect(lines().join('\n')).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('is always-on, timestamped and prefixed', () => {
    const apply = timeline();

    apply(onAir());

    expect(lines()[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z channel: /);
  });

  it('ignores the notifications it has no line for', () => {
    const apply = timeline();

    apply({ type: 'producer-paused', eventId: 3, channelId: 11, slug: 'de' });
    apply({ type: 'handover-changed', eventId: 3, channelId: 11 });
    apply({ type: 'room-evicted', eventId: 3, reason: 'worker_died' });

    expect(info).not.toHaveBeenCalled();
  });
});

import type { types } from 'mediasoup-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportPath } from './diagnostics';

/**
 * The verdict is what exposes the listener's Reconnect, and it has to survive the narration
 * around it being compiled out. Each case therefore runs twice, once per build flag.
 */
function transportReporting(entries: Record<string, unknown>[]): types.Transport {
  const report = new Map(entries.map((entry, index) => [`s${index}`, entry]));
  return { getStats: () => Promise.resolve(report), closed: false } as unknown as types.Transport;
}

const IPV6_ONLY_LOCAL = [
  { type: 'local-candidate', address: '2a0a:f640:241b:7b2e::1', candidateType: 'host' },
  { type: 'local-candidate', address: '2a0a:f640:1412:f620::1', candidateType: 'host' },
];

const IPV4_OFFER = [{ ip: '87.97.83.56' }];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('receive transport path report', () => {
  for (const dev of [true, false]) {
    const narration = dev ? 'narration enabled' : 'narration disabled';

    it(`names the address-family mismatch with no candidate pairs, ${narration}`, async () => {
      vi.stubEnv('DEV', dev);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const verdict = await reportPath(
        transportReporting(IPV6_ONLY_LOCAL),
        'recv transport',
        IPV4_OFFER,
      );

      expect(verdict).toBe('candidate-address-family-mismatch');
      expect(warn.mock.calls.length).toBe(dev ? 1 : 0);
      expect(info.mock.calls.length).toBe(dev ? 1 : 0);
    });

    it(`reports an ordinary stall as no-pair when a family overlaps, ${narration}`, async () => {
      vi.stubEnv('DEV', dev);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const verdict = await reportPath(
        transportReporting([
          ...IPV6_ONLY_LOCAL,
          { type: 'local-candidate', address: '192.168.1.24', candidateType: 'host' },
        ]),
        'recv transport',
        IPV4_OFFER,
      );

      expect(verdict).toBe('no-pair');
    });

    it(`reports a transport carrying RTP as connected, ${narration}`, async () => {
      vi.stubEnv('DEV', dev);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const verdict = await reportPath(
        transportReporting([
          { type: 'local-candidate', address: '192.168.1.24', candidateType: 'host' },
          {
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            localCandidateId: 'l1',
            remoteCandidateId: 'r1',
          },
          { type: 'inbound-rtp', bytesReceived: 4096 },
        ]),
        'recv transport',
        IPV4_OFFER,
      );

      expect(verdict).toBe('connected');
      expect(warn).not.toHaveBeenCalled();
      expect(info.mock.calls.length).toBe(dev ? 2 : 0);
    });

    it(`reports a connected transport with no RTP as no-rtp, ${narration}`, async () => {
      vi.stubEnv('DEV', dev);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const verdict = await reportPath(
        transportReporting([
          {
            type: 'candidate-pair',
            state: 'succeeded',
            nominated: true,
            localCandidateId: 'l1',
            remoteCandidateId: 'r1',
          },
          { type: 'inbound-rtp', bytesReceived: 0 },
        ]),
        'recv transport',
        IPV4_OFFER,
      );

      expect(verdict).toBe('no-rtp');
      expect(warn.mock.calls.length).toBe(dev ? 1 : 0);
    });
  }

  it('withholds a verdict when the stats sample is unavailable', async () => {
    const transport = {
      getStats: () => Promise.reject(new Error('closed')),
      closed: false,
    } as unknown as types.Transport;

    expect(await reportPath(transport, 'recv transport', IPV4_OFFER)).toBeNull();
  });
});

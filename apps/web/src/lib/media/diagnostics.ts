import {
  hasCandidateAddressFamilyMismatch,
  ICE_RECOVERY_DELAY_MS,
} from '@linguacast/client-core/media';
import type { types } from 'mediasoup-client';
import { logInfo, logWarn } from '@/lib/log';

interface OfferedCandidate {
  address?: unknown;
  ip?: unknown;
}

/**
 * The browser half of the silent-failure telemetry the server carries in
 * `core/media/diagnostics.ts`. The failure worth naming is the one where every signalling
 * call succeeds and no audio ever moves — suppressed ICE candidates (a shield or a privacy
 * extension), an unreachable announced address, a blocked RTC port. Nothing throws for any
 * of them, so narration is the only place it can be seen during development.
 *
 * The sampling and the verdict it produces run in every build; only the narration is gated.
 */

function log(message: string, ...rest: unknown[]): void {
  logInfo(`media: ${message}`, ...rest);
}

export function watchTransport(
  transport: types.Transport,
  direction: 'send' | 'recv',
  remoteCandidates: OfferedCandidate[],
  onCandidateAddressFamilyMismatch?: () => void,
): void {
  const tag = `${direction} transport`;
  log(`${tag} created`);

  transport.on('icegatheringstatechange', (gathering) => {
    log(`${tag} ice gathering ${gathering}`);
    if (gathering === 'complete') {
      void reportLocalCandidates(transport, tag);
    }
  });

  transport.on('icecandidateerror', (event) => {
    logWarn(`media: ${tag} ice candidate error`, event.errorCode, event.errorText, event.url);
  });

  transport.on('connectionstatechange', (next) => {
    if (next === 'failed' || next === 'disconnected') {
      logWarn(`media: ${tag} connection ${next}`);
    } else {
      log(`${tag} connection ${next}`);
    }
  });

  // A transport stuck short of connected is the whole failure mode; the selected pair is
  // what says which path won, and its absence is what says none did.
  window.setTimeout(() => {
    if (transport.closed) {
      return;
    }
    void reportPath(transport, tag, remoteCandidates).then((result) => {
      if (result === 'candidate-address-family-mismatch') {
        onCandidateAddressFamilyMismatch?.();
      }
    });
  }, ICE_RECOVERY_DELAY_MS);
}

/** Names a recovery step as it happens; without it a stuck transport leaves no trace of what was tried. */
export function logIceRecovery(
  direction: 'send' | 'recv',
  message: string,
  ...rest: unknown[]
): void {
  log(`${direction} transport ${message}`, ...rest);
}

/** The same snapshot the creation deadline takes, for a caller that has just tried a recovery. */
export function reportTransportPath(
  transport: types.Transport,
  direction: 'send' | 'recv',
): Promise<void> {
  return reportPath(transport, `${direction} transport`).then(() => undefined);
}

export type TransportPathReport =
  | 'connected'
  | 'no-rtp'
  | 'no-pair'
  | 'candidate-address-family-mismatch';

/**
 * The stats sample and the verdict drawn from it. Exported because the verdict, not the
 * narration around it, is what drives the listener's recovery affordance.
 */
export async function reportPath(
  transport: types.Transport,
  tag: string,
  remoteCandidates: OfferedCandidate[] = [],
): Promise<TransportPathReport | null> {
  const report = await transport.getStats().catch(() => null);
  if (!report) {
    return null;
  }

  log(`${tag} local candidates ${describeCandidateType(report, 'local-candidate')}`);

  let bytes = 0;
  let pair: string | null = null;
  let candidatePairCount = 0;
  const localAddresses: string[] = [];
  for (const entry of report.values()) {
    if (entry.type === 'outbound-rtp') {
      bytes += Number(entry.bytesSent ?? 0);
    }
    if (entry.type === 'inbound-rtp') {
      bytes += Number(entry.bytesReceived ?? 0);
    }
    if (entry.type === 'candidate-pair') {
      candidatePairCount += 1;
      if (entry.state === 'succeeded' && entry.nominated) {
        pair = `${entry.localCandidateId} -> ${entry.remoteCandidateId}`;
      }
    }
    if (entry.type === 'local-candidate' && typeof entry.address === 'string') {
      localAddresses.push(entry.address);
    }
  }

  if (pair === null) {
    logWarn(
      `media: ${tag} has no nominated candidate pair after ${ICE_RECOVERY_DELAY_MS}ms — ` +
        'ICE never connected. A browser shield or privacy extension suppressing WebRTC ' +
        'candidates, or a blocked RTC port, both look exactly like this.',
      describeCandidates(report),
    );
    const remoteAddresses = remoteCandidates.flatMap((candidate) => {
      const address = candidate.address ?? candidate.ip;
      return typeof address === 'string' ? [address] : [];
    });
    return hasCandidateAddressFamilyMismatch({
      localAddresses,
      remoteAddresses,
      candidatePairCount,
    })
      ? 'candidate-address-family-mismatch'
      : 'no-pair';
  }
  if (bytes === 0) {
    logWarn(`media: ${tag} connected on ${pair} but no RTP has moved.`);
    return 'no-rtp';
  }
  log(`${tag} carrying RTP on ${pair} (${bytes} bytes)`);
  return 'connected';
}

async function reportLocalCandidates(transport: types.Transport, tag: string): Promise<void> {
  const report = await transport.getStats().catch(() => null);
  if (!report || transport.closed) {
    return;
  }
  log(`${tag} local candidates ${describeCandidateType(report, 'local-candidate')}`);
}

function describeCandidateType(
  report: RTCStatsReport,
  type: 'local-candidate' | 'remote-candidate',
): string {
  const candidates: string[] = [];
  for (const entry of report.values()) {
    if (entry.type !== type) {
      continue;
    }
    const where = `${entry.candidateType}/${entry.protocol} ${entry.address ?? '?'}:${entry.port ?? '?'}`;
    candidates.push(entry.networkType === undefined ? where : `${where} (${entry.networkType})`);
  }
  return `[${candidates.join(', ') || 'none'}]`;
}

/**
 * What ICE had to work with. A handoff that leaves the browser gathering on an interface
 * that is already gone reads as no local candidates at all, which is indistinguishable
 * from a suppressed-candidate shield until the two sides are counted separately.
 */
function describeCandidates(report: RTCStatsReport): string {
  const pairs: string[] = [];
  for (const entry of report.values()) {
    if (entry.type === 'candidate-pair') {
      pairs.push(String(entry.state));
    }
  }
  // Joined rather than returned as arrays: a mobile console collapses an object, and these
  // strings are the whole diagnosis — an address family that cannot pair reads as nothing
  // at all until the candidates themselves are on screen.
  return (
    `local ${describeCandidateType(report, 'local-candidate')} ` +
    `remote ${describeCandidateType(report, 'remote-candidate')} ` +
    `pairs [${pairs.join(', ') || 'none'}]`
  );
}

/** A receive track that never unmutes is the listener-side symptom of RTP not arriving. */
export function watchConsumerTrack(track: MediaStreamTrack, slug: string): void {
  log(`consumer track for ${slug} ${track.muted ? 'muted' : 'live'}`);
  track.addEventListener('unmute', () =>
    log(`consumer track for ${slug} unmuted — audio arriving`),
  );
  track.addEventListener('mute', () => logWarn(`media: consumer track for ${slug} muted`));
  track.addEventListener('ended', () => logWarn(`media: consumer track for ${slug} ended`));
}

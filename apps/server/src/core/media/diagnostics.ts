import type { types } from 'mediasoup';
import { logger } from '../../lib/log';

/**
 * Silent-failure telemetry, split across the two logging tiers.
 *
 * The failure this exists for is the one that reports success everywhere: signalling
 * completes, both screens read connected, and no RTP ever crosses the network — a wrong
 * announced address, a remapped or unforwarded RTC port, a browser shield suppressing ICE
 * candidates. None of those raise an error anywhere, so the only way to see them is to
 * check whether ICE connected and whether bytes moved, and say so when they did not.
 *
 * Those three checks are always-on: they are what a support ticket is diagnosed from, and
 * their cost is one line per failure rather than per connection. The narration around
 * them — transport lifecycle, ICE and DTLS progress, candidate addresses — is verbose,
 * because a hundred-listener event would otherwise bury every line that matters under a
 * thousand that do not, and because listeners' addresses are not a routine record to keep.
 */

const log = logger('media');

/** Long enough that an ordinary ICE handshake has finished, short enough to still be watching. */
const SILENCE_CHECK_MS = 5_000;

function short(id: string): string {
  return id.slice(0, 8);
}

function describe(tuple: types.TransportTuple): string {
  const remote =
    tuple.remoteIp === undefined ? 'unknown' : `${tuple.remoteIp}:${tuple.remotePort ?? 0}`;
  return `${tuple.protocol} ${tuple.localAddress}:${tuple.localPort} <- ${remote}`;
}

export function watchTransport(
  transport: types.WebRtcTransport,
  eventId: number,
  direction: string,
): void {
  // A transport belongs to an event and a direction; there is one router per event, so it
  // has no channel to name. The verbose tag adds the identifier that distinguishes two
  // transports of the same shape, which is exactly what an always-on line must not carry.
  const subject = `event ${eventId} ${direction}`;
  const tag = `${subject} ${short(transport.id)}`;
  const candidates = transport.iceCandidates
    .map((candidate) => `${candidate.protocol}/${candidate.address}:${candidate.port}`)
    .join(' ');
  log.verbose.info(`${tag} transport created, offering ${candidates || 'no candidates'}`);

  transport.on('icestatechange', (iceState) => {
    const line = `${tag} ice ${iceState}`;
    if (iceState === 'disconnected') {
      log.verbose.warn(line);
    } else {
      log.verbose.info(line);
    }
  });

  transport.on('iceselectedtuplechange', (tuple) => {
    log.verbose.info(`${tag} ice pair ${describe(tuple)}`);
  });

  transport.on('dtlsstatechange', (dtlsState) => {
    const line = `${tag} dtls ${dtlsState}`;
    if (dtlsState === 'failed') {
      log.verbose.error(line);
    } else {
      log.verbose.info(line);
    }
  });

  // A transport that never reaches connected is the whole failure mode: nothing else in
  // the system will ever say so, because every signalling call it made succeeded.
  const timer = setTimeout(() => {
    if (transport.closed) {
      return;
    }
    if (transport.iceState !== 'connected' && transport.iceState !== 'completed') {
      log.warn(
        `${subject} still ${transport.iceState}/${transport.dtlsState} after ${SILENCE_CHECK_MS}ms — ` +
          'no ICE connectivity. Check PUBLIC_ADDRESS, that the RTC ports are published ' +
          'one-to-one and open on UDP and TCP, and whether the client is suppressing candidates.',
      );
    }
  }, SILENCE_CHECK_MS);
  timer.unref();
  transport.observer.once('close', () => {
    clearTimeout(timer);
    log.verbose.info(`${tag} transport closed`);
  });
}

function totalBytes(stats: Array<{ type: string; byteCount: number }>, type: string): number {
  return stats.filter((stat) => stat.type === type).reduce((sum, stat) => sum + stat.byteCount, 0);
}

/** ICE can be up and the media path still dead; bytes are the only proof audio moved. */
export function watchProducer(producer: types.Producer, eventId: number, slug: string): void {
  const subject = `event ${eventId} ${slug} producer`;
  const tag = `${subject} ${short(producer.id)}`;
  log.verbose.info(`${tag} opened${producer.paused ? ' (paused)' : ''}`);

  const timer = setTimeout(() => {
    if (producer.closed) {
      return;
    }
    void producer
      .getStats()
      .then((stats) => {
        const bytes = totalBytes(stats, 'inbound-rtp');
        if (bytes === 0) {
          log.warn(
            `${subject} no RTP received after ${SILENCE_CHECK_MS}ms — the speaker is connected ` +
              'but sending nothing that reaches this server.',
          );
        } else {
          log.verbose.info(`${tag} receiving RTP (${bytes} bytes)`);
        }
      })
      .catch(() => {});
  }, SILENCE_CHECK_MS);
  timer.unref();
  producer.observer.once('close', () => {
    clearTimeout(timer);
    log.verbose.info(`${tag} closed`);
  });
}

export function watchConsumer(consumer: types.Consumer, eventId: number, slug: string): void {
  const subject = `event ${eventId} ${slug} consumer`;
  const tag = `${subject} ${short(consumer.id)}`;

  const timer = setTimeout(() => {
    if (consumer.closed || consumer.paused) {
      return;
    }
    void consumer
      .getStats()
      .then((stats) => {
        const bytes = totalBytes(stats, 'outbound-rtp');
        if (bytes === 0) {
          log.warn(`${subject} no RTP sent after ${SILENCE_CHECK_MS}ms.`);
        } else {
          log.verbose.info(`${tag} sending RTP (${bytes} bytes)`);
        }
      })
      .catch(() => {});
  }, SILENCE_CHECK_MS);
  timer.unref();
  consumer.observer.once('close', () => clearTimeout(timer));
}

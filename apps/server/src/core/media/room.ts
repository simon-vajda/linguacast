import type { types } from 'mediasoup';
import { logger } from '../../lib/log';
import { AppError } from '../../lib/problem';
import { watchTransport } from './diagnostics';
import { Peer, type TransportDirection } from './peer';

const log = logger('media');

function slugOf(producer: types.Producer): string {
  const slug = (producer.appData as { slug?: unknown }).slug;
  return typeof slug === 'string' ? slug : '';
}

/**
 * `replaced` is the silent one: a swap reaches listeners as a single status naming the new
 * producer, so publishing a close for the producer it replaced would report an off-air the
 * channel never had.
 */
export type ProducerCloseReason = 'ended' | 'replaced';

export function markClosing(producer: types.Producer, reason: ProducerCloseReason): void {
  (producer.appData as { closeReason?: ProducerCloseReason }).closeReason = reason;
}

export interface ChannelBroadcastStatus {
  online: boolean;
  muted: boolean;
  producerId: string | null;
  /** Set only inside a handover's swap window, while both interpreters are transmitting. */
  incomingProducerId: string | null;
}

export interface RoomInit {
  eventId: number;
  router: types.Router;
  webRtcServer: types.WebRtcServer;
  workerIndex: number;
}

/**
 * One event's media: a single router, its producers keyed by channel, and a peer per
 * connected socket. One router per event and not per channel, because a transport can only
 * consume producers on its own router — a guest holding one connection for the whole event
 * is what makes switching language instant.
 */
export class Room {
  readonly eventId: number;
  readonly router: types.Router;
  readonly webRtcServer: types.WebRtcServer;
  readonly workerIndex: number;

  private readonly producers = new Map<number, types.Producer>();
  /** The handover's second producer, live alongside the first for the swap window's length. */
  private readonly incoming = new Map<number, types.Producer>();
  private readonly peers = new Map<string, Peer>();
  private closed = false;

  constructor(init: RoomInit) {
    this.eventId = init.eventId;
    this.router = init.router;
    this.webRtcServer = init.webRtcServer;
    this.workerIndex = init.workerIndex;
  }

  // --- producers --------------------------------------------------------------

  get producerCount(): number {
    return this.producers.size;
  }

  producer(channelId: number): types.Producer | undefined {
    return this.producers.get(channelId);
  }

  incomingProducer(channelId: number): types.Producer | undefined {
    return this.incoming.get(channelId);
  }

  /**
   * What a fresh consumer subscribes to. During a swap window that is the incoming
   * producer: a listener joining then would otherwise be handed the voice that is about to
   * stop, and would have to swap again a moment later.
   */
  targetProducer(channelId: number): types.Producer | undefined {
    return this.incoming.get(channelId) ?? this.producers.get(channelId);
  }

  /** Scoped to the caller's own channel, so a producer id alone reaches nothing. */
  producerById(channelId: number, producerId: string): types.Producer | undefined {
    const current = this.producers.get(channelId);
    if (current?.id === producerId) {
      return current;
    }
    const incoming = this.incoming.get(channelId);
    return incoming?.id === producerId ? incoming : undefined;
  }

  /** How many peers hold an open consumer on this producer, paused or not. */
  consumersOn(producerId: string): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      const consumer = peer.consumerForProducer(producerId);
      if (consumer && !consumer.closed) {
        count += 1;
      }
    }
    return count;
  }

  /** A channel is live while an unclosed producer exists. Mute pauses; it does not close. */
  isOnline(channelId: number): boolean {
    const producer = this.producers.get(channelId);
    return producer !== undefined && !producer.closed;
  }

  /**
   * One read of the current producer owns every public broadcast bit, so they cannot
   * disagree. `producerId` is what lets a listener follow a replacement as one status
   * rather than as a close followed by an open; it is already public to anyone consuming.
   */
  channelStatus(channelId: number): ChannelBroadcastStatus {
    const producer = this.producers.get(channelId);
    if (!producer || producer.closed) {
      return { online: false, muted: false, producerId: null, incomingProducerId: null };
    }
    const incoming = this.incoming.get(channelId);
    return {
      online: true,
      muted: producer.paused,
      producerId: producer.id,
      incomingProducerId: incoming && !incoming.closed ? incoming.id : null,
    };
  }

  /** Producing twice on one channel replaces rather than duplicating. */
  setProducer(channelId: number, producer: types.Producer): void {
    const outgoing = this.producers.get(channelId);
    if (outgoing) {
      markClosing(outgoing, 'replaced');
      outgoing.close();
    }
    this.producers.set(channelId, producer);
    producer.observer.once('close', () => {
      if (this.producers.get(channelId) === producer) {
        this.producers.delete(channelId);
      }
    });
  }

  /**
   * The incoming half of a handover: held beside the standing producer rather than in
   * place of it, so the outgoing interpreter keeps transmitting through the swap.
   */
  setIncomingProducer(channelId: number, producer: types.Producer): void {
    const superseded = this.incoming.get(channelId);
    if (superseded) {
      // Marked before the map is overwritten: the close handler can no longer recognise it
      // as the incoming producer by then, and an unmarked close reports an off-air the
      // channel never had.
      markClosing(superseded, 'replaced');
      superseded.close();
    }
    this.incoming.set(channelId, producer);
    producer.observer.once('close', () => {
      if (this.incoming.get(channelId) === producer) {
        this.incoming.delete(channelId);
      }
    });
  }

  /** The swap window closing: the incoming producer becomes the channel's own. */
  promoteIncoming(channelId: number): types.Producer | undefined {
    const incoming = this.incoming.get(channelId);
    if (!incoming) {
      return undefined;
    }
    this.incoming.delete(channelId);
    this.setProducer(channelId, incoming);
    return incoming;
  }

  /** The swap window ending without a swap; silent, because nothing ever named it live. */
  closeIncomingProducer(channelId: number): void {
    const incoming = this.incoming.get(channelId);
    if (!incoming) {
      return;
    }
    this.incoming.delete(channelId);
    markClosing(incoming, 'replaced');
    incoming.close();
  }

  closeProducer(channelId: number): void {
    this.closeIncomingProducer(channelId);
    const producer = this.producers.get(channelId);
    if (!producer) {
      return;
    }
    this.producers.delete(channelId);
    producer.close();
  }

  /** Each live channel with the slug its producer was stamped with at produce time. */
  liveChannels(): Array<{ channelId: number; slug: string }> {
    return [...this.producers.entries()].map(([channelId, producer]) => ({
      channelId,
      slug: slugOf(producer),
    }));
  }

  producerSlug(channelId: number): string | undefined {
    const producer = this.producers.get(channelId);
    return producer === undefined ? undefined : slugOf(producer);
  }

  /**
   * How many guests are actually receiving this channel: peers holding an open, locally
   * unpaused consumer on its producer. Structurally zero until somebody goes live, and
   * zero again the moment the producer closes, because mediasoup closes its consumers.
   */
  listenerCount(channelId: number): number {
    const producer = this.producers.get(channelId);
    if (!producer || producer.closed) {
      return 0;
    }
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.isListeningTo(producer.id)) {
        count += 1;
      }
    }
    return count;
  }

  // --- peers ------------------------------------------------------------------

  /** The lookup the takeover and revocation paths both need; unknown is undefined. */
  peer(socketId: string): Peer | undefined {
    return this.peers.get(socketId);
  }

  peerFor(socketId: string): Peer {
    const existing = this.peers.get(socketId);
    if (existing) {
      return existing;
    }
    const peer = new Peer(socketId);
    this.peers.set(socketId, peer);
    return peer;
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  closePeer(socketId: string): void {
    const peer = this.peers.get(socketId);
    if (!peer) {
      return;
    }
    this.peers.delete(socketId);
    peer.close();
  }

  // --- transports -------------------------------------------------------------

  /**
   * Allocation failure is an `AppError` with its own code, so a client sees a real
   * rejection rather than the 8s handler timeout or a generic internal error.
   */
  async createTransport(
    socketId: string,
    direction: TransportDirection,
  ): Promise<types.WebRtcTransport> {
    const peer = this.peerFor(socketId);
    if (peer.transport(direction)) {
      throw new AppError('transport_exists', `A ${direction} transport already exists.`);
    }

    let transport: types.WebRtcTransport;
    try {
      transport = await this.router.createWebRtcTransport({
        webRtcServer: this.webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { socketId, direction },
      });
    } catch (cause) {
      log.error(`could not create a ${direction} transport on event ${this.eventId}`, cause);
      throw new AppError('media_unavailable', 'Could not allocate a media transport.');
    }

    // Registering after the await, so an allocation failure leaves nothing half-attached.
    // The peer can still refuse it — it raced another create — and an unregistered
    // transport is one nothing will ever name again, so it closes here or it leaks.
    try {
      peer.addTransport(direction, transport);
    } catch (cause) {
      transport.close();
      throw cause;
    }
    watchTransport(transport, this.eventId, direction);
    return transport;
  }

  // --- lifetime ---------------------------------------------------------------

  /** No producers and nothing attached: the state the idle teardown timer waits for. */
  get isIdle(): boolean {
    if (this.producers.size > 0 || this.incoming.size > 0) {
      return false;
    }
    for (const peer of this.peers.values()) {
      if (peer.transportCount > 0) {
        return false;
      }
    }
    return true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const producer of this.incoming.values()) {
      producer.close();
    }
    this.incoming.clear();
    for (const producer of this.producers.values()) {
      producer.close();
    }
    this.producers.clear();
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.router.close();
  }
}

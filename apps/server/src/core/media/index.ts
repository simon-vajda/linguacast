import type { types } from 'mediasoup';
import { logger } from '../../lib/log';
import { AppError } from '../../lib/problem';
import { type GrantCancellation, handover } from '../handover';
import { listenerHistory } from '../listener-history';
import { type EvictionReason, notifications } from '../notifications';
import { presence, type StudioSocket } from '../presence';
import { reports } from '../reports';
import { type AddressResolver, AnnouncedAddress } from './announced-address';
import {
  augmentCandidates,
  type IceServer,
  iceServersFor,
  isUnroutableAnnouncedAddress,
  type MediaNetworkConfig,
} from './config';
import { watchConsumer, watchProducer } from './diagnostics';
import { ListenerCountPublisher } from './listeners';
import type { TransportDirection } from './peer';
import { discoverReflexiveAddress, reflexiveMismatch } from './reflexive-address';
import { RoomRegistry } from './registry';

export type { ChannelBroadcastStatus } from './room';

import { type ChannelBroadcastStatus, markClosing, type Room } from './room';
import { type WorkerFactory, WorkerPool } from './workers';

const log = logger('media');

/**
 * How long both interpreters may transmit at once when every listener has not yet swapped.
 * Comfortably above a consume-and-resume round trip on a poor mobile link, and far below
 * the grant deadline, so a listener whose swap is merely slow is never cut off while the
 * pair of producers stays on the router for about as long as a sentence.
 */
export const SWAP_DEADLINE_MS = 4_000;

export interface MediaContext {
  eventId: number;
  socketId: string;
  /** The studio page behind this connection; null for a listener, who may not produce. */
  sessionId?: string | null;
}

export interface StartMediaOptions {
  net: MediaNetworkConfig;
  stunUrl?: string;
  graceMs?: number;
  swapDeadlineMs?: number;
  hostCpuCount?: number;
  createWorker?: WorkerFactory;
  resolveAddress?: AddressResolver;
  addressPollMs?: number;
  /** Off by default so a test never sends a datagram; `index.ts` turns it on. */
  probeReflexiveAddress?: boolean;
}

interface MediaState {
  pool: WorkerPool;
  registry: RoomRegistry;
  stunUrl?: string;
  listeners: ListenerCountPublisher;
  announced: AnnouncedAddress;
  swapDeadlineMs: number;
  unsubscribeGrants: () => void;
}

/** One channel's overlapping producers, open until every listener has swapped or it expires. */
interface SwapWindow {
  eventId: number;
  channelId: number;
  slug: string;
  outgoingProducerId: string;
  timer: NodeJS.Timeout;
}

const swaps = new Map<number, SwapWindow>();

// A module singleton, like `db`: handlers and admin routes reach it by import rather than
// by injection, which is this codebase's standing choice.
let state: MediaState | null = null;

/**
 * Started before the HTTP server listens, so a pool that cannot start is a boot failure
 * rather than a runtime surprise. A worker dying later is deliberately not fatal.
 */
export async function startMedia(options: StartMediaOptions): Promise<void> {
  if (state) {
    throw new Error('startMedia called twice');
  }

  // Before the pool, because the address is baked into every worker's listen infos: a
  // hostname that cannot be resolved is a boot failure rather than a deployment that
  // starts and carries no audio to half its guests.
  const announced = new AnnouncedAddress({
    configured: options.net.announcedIp,
    resolve: options.resolveAddress,
    pollMs: options.addressPollMs,
  });
  const announcedIp = await announced.start();
  if (announcedIp !== options.net.announcedIp) {
    log.info(`${options.net.announcedIp} resolved to ${announcedIp}`);
  }

  // The configured value is what the workers announce, hostname and all: `createTransport`
  // adds the resolved literal to every candidate list, so both forms reach the client and
  // the announced value never moves.
  const pool = new WorkerPool({
    net: options.net,
    hostCpuCount: options.hostCpuCount,
    createWorker: options.createWorker,
  });
  await pool.start();
  log.info(pool.startupSummary(announcedIp));

  const listeners = new ListenerCountPublisher({
    // A recount rather than a delta, and a room that has gone answers zero: the window is
    // trailing, so it routinely fires after the room it names was torn down.
    count: (eventId, channelId) => listenerCount(eventId, channelId),
    // Recorded at the publisher's output rather than at every poke: what comes out here is
    // already coalesced and already known to differ from the last number, so every point
    // the history keeps is a change somebody could see.
    publish: (notification) => {
      notifications.publish(notification);
      if (notification.type === 'listeners-changed') {
        listenerHistory.record(notification.eventId, notification.channelId, notification.count);
      }
    },
  });

  const registry = new RoomRegistry(pool, {
    graceMs: options.graceMs,
    onRoomClosed: (room, reason) => {
      // The remembered counts must not outlive the room: kept, they would suppress the
      // first real count of the next broadcast on the same channel.
      listeners.forgetEvent(room.eventId);
      reports.forgetEvent(room.eventId);
      // The history deliberately does not forget here. A dead worker keeps every claim and
      // its on-air start while the clients renegotiate, so the broadcast carries on and
      // dropping the series would redraw the hour behind it as a flat zero. The final zero
      // `listeners.forgetEvent` publishes is recorded like any other change, and the dip
      // recovers as the listeners come back.
      // Idle and shutdown take nobody's access away, so nothing is evicted for them.
      if (reason === 'worker_died') {
        notifications.publish({ type: 'room-evicted', eventId: room.eventId, reason });
      }
    },
  });

  state = {
    pool,
    registry,
    stunUrl: options.stunUrl,
    listeners,
    announced,
    swapDeadlineMs: options.swapDeadlineMs ?? SWAP_DEADLINE_MS,
    // Registered rather than imported the other way round: `core/handover` must not know
    // that media exists, and a cancelled grant has a producer to close.
    unsubscribeGrants: handover.onGrantCancelled(cancelSwap),
  };

  if (isUnroutableAnnouncedAddress(announcedIp)) {
    log.warn(
      `guests are told to connect to ${announcedIp}, which is a private or ` +
        'loopback address; nobody outside this machine can reach it. Set PUBLIC_ADDRESS.',
    );
    return;
  }

  // Never awaited: the answer is a log line and nothing reads it, so a STUN server that is
  // slow or gone must not hold up the listener. Only worth asking when the address looks
  // usable — the warning above already covers the case where it does not.
  const stunUrl = options.stunUrl;
  if (!options.probeReflexiveAddress || !stunUrl) {
    return;
  }
  const crossCheck = (address: string) => {
    void discoverReflexiveAddress(stunUrl).then((reflexive) => {
      const mismatch = reflexiveMismatch(address, reflexive);
      if (mismatch) {
        log.warn(mismatch);
      }
    });
  };
  crossCheck(announcedIp);
  // The only startup check a move can meaningfully re-run: `AnnouncedAddress.refresh`
  // already filters unroutable answers before it notifies, so the warning above could
  // never fire from here. Nothing is rebuilt — the announced address no longer moves.
  announced.onChange(crossCheck);
}

export async function stopMedia(): Promise<void> {
  if (!state) {
    return;
  }
  const { pool, registry, listeners, announced, unsubscribeGrants } = state;
  // Nulled first, so every consumer closed inside closeAll() finds `scheduleRecount` inert
  // rather than scheduling a fresh window behind a drain that already ran.
  state = null;
  unsubscribeGrants();
  for (const swap of swaps.values()) {
    clearTimeout(swap.timer);
  }
  swaps.clear();
  announced.close();
  await registry.closeAll();
  listeners.close();
  reports.close();
  listenerHistory.close();
  await pool.close();
}

/** Cancels a scheduled teardown for a room that is being reused rather than created. */
function keepAlive(eventId: number): void {
  state?.registry.touch(eventId);
}

function require_(): MediaState {
  if (!state) {
    throw new AppError('media_unavailable', 'Media is not available.');
  }
  return state;
}

// --- liveness ----------------------------------------------------------------

/**
 * A channel is live while an unclosed producer exists — not while a studio is open and
 * not while a speaker holds the claim. Mute pauses the producer, so it does not change
 * this. Replaces the claim-derived answer `core/presence.ts` used to give.
 */
export function isOnline(eventId: number, channelId: number): boolean {
  return state?.registry.get(eventId)?.isOnline(channelId) ?? false;
}

/** Current producer existence, pause state and identity, read together so they cannot disagree. */
export function channelStatus(eventId: number, channelId: number): ChannelBroadcastStatus {
  return (
    state?.registry.get(eventId)?.channelStatus(channelId) ?? {
      online: false,
      muted: false,
      producerId: null,
      incomingProducerId: null,
    }
  );
}

/**
 * A listener is a guest holding an open, locally unpaused consumer on the channel's
 * producer — somebody receiving audio, not somebody with a page open. Structurally zero
 * until the interpreter goes live, which is the intended reading.
 */
export function listenerCount(eventId: number, channelId: number): number {
  return state?.registry.get(eventId)?.listenerCount(channelId) ?? 0;
}

/** `core/`'s own shape. The contract's DTO is the HTTP mapper's business, not this layer's. */
export interface ChannelListenerCount {
  channelId: number;
  slug: string;
  count: number;
}

export interface EventListenerCounts {
  eventId: number;
  channels: ChannelListenerCount[];
}

/** Every live channel of every active room with its count, for the admin read. */
export function listenerCounts(): EventListenerCounts[] {
  return (state?.registry.all() ?? []).map((room) => ({
    eventId: room.eventId,
    channels: room.liveChannels().map(({ channelId, slug }) => ({
      channelId,
      slug,
      count: room.listenerCount(channelId),
    })),
  }));
}

/**
 * The one poke every change goes through. Inert once the media layer has stopped, which is
 * what keeps the shutdown path from scheduling a window nothing will ever clear.
 */
function scheduleRecount(eventId: number, channelId: number, slug: string): void {
  state?.listeners.schedule(eventId, channelId, slug);
}

// --- signalling ---------------------------------------------------------------

/**
 * `create` is what keeps a room from existing before anyone has gone live: only a caller
 * holding the broadcast claim may bring a router into being, so a guest waiting on an
 * offline Channel allocates nothing on either side.
 */
export async function capabilities(
  ctx: MediaContext,
  options: { create: boolean },
): Promise<{ routerRtpCapabilities: types.RtpCapabilities; iceServers: IceServer[] }> {
  const room = await roomFor(ctx.eventId, options.create);
  return {
    routerRtpCapabilities: room.router.rtpCapabilities,
    iceServers: iceServersFor(require_().stunUrl),
  };
}

export interface TransportDescription {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

export async function createTransport(
  ctx: MediaContext,
  direction: TransportDirection,
  options: { create: boolean },
): Promise<TransportDescription> {
  // Taken before the awaits: a shutdown landing in that window would otherwise throw
  // `media_unavailable` at a caller whose transport was already created.
  const { announced } = require_();
  const room = await roomFor(ctx.eventId, options.create);
  const transport = await room.createTransport(ctx.socketId, direction);
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    // Both address forms: mediasoup announced the configured one, and the literal it
    // currently resolves to is added here. See `augmentCandidates`.
    iceCandidates: augmentCandidates(transport.iceCandidates, announced.current),
    dtlsParameters: transport.dtlsParameters,
  };
}

export async function connectTransport(
  ctx: MediaContext,
  transportId: string,
  dtlsParameters: types.DtlsParameters,
): Promise<void> {
  const transport = transportOrThrow(ctx, transportId);
  await transport.connect({ dtlsParameters });
}

export async function restartIce(
  ctx: MediaContext,
  transportId: string,
): Promise<{ iceParameters: types.IceParameters }> {
  return { iceParameters: await transportOrThrow(ctx, transportId).restartIce() };
}

/**
 * The client rebuilding its peer connection after a network handoff. Unknown is a no-op,
 * as everywhere a client releases something it may be racing.
 */
export function closeTransport(ctx: MediaContext, transportId: string): void {
  state?.registry.get(ctx.eventId)?.peer(ctx.socketId)?.closeTransport(transportId);
}

function transportOrThrow(ctx: MediaContext, transportId: string): types.WebRtcTransport {
  const transport = peerOrThrow(ctx).transportById(transportId);
  if (!transport) {
    throw new AppError('no_transport', 'No such transport on this session.');
  }
  return transport;
}

export interface ProduceInput {
  channelId: number;
  slug: string;
  rtpParameters: types.RtpParameters;
  paused: boolean;
}

/**
 * Going live is what takes the channel, and the decision is made before this function's
 * first `await`: two studios pressing Go live in the same tick are resolved by the order
 * they arrive in rather than by whichever produce finishes first.
 */
export async function produce(
  ctx: MediaContext,
  input: ProduceInput,
): Promise<{ producerId: string }> {
  const authorization = authorizeProduce(ctx, input.channelId);
  try {
    return await startProducer(ctx, input, authorization);
  } catch (cause) {
    if (authorization.claimTaken) {
      presence.releaseChannel(input.channelId);
    }
    throw cause;
  }
}

interface ProduceAuthorization {
  /** `incoming` is the handover case: the standing producer keeps carrying the channel. */
  mode: 'current' | 'incoming';
  studio: StudioSocket;
  granted: boolean;
  /** True only when this produce took a free channel, so a failure can give it back. */
  claimTaken: boolean;
}

function authorizeProduce(ctx: MediaContext, channelId: number): ProduceAuthorization {
  const sessionId = ctx.sessionId;
  if (!sessionId) {
    throw new AppError('not_speaker', 'This session may not broadcast.');
  }
  const studio: StudioSocket = {
    eventId: ctx.eventId,
    channelId,
    sessionId,
    socketId: ctx.socketId,
  };

  const grant = handover.view(channelId)?.grant ?? null;
  if (grant && grant.sessionId === sessionId) {
    const standing = state?.registry.get(ctx.eventId)?.producer(channelId);
    // A grant is permission to produce and nothing more: the claim moves when the swap
    // completes, so an interpreter who never produces leaves the live one exactly as live.
    const mode = standing && !standing.closed ? 'incoming' : 'current';
    return { mode, studio, granted: true, claimTaken: false };
  }

  const held = presence.claimOf(channelId);
  if (grant || (held && held.sessionId !== sessionId)) {
    throw new AppError('channel_taken', 'Somebody else is broadcasting on this channel.');
  }
  presence.take(studio);
  return { mode: 'current', studio, granted: false, claimTaken: held === undefined };
}

async function startProducer(
  ctx: MediaContext,
  input: ProduceInput,
  authorization: ProduceAuthorization,
): Promise<{ producerId: string }> {
  const room = await roomFor(ctx.eventId, true);
  const transport = room.peerFor(ctx.socketId).transport('send');
  if (!transport) {
    throw new AppError('no_transport', 'Create a send transport first.');
  }

  const producer = await transport.produce({
    kind: 'audio',
    rtpParameters: input.rtpParameters,
    paused: input.paused,
    appData: { channelId: input.channelId, slug: input.slug },
  });

  watchProducer(producer, ctx.eventId, input.slug);
  producer.observer.once('close', () => {
    if (isSilentClose(ctx.eventId, input.channelId, producer)) {
      clearSwap(input.channelId);
    } else {
      publishProducerClosed(ctx.eventId, input.channelId, input.slug, producer.appData);
    }
    // The room may now be idle; the grace timer decides whether the router survives.
    state?.registry.releaseIfIdle(ctx.eventId);
  });

  const outgoing = authorization.mode === 'incoming' ? room.producer(input.channelId) : undefined;
  if (outgoing) {
    room.setIncomingProducer(input.channelId, producer);
  } else {
    room.setProducer(input.channelId, producer);
  }
  if (authorization.granted) {
    handover.produced(authorization.studio);
  }
  if (outgoing) {
    openSwapWindow(ctx.eventId, input.channelId, input.slug, outgoing.id);
  } else if (authorization.granted) {
    // Nothing to swap away from, so the claim moves the moment the incoming voice is up.
    handover.complete(input.channelId);
  }

  notifications.publish({
    type: 'producer-opened',
    eventId: ctx.eventId,
    channelId: input.channelId,
    slug: input.slug,
  });
  if (outgoing) {
    // A channel nobody is consuming has nothing to wait for.
    settleSwap(input.channelId);
  }
  return { producerId: producer.id };
}

/**
 * A close no listener has a state for: the producer a swap replaced, and the incoming
 * producer of a window that ended without one. Neither was ever the channel's own, so
 * reporting either would be reporting an off-air the channel never had.
 */
function isSilentClose(eventId: number, channelId: number, producer: types.Producer): boolean {
  if ((producer.appData as { closeReason?: unknown }).closeReason === 'replaced') {
    return true;
  }
  return state?.registry.get(eventId)?.incomingProducer(channelId) === producer;
}

function publishProducerClosed(
  eventId: number,
  channelId: number,
  slug: string,
  appData: unknown,
): void {
  const closeReason = (appData as { closeReason?: unknown }).closeReason;
  if (closeReason === 'ended') {
    // A deliberate end closes every listener feedback episode for this broadcast.
    reports.forgetChannel(eventId, channelId);
    // And the audience it had: the next broadcast on this channel describes its own hour.
    listenerHistory.forgetChannel(eventId, channelId);
  }
  notifications.publish({
    type: 'producer-closed',
    eventId,
    channelId,
    slug,
    reason: closeReason === 'ended' ? 'ended' : 'dropped',
  });
}

// --- the swap window ----------------------------------------------------------

function openSwapWindow(
  eventId: number,
  channelId: number,
  slug: string,
  outgoingProducerId: string,
): void {
  clearSwap(channelId);
  const timer = setTimeout(() => promoteSwap(channelId), state?.swapDeadlineMs ?? SWAP_DEADLINE_MS);
  timer.unref?.();
  swaps.set(channelId, { eventId, channelId, slug, outgoingProducerId, timer });
}

function clearSwap(channelId: number): SwapWindow | undefined {
  const swap = swaps.get(channelId);
  if (swap) {
    clearTimeout(swap.timer);
    swaps.delete(channelId);
  }
  return swap;
}

/**
 * Every listener has left the outgoing producer, so the window has done its job. Called
 * whenever a consumer closes: a listener's swap is a new consumer on the incoming producer
 * followed by a close of the old one, so the close is what marks them across.
 */
function settleSwap(channelId: number): void {
  const swap = swaps.get(channelId);
  if (!swap) {
    return;
  }
  if ((state?.registry.get(swap.eventId)?.consumersOn(swap.outgoingProducerId) ?? 0) > 0) {
    return;
  }
  promoteSwap(channelId);
}

/** The incoming producer becomes the channel's, and only then does the claim move. */
function promoteSwap(channelId: number): void {
  const swap = clearSwap(channelId);
  if (!swap) {
    return;
  }
  state?.registry.get(swap.eventId)?.promoteIncoming(channelId);
  handover.complete(channelId);
  notifications.publish({
    type: 'producer-opened',
    eventId: swap.eventId,
    channelId,
    slug: swap.slug,
  });
  // Every listener that swapped is invisible to the count until it is recounted against
  // the producer they moved to.
  scheduleRecount(swap.eventId, channelId, swap.slug);
}

/**
 * A grant that ended without a swap: the granted studio disconnected, or never produced
 * before its deadline. Whatever the outgoing interpreter still has stays exactly as it was.
 */
function cancelSwap(cancellation: GrantCancellation): void {
  const { eventId, channelId } = cancellation;
  const swap = clearSwap(channelId);
  const room = state?.registry.get(eventId);
  room?.closeIncomingProducer(channelId);

  const slug = swap?.slug ?? room?.producerSlug(channelId) ?? '';
  const standing = room?.producer(channelId);
  if (standing && !standing.closed && !isAbandoned(standing)) {
    notifications.publish({ type: 'producer-opened', eventId, channelId, slug });
    return;
  }
  // What stands was kept alive only for a handover that is not going to happen, and the
  // interpreter behind it stopped speaking when they asked to leave.
  if (standing) {
    markClosing(standing, 'ended');
  }
  room?.closeProducer(channelId);
  presence.releaseChannel(channelId);
  state?.registry.releaseIfIdle(eventId);
}

/** A producer its own interpreter has already stopped speaking into. */
function markAbandoned(producer: types.Producer): void {
  (producer.appData as { abandoned?: boolean }).abandoned = true;
}

function isAbandoned(producer: types.Producer): boolean {
  return (producer.appData as { abandoned?: boolean }).abandoned === true;
}

export async function pauseProducer(
  ctx: MediaContext,
  channelId: number,
  producerId: string,
): Promise<void> {
  const { producer, slug } = producerWithSlugOrThrow(ctx, channelId, producerId);
  await producer.pause();
  notifications.publish({
    type: 'producer-paused',
    eventId: ctx.eventId,
    channelId,
    slug,
  });
}

export async function resumeProducer(
  ctx: MediaContext,
  channelId: number,
  producerId: string,
): Promise<void> {
  const { producer, slug } = producerWithSlugOrThrow(ctx, channelId, producerId);
  await producer.resume();
  notifications.publish({
    type: 'producer-resumed',
    eventId: ctx.eventId,
    channelId,
    slug,
  });
}

/**
 * End broadcast. With somebody waiting it is a handover rather than an end: the producer
 * stays standing and silent, so listeners keep their consumer until the incoming
 * interpreter is up.
 */
export async function closeProducer(
  ctx: MediaContext,
  channelId: number,
  producerId: string,
): Promise<void> {
  const producer = state?.registry.get(ctx.eventId)?.producer(channelId);
  // A close that finds nothing has already achieved what it asked for. Scoped to the
  // caller's own channel, so a wrong id can never reach somebody else's producer.
  if (!producer || producer.id !== producerId) {
    return;
  }
  // A granted handover owns the standing producer until the swap completes, whoever asks.
  if (handover.view(channelId)?.grant) {
    if (presence.claimOf(channelId)?.socketId === ctx.socketId) {
      // The holder has stopped speaking into it, so a grant that never produces must end
      // the broadcast rather than put this silent producer back on air.
      markAbandoned(producer);
    }
    return;
  }
  if (handover.departed({ eventId: ctx.eventId, channelId }, producer.id)) {
    markAbandoned(producer);
    return;
  }
  markClosing(producer, 'ended');
  producer.close();
  presence.releaseChannel(channelId);
}

export interface ConsumeInput {
  channelId: number;
  rtpCapabilities: types.RtpCapabilities;
}

export async function consume(
  ctx: MediaContext,
  input: ConsumeInput,
): Promise<{
  consumerId: string;
  producerId: string;
  kind: 'audio';
  rtpParameters: types.RtpParameters;
}> {
  const room = roomOrThrow(ctx.eventId);
  // The incoming producer during a swap window: a guest arriving mid-handover subscribes
  // to the voice that is staying rather than the one about to stop.
  const producer = room.targetProducer(input.channelId);
  if (!producer || producer.closed) {
    throw new AppError('not_live', 'Nobody is broadcasting on that channel.');
  }
  const peer = room.peerFor(ctx.socketId);
  const transport = peer.transport('recv');
  if (!transport) {
    throw new AppError('no_transport', 'Create a receive transport first.');
  }

  // A repeated consume of the same channel returns what this peer already holds. Left
  // uncapped, one PIN holder could fan a channel out as many times as they asked.
  const existing = peer.consumerForProducer(producer.id);
  if (existing) {
    return {
      consumerId: existing.id,
      producerId: producer.id,
      kind: 'audio',
      rtpParameters: existing.rtpParameters,
    };
  }

  if (
    !room.router.canConsume({ producerId: producer.id, rtpCapabilities: input.rtpCapabilities })
  ) {
    throw new AppError('incompatible_client', 'This device cannot play that audio.');
  }

  // Created paused because unpaused RTP races the client's decoder setup, which is the
  // most commonly reported cause of artefacts at join.
  const slug = room.producerSlug(input.channelId) ?? '';
  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: input.rtpCapabilities,
    paused: true,
    // The consumer carries its own channel, so a resume or a close can name the affected
    // channel without a reverse lookup through the room's producers.
    appData: { channelId: input.channelId, slug },
  });
  peer.addConsumer(consumer);
  // One hook covers stopping playback, a language switch, a disconnect, a peer eviction, a dead
  // worker and the producer closing alike: mediasoup closes the consumer for all of them.
  // Registered here and not on the early-return path above, which hands back a consumer
  // that already has one.
  consumer.observer.once('close', () => {
    scheduleRecount(ctx.eventId, input.channelId, slug);
    settleSwap(input.channelId);
  });

  return {
    consumerId: consumer.id,
    producerId: producer.id,
    kind: 'audio',
    rtpParameters: consumer.rtpParameters,
  };
}

export async function resumeConsumer(ctx: MediaContext, consumerId: string): Promise<void> {
  const consumer = peerOrThrow(ctx).consumerById(consumerId);
  if (!consumer) {
    throw new AppError('no_consumer', 'No such consumer on this session.');
  }
  await consumer.resume();
  // The other half of the count: a resume is the moment a guest starts hearing anything.
  const { channelId, slug } = consumerChannel(consumer);
  watchConsumer(consumer, ctx.eventId, slug);
  if (channelId !== undefined) {
    scheduleRecount(ctx.eventId, channelId, slug);
  }
}

function consumerChannel(consumer: types.Consumer): { channelId?: number; slug: string } {
  const appData = consumer.appData as { channelId?: unknown; slug?: unknown };
  return {
    channelId: typeof appData.channelId === 'number' ? appData.channelId : undefined,
    slug: typeof appData.slug === 'string' ? appData.slug : '',
  };
}

export async function closeConsumer(ctx: MediaContext, consumerId: string): Promise<void> {
  state?.registry.get(ctx.eventId)?.peer(ctx.socketId)?.closeConsumer(consumerId);
}

// --- revocation ---------------------------------------------------------------

/**
 * Channel-scoped: disabling or deleting a channel, or regenerating its speaker code. Every
 * studio on the channel is evicted and not only the one that was live — they all hold the
 * code that was just revoked, and one left sitting in pre-flight could otherwise still go
 * live on it. A listener's PIN is untouched and their consumer dies with the producer.
 */
export function revokeChannel(eventId: number, channelId: number, reason: EvictionReason): void {
  const room = state?.registry.get(eventId);
  clearSwap(channelId);
  room?.closeProducer(channelId);

  reports.forgetChannel(eventId, channelId);
  listenerHistory.forgetChannel(eventId, channelId);
  // Nothing can be waiting for a channel nobody may broadcast on any more.
  handover.forgetChannel(channelId);

  presence.releaseChannel(channelId);
  for (const studio of presence.studios(channelId)) {
    room?.closePeer(studio.socketId);
    notifications.publish({ type: 'peer-evicted', socketId: studio.socketId, reason });
  }
  state?.registry.releaseIfIdle(eventId);
}

/**
 * Event-scoped: disabling an event or regenerating its PIN. Published once as a room fact
 * rather than as one eviction per known peer, because `core/` can only name a socket it
 * registered — and a listener who owns no media is invisible here, which is exactly who a
 * regenerated PIN must remove.
 */
export function revokeEvent(eventId: number, channelIds: number[], reason: EvictionReason): void {
  for (const channelId of channelIds) {
    clearSwap(channelId);
    presence.releaseChannel(channelId);
    reports.forgetChannel(eventId, channelId);
  }
  listenerHistory.forgetEvent(eventId);
  state?.registry.closeEvent(eventId, 'revoked');
  notifications.publish({ type: 'room-evicted', eventId, reason });
}

/** The disconnect half: this socket's media goes, and nobody else's. */
export function releasePeer(eventId: number, socketId: string): void {
  state?.registry.get(eventId)?.closePeer(socketId);
  state?.registry.releaseIfIdle(eventId);
}

/** For the shutdown path and for tests that need to see what is still up. */
export function activeRooms(): Room[] {
  return state?.registry.all() ?? [];
}

// --- internals ----------------------------------------------------------------

async function roomFor(eventId: number, create: boolean): Promise<Room> {
  const { registry } = require_();
  const existing = registry.get(eventId);
  // Reuse cancels the grace timer too. Only getOrCreate used to, so a speaker returning
  // late in the grace period could be handed capabilities on a router about to close.
  if (existing) {
    keepAlive(eventId);
    return existing;
  }
  if (!create) {
    throw new AppError('not_live', 'Nobody is broadcasting on this event.');
  }
  return registry.getOrCreate(eventId);
}

function roomOrThrow(eventId: number): Room {
  const room = require_().registry.get(eventId);
  if (!room) {
    throw new AppError('not_live', 'Nobody is broadcasting on this event.');
  }
  keepAlive(eventId);
  return room;
}

function peerOrThrow(ctx: MediaContext) {
  const peer = roomOrThrow(ctx.eventId).peer(ctx.socketId);
  if (!peer) {
    throw new AppError('no_transport', 'This session holds no media.');
  }
  return peer;
}

/**
 * Looked up by the caller's own channel and only then matched on id, never by id across
 * the event: the id is public to every listener the moment they consume.
 */
function producerWithSlugOrThrow(
  ctx: MediaContext,
  channelId: number,
  producerId: string,
): { producer: types.Producer; slug: string } {
  const room = roomOrThrow(ctx.eventId);
  const producer = room.producerById(channelId, producerId);
  if (!producer) {
    throw new AppError('no_producer', 'No such producer on this channel.');
  }
  return { producer, slug: room.producerSlug(channelId) ?? '' };
}

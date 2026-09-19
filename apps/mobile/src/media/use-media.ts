import type { MediaHealth } from '@linguacast/client-core/media';
import {
  afterConnect,
  beginRebuild,
  consumerClosed,
  consumerOpened,
  iceRecoveryDelay,
  iceRecoveryStep,
  initialMediaState,
  isCurrent,
  type MediaState,
  type MediaStats,
  type StatsSample,
  signalling,
  summarise,
  type TransportConnectionState,
  type TransportDirection,
  transportOpened,
} from '@linguacast/client-core/media';
import type { SocketClient } from '@linguacast/client-core/socket';
import type { types } from 'mediasoup-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionTick } from '@/audio/use-session-tick';
import { logError } from '../log';
import { loadDevice } from './device';
import { logIceRecovery, reportTransportPath, watchConsumerTrack } from './diagnostics';
import { dueDeadlines, stalledSteps } from './ice-clock';
import { inboundEntry } from './stats-entry';
import { openTransport } from './transport';

/**
 * A reset landed while this call was in flight, so its answer is stale. An expected
 * outcome of a reconnect race, not a failure — callers swallow it and let the reset's own
 * renegotiation take over.
 */
export const SUPERSEDED = 'superseded';

export function isSuperseded(error: unknown): boolean {
  return error instanceof Error && error.message === SUPERSEDED;
}

interface Session {
  device: types.Device;
  iceServers: RTCIceServer[];
  transports: Partial<Record<TransportDirection, types.Transport>>;
  consumers: Map<string, types.Consumer>;
  /**
   * Everything below is an in-flight guard. Each of these spans a round trip, and an
   * effect can re-enter during it — so without them two callers both see "nothing yet"
   * and both allocate, and the loser is a resource nothing can name again.
   */
  pendingTransports: Partial<Record<TransportDirection, Promise<types.Transport>>>;
  pendingIceRestarts: Partial<Record<TransportDirection, Promise<void>>>;
  /**
   * Per direction rather than per transport, and cleared only by a transport reaching
   * connected: a rebuild hands the direction a brand new transport, so a per-transport
   * count would restart the ladder every time and rebuild forever.
   */
  iceRecoveryAttempts: Partial<Record<TransportDirection, number>>;
  iceRecoveryTimers: Partial<Record<TransportDirection, ReturnType<typeof setTimeout>>>;
  /**
   * The same deadline as the timer above, as an absolute time the heartbeat can read. The
   * timer is the precise clock while the app is visible; behind a locked screen React Native
   * stops servicing it, and this is what the session's native tick runs instead.
   */
  iceRecoveryDue: Partial<Record<TransportDirection, { at: number; run: () => void }>>;
  /**
   * When the recovery step in flight began. Every step is a signalling round trip, and its
   * deadline is Socket.IO's own ack timer — which is a JavaScript timer, and so is the
   * heartbeat that would have told the socket its transport is gone. Behind a locked screen
   * a socket can therefore go on reporting itself connected over a network that no longer
   * exists, and the ladder waits on an answer that will never come.
   */
  iceRecoveryStartedAt: Partial<Record<TransportDirection, number>>;
  /**
   * Whether this direction has ever reached connected, for the same reason the attempt
   * count lives here: a rebuilt transport has no first gather to protect, and reading the
   * fact off the transport would hand every rebuild the long first-gather deadline.
   */
  iceConnectedOnce: Partial<Record<TransportDirection, boolean>>;
  /**
   * Keyed with the generation it began in. A rebuild bumps that, so a consume started
   * against the discarded transport is no longer a valid answer for the replacement — and
   * dropping the entry outright would let a second consume negotiate on the same transport
   * while the first is still in flight, which is what `SessionDescription is NULL` is.
   */
  pendingConsumers: Map<string, { generation: number; promise: Promise<MediaStreamTrack> }>;
}

/**
 * The shell around the platform's WebRTC APIs. Every decision it makes comes from the
 * shared media state; what lives here is the calls that need a real `RTCPeerConnection`
 * and cannot be tested without one. Receive-only: this app has no producer path.
 *
 * One session per socket connection. `connect` discards it wholesale rather than
 * reconciling — the server persists nothing, so a reconnection and a server restart are
 * the same event from here, and one path serves both.
 */
export function useMedia(socket: SocketClient | null) {
  const [state, setState] = useState<MediaState>(initialMediaState);
  /**
   * The Producer each open consumer receives, by slug. Held beside the consumer ids rather
   * than inside `MediaState` because it is the listener's half alone: it is what lets a
   * Producer replaced mid-broadcast be told apart from the one already playing.
   */
  const [consumedProducers, setConsumedProducers] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<MediaHealth>('idle');
  /**
   * The ladder's candidates never paired, so this direction is not going to recover on its
   * own. The web client answers this by reloading the document, because Chromium keeps one
   * network view per page; React Native has no such scope and a fresh peer connection
   * re-enumerates interfaces, so what is offered here is a session restart instead.
   */
  const [restartRecommended, setRestartRecommended] = useState(false);
  const [stats, setStats] = useState<MediaStats | null>(null);
  // The counters are cumulative, so the grade is a delta against the previous sample.
  const previousSample = useRef<StatsSample | null>(null);
  const session = useRef<Session | null>(null);
  const pendingSession = useRef<Promise<Session> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const releaseSession = useCallback(() => {
    const current = session.current;
    session.current = null;
    pendingSession.current = null;
    if (!current) {
      return;
    }
    // One release path: a partial teardown leaks a transport nothing will ever name again.
    for (const consumer of current.consumers.values()) {
      consumer.close();
    }
    for (const timer of Object.values(current.iceRecoveryTimers)) {
      clearTimeout(timer);
    }
    current.iceRecoveryDue = {};
    for (const transport of Object.values(current.transports)) {
      transport?.close();
    }
  }, []);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const reset = () => {
      releaseSession();
      setState(afterConnect);
      setConsumedProducers({});
      setHealth('connecting');
      setRestartRecommended(false);
      previousSample.current = null;
    };

    socket.on('connect', reset);
    socket.on('media:reset', reset);

    return () => {
      socket.off('connect', reset);
      socket.off('media:reset', reset);
      releaseSession();
      setState(initialMediaState);
      setConsumedProducers({});
      setHealth('idle');
      setRestartRecommended(false);
      setStats(null);
    };
  }, [socket, releaseSession]);

  /**
   * Polled rather than pushed: WebRTC has no event for "the line got worse", and the
   * figures are cumulative anyway, so a sample on an interval is the shape they come in.
   */
  useEffect(() => {
    if (!state.recvTransportId) {
      setStats(null);
      previousSample.current = null;
      return;
    }

    const sample = async () => {
      const transport = session.current?.transports.recv;
      if (!transport || transport.closed) {
        return;
      }

      const report = await transport.getStats().catch(() => null);
      if (!report) {
        return;
      }

      const current = inboundEntry(report.values());
      if (!current) {
        return;
      }

      const summary = summarise(current, previousSample.current ?? undefined);
      previousSample.current = current;
      if (summary) {
        setStats(summary);
      }
    };

    void sample();
    const timer = setInterval(() => void sample(), STATS_POLL_MS);
    return () => clearInterval(timer);
  }, [state.recvTransportId]);

  /**
   * The heartbeat's half of the ladder. Every step's timer is armed with `setTimeout`, which
   * Android stops servicing behind a locked screen — which is where a network change is most
   * likely to happen and least likely to be noticed. A deadline that has passed runs here
   * instead, on a clock the platform keeps.
   */
  useSessionTick(() => {
    const active = session.current;
    if (!active) {
      return;
    }

    const now = Date.now();

    // A step whose answer is this overdue is a step waiting on a socket that has not
    // noticed its own transport is gone: the ack deadline and the heartbeat that would
    // have told it are both JavaScript timers. Cycling the connection is what makes the
    // loss real, and its `connect` renegotiates the whole session from nothing.
    // A transport the browser has already declared dead is not waiting on a slow server, so
    // the generous bound buys nothing there and costs a listener ten seconds of silence.
    const failed = active.transports.recv?.connectionState === 'failed';
    const limit = failed ? FAILED_STEP_MS : STALLED_STEP_MS;

    if (socket && stalledSteps(active.iceRecoveryStartedAt, now, limit) > 0) {
      logIceRecovery('a recovery step went unanswered — cycling the connection');
      active.iceRecoveryStartedAt = {};
      socket.disconnect();
      socket.connect();
      return;
    }

    for (const due of dueDeadlines(active.iceRecoveryDue, now)) {
      due.run();
    }
  });

  const ensureSession = useCallback(async (): Promise<Session> => {
    if (session.current) {
      return session.current;
    }
    if (pendingSession.current) {
      return pendingSession.current;
    }
    if (!socket) {
      throw new Error('No socket.');
    }

    const loading = loadDevice(signalling(socket))
      .then(({ device, iceServers }) => {
        const created: Session = {
          device,
          iceServers,
          transports: {},
          consumers: new Map(),
          pendingTransports: {},
          pendingIceRestarts: {},
          iceRecoveryAttempts: {},
          iceRecoveryTimers: {},
          iceRecoveryDue: {},
          iceRecoveryStartedAt: {},
          iceConnectedOnce: {},
          pendingConsumers: new Map(),
        };
        session.current = created;
        setState((prev) => ({ ...prev, deviceLoaded: true }));
        return created;
      })
      .finally(() => {
        pendingSession.current = null;
      });

    pendingSession.current = loading;
    return loading;
  }, [socket]);

  const ensureTransport = useCallback(async (): Promise<types.Transport> => {
    const direction: TransportDirection = 'recv';
    const active = await ensureSession();
    const existing = active.transports[direction];
    if (existing && !existing.closed) {
      return existing;
    }

    const inFlight = active.pendingTransports[direction];
    if (inFlight) {
      return inFlight;
    }

    if (!socket) {
      throw new Error('No socket.');
    }
    const generation = stateRef.current.generation;
    const opening = openTransport({
      api: signalling(socket),
      device: active.device,
      iceServers: active.iceServers,
      onCandidateAddressFamilyMismatch: () => {
        if (session.current === active) {
          setRestartRecommended(true);
        }
      },
    });
    // Cleared where the transport is adopted, never on settle: between `openTransport`
    // resolving and `transports[direction]` being written, a concurrent caller would
    // otherwise find neither the pending promise nor the transport and ask the server for a
    // second one, which its one-per-direction cap refuses as `transport_exists`.
    active.pendingTransports[direction] = opening.catch((cause) => {
      delete active.pendingTransports[direction];
      throw cause;
    });
    const transport = await opening;

    // A connect that landed while this was in flight already voided it. Adopting the
    // answer now would hand back a transport the server no longer knows about.
    if (!isCurrent(stateRef.current, generation) || session.current !== active) {
      delete active.pendingTransports[direction];
      transport.close();
      throw new Error(SUPERSEDED);
    }

    let gaveUp = false;

    /**
     * A restart re-gathers on the peer connection this transport already owns. When that
     * connection is the problem, only replacing it helps — so the transport is dropped
     * on both sides and the effects that wanted media open a fresh one.
     */
    const rebuild = async (): Promise<void> => {
      logIceRecovery(`still ${transport.connectionState} — rebuilding the transport`);
      transport.close();
      if (active.transports[direction] === transport) {
        delete active.transports[direction];
      }
      active.consumers.clear();
      try {
        // Only over a live socket. The ack deadline is a JavaScript timer, so behind a
        // locked screen a call made over a dropped connection neither answers nor times
        // out, and the rebuild waits on it for as long as the guest leaves the phone in a
        // pocket. A reconnect voids the server's peer state wholesale, so there is nothing
        // left to release in that case anyway.
        //
        // Before the state that re-opens it, not after: the server permits one transport
        // per direction, so an effect reaching `createTransport` while it still holds this
        // one is refused with `transport_exists` and the rebuild dies there.
        if (socket.connected) {
          await signalling(socket).closeTransport(transport.id);
        }
      } catch (cause) {
        // The local transport is already closed, so a direction left holding its id here
        // would never reopen and never reach `failed` — no replacement, and no Reconnect
        // offered either. A refused `createTransport` is at least loud and retryable, and
        // a socket that never comes back voids this state wholesale on its next connect.
        logError('media: could not release the transport server-side', cause);
      } finally {
        // A reconnect landing mid-rebuild has already replaced this session; bumping the
        // generation now would date out the replacement's own transport instead.
        if (session.current === active) {
          // Renegotiating, not in trouble. Left at `trouble` the link reads as down,
          // `online` is false, and the effects that would open the replacement decline to —
          // the rebuild would tear the transport down and nothing would ever ask for
          // another.
          setHealth('connecting');
          setState((prev) => beginRebuild(prev, direction));
          setConsumedProducers({});
        }
      }
    };

    const armIceRecovery = (next: TransportConnectionState): void => {
      const armed = active.iceRecoveryTimers[direction];
      if (armed !== undefined) {
        clearTimeout(armed);
        delete active.iceRecoveryTimers[direction];
      }
      delete active.iceRecoveryDue[direction];
      if (session.current !== active || transport.closed) {
        return;
      }
      const attempts = active.iceRecoveryAttempts[direction] ?? 0;
      const connectedOnce = active.iceConnectedOnce[direction] ?? false;
      const delay = iceRecoveryDelay(next, attempts, connectedOnce);
      if (delay === null) {
        if (next === 'connected') {
          // The path this direction was fighting for is up; a later handoff starts over.
          active.iceRecoveryAttempts[direction] = 0;
          active.iceConnectedOnce[direction] = true;
          setHealth('connected');
          setRestartRecommended(false);
          return;
        }
        if (iceRecoveryStep(attempts, next) === 'give-up') {
          setHealth('failed');
          // The ladder is spent whatever the diagnosis. Offered here as well as on the
          // address-family mismatch, or a give-up nobody could name leaves the screen with
          // a dead link and nothing to press — and React Native has no document to reload.
          if (session.current === active) {
            setRestartRecommended(true);
          }
        } else {
          setHealth('trouble');
        }
        if (iceRecoveryStep(attempts, next) === 'give-up' && !gaveUp) {
          gaveUp = true;
          logIceRecovery(
            `gave up after ${attempts} recovery attempts, still ${next}. ` +
              'Neither a restart nor a rebuild found a candidate the browser and the ' +
              'server can pair — an address family or a port neither side shares.',
          );
        }
        return;
      }

      if (active.pendingIceRestarts[direction]) {
        setHealth('trouble');
        return;
      }
      setHealth(next === 'failed' || attempts > 0 ? 'trouble' : 'connecting');

      const runRecoveryStep = () => {
        // Cleared rather than only forgotten: whichever clock got here first, the other one
        // is still armed for the same step and would run it a second time.
        const pending = active.iceRecoveryTimers[direction];
        if (pending !== undefined) {
          clearTimeout(pending);
        }
        delete active.iceRecoveryTimers[direction];
        delete active.iceRecoveryDue[direction];
        if (session.current !== active || transport.closed) {
          return;
        }

        setHealth('trouble');
        const taken = active.iceRecoveryAttempts[direction] ?? 0;
        const step = iceRecoveryStep(taken, next);
        const attempt = taken + 1;
        active.iceRecoveryAttempts[direction] = attempt;

        active.iceRecoveryStartedAt[direction] = Date.now();

        const restart = (async () => {
          // Snapshot before either recovery, not after: what ICE was working with is the
          // question, and a fresh attempt has not had time to nominate anything.
          await reportTransportPath(transport);
          if (step === 'rebuild') {
            await rebuild();
            return;
          }
          logIceRecovery(
            `stuck in ${transport.connectionState} — restarting ICE (attempt ${attempt})`,
          );
          const { iceParameters } = await signalling(socket).restartIce(transport.id);
          const connectionState = transport.connectionState as TransportConnectionState;
          if (
            session.current !== active ||
            transport.closed ||
            connectionState === 'connected' ||
            connectionState === 'closed'
          ) {
            throw new Error(SUPERSEDED);
          }
          await transport.restartIce({ iceParameters });
          logIceRecovery(`ICE restart ${attempt} applied, now ${transport.connectionState}`);
        })();
        active.pendingIceRestarts[direction] = restart;
        void restart
          .catch((cause) => {
            if (session.current === active && !transport.closed && !isSuperseded(cause)) {
              logError(`media: could not recover the transport (attempt ${attempt})`, cause);
            }
          })
          .finally(() => {
            if (active.pendingIceRestarts[direction] === restart) {
              delete active.pendingIceRestarts[direction];
              delete active.iceRecoveryStartedAt[direction];
            }
            if (session.current === active && !transport.closed) {
              armIceRecovery(transport.connectionState as TransportConnectionState);
            }
          });
      };

      // React Native pauses JavaScript timers while the app is not visible on Android, so a
      // deadline armed behind a locked screen fires when the guest unlocks the phone rather
      // than when it is due — which is the one moment this recovery exists for. Native
      // events still arrive, and `failed` is one the browser raises on its own, so the step
      // that needs no wait runs on the event itself instead of through a timer.
      if (delay === 0) {
        runRecoveryStep();
        return;
      }

      // Both clocks, because neither covers the other: the timer is precise while the app
      // is visible, and the deadline is what the session's heartbeat reads when it is not.
      active.iceRecoveryDue[direction] = { at: Date.now() + delay, run: runRecoveryStep };
      active.iceRecoveryTimers[direction] = setTimeout(runRecoveryStep, delay);
    };

    transport.on('connectionstatechange', armIceRecovery);

    active.transports[direction] = transport;
    delete active.pendingTransports[direction];
    setState((prev) => transportOpened(prev, direction, transport.id));
    armIceRecovery(transport.connectionState as TransportConnectionState);
    return transport;
  }, [ensureSession, socket]);

  /**
   * One in-flight consume per channel, per generation. Both callers re-enter while the first
   * is still awaiting: the effect driving them depends on the consumers map, which a close
   * mutates synchronously. An entry from an older generation is not an answer to this
   * request and is left to fail on its own guards rather than being adopted or cancelled.
   */
  const trackPending = useCallback(
    (
      slug: string,
      generation: number,
      start: () => Promise<MediaStreamTrack>,
    ): Promise<MediaStreamTrack> => {
      const started = session.current?.pendingConsumers.get(slug);
      if (started && started.generation === generation) {
        return started.promise;
      }

      const pending = start();
      const active = session.current;
      if (active) {
        active.pendingConsumers.set(slug, { generation, promise: pending });
        void pending
          .catch(() => {})
          .finally(() => {
            // Only its own entry: a newer generation's consume may already have taken the
            // slot, and clearing that one would leave the map lying about what is in flight.
            if (
              session.current === active &&
              active.pendingConsumers.get(slug)?.promise === pending
            ) {
              active.pendingConsumers.delete(slug);
            }
          });
      }
      return pending;
    },
    [],
  );

  /** The negotiation both a first consume and a swap share; the consumer arrives paused. */
  const negotiateConsumer = useCallback(
    async (
      slug: string,
      active: Session,
      transport: types.Transport,
      api: ReturnType<typeof signalling>,
      generation: number,
      stillWanted: () => boolean,
    ): Promise<{ consumer: types.Consumer; producerId: string }> => {
      const params = await api.consume(slug, active.device.rtpCapabilities);

      // A rebuild or a socket connect landed while the server was answering, so this
      // transport is already closed. Negotiating against it surfaces as
      // `SessionDescription is NULL` — a native error nothing above can act on, reported
      // to a guest whose audio the replacement transport is about to recover anyway.
      if (
        session.current !== active ||
        active.transports.recv !== transport ||
        transport.closed ||
        !isCurrent(stateRef.current, generation) ||
        !stillWanted()
      ) {
        throw new Error(SUPERSEDED);
      }

      const consumer = await transport.consume({
        id: params.consumerId,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      // The same race, one await later: a consumer adopted onto a discarded transport is
      // one nothing will close.
      if (session.current !== active || active.transports.recv !== transport || !stillWanted()) {
        consumer.close();
        throw new Error(SUPERSEDED);
      }
      return { consumer, producerId: params.producerId };
    },
    [],
  );

  const startConsuming = useCallback(
    (slug: string): Promise<MediaStreamTrack> => {
      // Snapshotted before anything is awaited, so a consume that began before a rebuild
      // carries the generation it began in rather than the one it wakes up into.
      const generation = stateRef.current.generation;
      return trackPending(slug, generation, async () => {
        const transport = await ensureTransport();
        const active = session.current;
        if (!socket || !active) {
          throw new Error(SUPERSEDED);
        }

        const api = signalling(socket);
        const { consumer, producerId } = await negotiateConsumer(
          slug,
          active,
          transport,
          api,
          generation,
          () => true,
        );

        active.consumers.set(slug, consumer);
        setState((prev) => consumerOpened(prev, slug, consumer.id));
        setConsumedProducers((prev) => ({ ...prev, [slug]: producerId }));

        watchConsumerTrack(consumer.track, slug);

        // Resumed only once the track is in hand, per the server creating it paused: RTP
        // arriving before the decoder is ready is the usual cause of artefacts at join.
        await api.resumeConsumer(consumer.id);
        return consumer.track;
      });
    },
    [ensureTransport, negotiateConsumer, socket, trackPending],
  );

  const stopConsuming = useCallback(
    async (slug: string) => {
      const active = session.current;
      const consumer = active?.consumers.get(slug);
      if (!active || !consumer || !socket) {
        return;
      }
      active.consumers.delete(slug);
      consumer.close();
      setState((prev) => consumerClosed(prev, slug));
      setConsumedProducers((prev) => {
        const { [slug]: _gone, ...rest } = prev;
        return rest;
      });
      await signalling(socket).closeConsumer(consumer.id);
    },
    [socket],
  );

  /**
   * Moves a channel's audio from one Producer to its replacement without a gap. The incoming
   * consumer is negotiated and left paused beside the one still playing — the server creates
   * every consumer paused — and only the step that resumes it closes the outgoing one, so a
   * guest is never subscribed to two voices and never hears silence between them.
   */
  const swapConsumer = useCallback(
    (slug: string, outgoing: string): Promise<MediaStreamTrack> => {
      const generation = stateRef.current.generation;
      return trackPending(slug, generation, async () => {
        const transport = await ensureTransport();
        const active = session.current;
        if (!socket || !active) {
          throw new Error(SUPERSEDED);
        }
        const previous = active.consumers.get(slug);
        if (!previous || previous.id !== outgoing) {
          throw new Error(SUPERSEDED);
        }
        // The outgoing consumer going away takes the swap with it: there is nothing left to
        // move off, and the replacement would be adopted onto a channel nobody is on.
        const stillSwapping = () => active.consumers.get(slug) === previous;

        const api = signalling(socket);
        const { consumer, producerId } = await negotiateConsumer(
          slug,
          active,
          transport,
          api,
          generation,
          stillSwapping,
        );

        watchConsumerTrack(consumer.track, slug);
        await api.resumeConsumer(consumer.id);
        // Re-checked after the resume: a stop landing during it means the guest wants no
        // audio at all, and adopting the replacement now would start some.
        if (session.current !== active || !stillSwapping()) {
          consumer.close();
          void api.closeConsumer(consumer.id).catch(() => {});
          throw new Error(SUPERSEDED);
        }

        active.consumers.set(slug, consumer);
        previous.close();
        setState((prev) => consumerOpened(prev, slug, consumer.id));
        setConsumedProducers((prev) => ({ ...prev, [slug]: producerId }));
        // Fire and forget: the swap has already succeeded here, and reporting a failed
        // release through this promise would name it a failed listen.
        void api
          .closeConsumer(outgoing)
          .catch((cause) => logError('media: could not release the replaced consumer', cause));
        return consumer.track;
      });
    },
    [ensureTransport, negotiateConsumer, socket, trackPending],
  );

  /**
   * Throws away every held identifier and renegotiates from capabilities. The socket is
   * cycled with it, because a reconnect is what the whole media layer treats as its reset:
   * the server persists nothing, so one path serves this and a server restart alike.
   */
  const restartSession = useCallback(() => {
    releaseSession();
    setRestartRecommended(false);
    socket?.disconnect();
    socket?.connect();
  }, [releaseSession, socket]);

  return {
    state,
    consumedProducers,
    health,
    restartRecommended,
    stats,
    startConsuming,
    stopConsuming,
    swapConsumer,
    restartSession,
    release: releaseSession,
  };
}

/** Often enough that a line going bad shows up within a sentence, cheap enough to ignore. */
const STATS_POLL_MS = 2_000;

/**
 * How long a recovery step may go unanswered before the connection carrying it is treated as
 * dead. Above Socket.IO's own 10s ack deadline, so a socket whose timers are running still
 * reports the failure itself and this never fires over a merely slow server.
 */
const STALLED_STEP_MS = 12_000;

/** The same judgement over a path the browser has already given up on. */
const FAILED_STEP_MS = 3_000;

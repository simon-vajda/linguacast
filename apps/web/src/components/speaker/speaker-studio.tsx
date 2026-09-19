import type {
  AnchoredListenerPoint,
  AnchoredResolution,
  AnchoredRow,
} from '@linguacast/client-core/channel';
import {
  type ChannelStatusEntry,
  rollbackMutedAfterFailure,
} from '@linguacast/client-core/channel';
import { isLinkUp, resolveLinkState } from '@linguacast/client-core/media';
import type { AnchoredHandover, SocketClient, SocketStatus } from '@linguacast/client-core/socket';
import type { components } from '@linguacast/contract/openapi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SpeakerDisplaced } from '@/components/speaker/speaker-displaced';
import { SpeakerOnAir } from '@/components/speaker/speaker-on-air';
import { SpeakerPreflight } from '@/components/speaker/speaker-preflight';
import { levelStatus, meterLevel, rms } from '@/lib/audio/level';
import { useAudioPreferences } from '@/lib/audio/use-audio-preferences';
import { useMicCapture } from '@/lib/audio/use-mic-capture';
import { logError } from '@/lib/log';
import { isSuperseded, useMedia } from '@/lib/media/use-media';
import {
  type BroadcastEnd,
  broadcastState,
  hasLostClaim,
  isClaimMoved,
  isHandingOver,
  LINK_DROP_GRACE_MS,
  onReconnect,
  preflightAction,
} from './speaker-studio-state';

type PublicChannel = components['schemas']['PublicChannel'];

// The go-live gate is a one-way latch, not a meter, so it polls rather than reading per frame.
const SIGNAL_POLL_MS = 200;

/**
 * On air means a producer exists, never that the button was pressed: the badge must not
 * claim anyone is hearing this microphone before the server has the audio.
 */
export function SpeakerStudio({
  eventName,
  pin,
  channel,
  speakerCode,
  listeners,
  listenerHistory,
  reports,
  reportResolution,
  reportsKnown,
  socket,
  status,
  hasConnected,
  channelStatus,
  handover,
  handoverKnown,
  onRequestHandover,
  onCancelHandover,
  onConfirmHandover,
  onTakeOver,
}: {
  eventName: string;
  pin: string;
  channel: PublicChannel;
  speakerCode: string;
  /** Guests currently receiving this channel's audio. */
  listeners: number;
  /** This channel's recent counts, or undefined while none has been sent to this studio. */
  listenerHistory: AnchoredListenerPoint[] | undefined;
  reports: AnchoredRow[];
  reportResolution: AnchoredResolution | null;
  /** False until the connect-time tally lands; the panel withholds rather than claiming. */
  reportsKnown: boolean;
  socket: SocketClient | null;
  status: SocketStatus;
  hasConnected: boolean;
  /** Current Socket.IO snapshot; REST deliberately carries liveness only. */
  channelStatus: ChannelStatusEntry | undefined;
  /** This channel's handover snapshot, seen from this studio. */
  handover: AnchoredHandover | undefined;
  /** False until the connect-time snapshot lands; the screen withholds rather than guessing. */
  handoverKnown: boolean;
  onRequestHandover: () => Promise<void>;
  onCancelHandover: () => Promise<void>;
  onConfirmHandover: () => Promise<void>;
  onTakeOver: () => Promise<void>;
}) {
  const [goLivePressed, setGoLivePressed] = useState(false);
  // Used before the first server snapshot and while recovering from a rejected control.
  const [localMuted, setLocalMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [displaced, setDisplaced] = useState(false);
  const [lastEnd, setLastEnd] = useState<BroadcastEnd | null>(null);
  // This studio's own confirm or forced departure, covering the gap before the server
  // answers; the snapshot takes over as soon as one arrives.
  const [confirmedHandover, setConfirmedHandover] = useState(false);
  const [handoverBusy, setHandoverBusy] = useState(false);
  const [handoverFailed, setHandoverFailed] = useState(false);
  // Latest state applied to the local producer. Unlike the server snapshot, this updates
  // synchronously when the interpreter clicks, so a drop cannot record the previous state.
  const effectiveMutedRef = useRef(false);

  const setEffectiveMuted = useCallback((muted: boolean) => {
    effectiveMutedRef.current = muted;
    setLocalMuted(muted);
  }, []);

  const { preferences, setPreferences } = useAudioPreferences();
  const mic = useMicCapture(preferences);
  const media = useMedia(socket);
  const link = resolveLinkState({
    socketStatus: status,
    hasConnected,
    mediaHealth: media.health,
    stats: media.stats,
    // True from the press onwards: the studio only shows the line once it is broadcasting.
    mediaWanted: goLivePressed || media.state.producerId !== null,
  });
  const channelStatusRef = useRef(channelStatus);
  channelStatusRef.current = channelStatus;

  const hasProducer = media.state.producerId !== null;
  // The server snapshot wins only while the link is up. A snapshot that arrived before the
  // socket dropped describes a channel nobody is updating any more, and preferring it would
  // hide the interpreter's own mute back behind a stale `On air` — the one thing they pressed
  // the target to stop.
  const isMuted =
    isLinkUp(link) && channelStatus?.online && channelStatus.muted !== null
      ? channelStatus.muted
      : localMuted;
  const handingOver = isHandingOver({
    handoverKnown,
    handover,
    confirmed: confirmedHandover,
  });
  const state = broadcastState({
    goLivePressed,
    hasProducer,
    isMuted,
    handingOver,
    displaced,
  });

  const outputTrack = mic.outputTrack;
  // Destructured, not the whole hook result: `media` is a fresh object every render, so
  // closing over it would churn this callback's identity and re-fire the effect below on
  // every render rather than when its guards actually change.
  const { startProducing, replaceProducerTrack, abandonProducer } = media;
  // What the producer is currently transmitting, so a capture rebuild is detectable.
  const producedTrack = useRef<MediaStreamTrack | null>(null);

  /**
   * Where a studio lands when the claim has moved rather than when the broadcast ended:
   * the successor owns the Producer by then, so it is dropped locally and never closed
   * server-side, and the screen goes back to pre-flight instead of the terminal one.
   */
  const returnToPreflight = useCallback(() => {
    abandonProducer();
    producedTrack.current = null;
    setGoLivePressed(false);
    setConfirmedHandover(false);
    setHandoverFailed(false);
    setEffectiveMuted(false);
    setStartedAt(null);
    setLastEnd(null);
  }, [abandonProducer, setEffectiveMuted]);

  const produce = useCallback(
    async (paused: boolean) => {
      if (!outputTrack) {
        return;
      }
      try {
        await startProducing(channel.slug, outputTrack, paused);
        producedTrack.current = outputTrack;
      } catch (cause) {
        // The channel moved on while this was in flight, so there is nothing to retry here.
        if (isClaimMoved(cause)) {
          returnToPreflight();
          return;
        }
        // A reset landed mid-negotiation; its own renegotiation takes over from here.
        if (!isSuperseded(cause)) {
          logError('media: could not go live', cause);
        }
      }
    },
    [startProducing, outputTrack, channel.slug, returnToPreflight],
  );

  /**
   * Anything that re-opens the microphone rebuilds the capture graph and closes the
   * AudioContext the previous track belonged to. Left alone, the producer keeps that dead
   * track and the channel stays live while transmitting silence — so the new track is
   * swapped in. Covers a deliberate device change, an unplugged microphone falling back to
   * the default, and a noise-suppression, auto-gain or echo-cancellation toggle, which the
   * browser will only honour on a fresh `getUserMedia`.
   */
  useEffect(() => {
    if (!hasProducer || !outputTrack) {
      return;
    }
    if (producedTrack.current === outputTrack) {
      return;
    }

    producedTrack.current = outputTrack;
    void replaceProducerTrack(outputTrack).catch((cause) => {
      logError('media: could not switch microphone', cause);
    });
  }, [hasProducer, outputTrack, replaceProducerTrack]);

  /**
   * The server ends a session by disconnecting it, and Socket.IO does not reconnect after
   * one. Reaching this means the channel is no longer ours — another device took the
   * speaker link, or the code behind it was regenerated.
   */
  useEffect(() => {
    if (!socket) {
      return;
    }
    const onDisconnect = (reason: string) => {
      if (reason === 'io server disconnect') {
        setDisplaced(true);
      }
    };
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('disconnect', onDisconnect);
    };
  }, [socket]);

  const { stopProducing } = media;
  const endBroadcast = useCallback(
    (reason: BroadcastEnd) => {
      setLastEnd(reason);
      setGoLivePressed(false);
      setEffectiveMuted(false);
      setStartedAt(null);
      void stopProducing().catch(() => {
        // The producer is closed locally either way; the server drops it with the socket.
      });
    },
    [setEffectiveMuted, stopProducing],
  );

  /**
   * An outage the client cannot recover inside the grace window is the channel going
   * offline, not a longer wait: the studio returns to pre-flight rather than showing
   * `Reconnecting…` over a broadcast nobody is receiving.
   */
  const linkUp = isLinkUp(link);
  useEffect(() => {
    if (!goLivePressed || linkUp || displaced) {
      return;
    }
    const timer = setTimeout(() => endBroadcast({ reason: 'deliberate' }), LINK_DROP_GRACE_MS);
    return () => clearTimeout(timer);
  }, [goLivePressed, linkUp, displaced, endBroadcast]);

  const goLivePressedRef = useRef(goLivePressed);
  goLivePressedRef.current = goLivePressed;

  /**
   * A reset takes the producer without taking the socket, so the drop below never sees a
   * `lost` status and the broadcast would sit silent until somebody pressed Go live again.
   * Recording it here is what makes `media:reset` recoverable rather than terminal — which
   * is the whole reason the server prefers it to a disconnect.
   */
  useEffect(() => {
    if (!socket) {
      return;
    }
    const onReset = () => {
      if (!goLivePressedRef.current) {
        return;
      }
      setLastEnd((previous) => previous ?? { reason: 'dropped', muted: effectiveMutedRef.current });
    };
    socket.on('media:reset', onReset);
    return () => {
      socket.off('media:reset', onReset);
    };
  }, [socket]);

  // Records the effective mute state before reset, so reconnect restores the same state.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (status === 'connected') {
      wasConnected.current = true;
      return;
    }
    if (status === 'lost' && wasConnected.current && goLivePressed && lastEnd === null) {
      setLastEnd({ reason: 'dropped', muted: effectiveMutedRef.current });
    }
  }, [status, goLivePressed, lastEnd]);

  /**
   * After an involuntary drop the client rebuilds and re-produces in the same mute state.
   * After a deliberate end it does nothing — a broadcast somebody chose to stop must not
   * restart itself because the Wi-Fi blinked. A granted handover arrives here too: the
   * server hands this studio the channel and the same path puts it on air.
   */
  useEffect(() => {
    if (status !== 'connected' || hasProducer || !outputTrack) {
      return;
    }
    const action = onReconnect({
      goLivePressed,
      lastEnd,
      displaced,
      handoverKnown,
      handover,
    });
    if (action.type === 'to-pre-flight') {
      returnToPreflight();
      return;
    }
    if (action.type !== 're-produce') {
      return;
    }

    // A grant reaches a studio that never pressed anything, so the on-air screen and its
    // elapsed time start here rather than at a press that did not happen.
    setGoLivePressed(true);
    setStartedAt((previous) => previous ?? Date.now());

    let cancelled = false;
    void produce(action.paused).then(() => {
      if (cancelled) {
        return;
      }
      setEffectiveMuted(action.paused);
      setLastEnd(null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    status,
    hasProducer,
    outputTrack,
    goLivePressed,
    lastEnd,
    displaced,
    handoverKnown,
    handover,
    produce,
    returnToPreflight,
    setEffectiveMuted,
  ]);

  /**
   * The swap is finished: the claim sits with another studio, so whatever this one still
   * holds locally is stale. Covers the confirmed and the forced handover alike, and any
   * other way the channel changed hands while this studio was on air.
   */
  useEffect(() => {
    if (!hasLostClaim({ goLivePressed, displaced, handoverKnown, handover })) {
      return;
    }
    returnToPreflight();
  }, [goLivePressed, displaced, handoverKnown, handover, returnToPreflight]);
  // Never cleared: the button must not flicker back to disabled during a pause between words.
  const [heardSomething, setHeardSomething] = useState(false);

  useEffect(() => {
    const analyser = mic.analyser;
    if (!analyser || heardSomething) {
      return;
    }

    const frame = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(frame);
      if (levelStatus(meterLevel(rms(frame))) !== 'quiet') {
        setHeardSomething(true);
      }
    }, SIGNAL_POLL_MS);

    return () => clearInterval(timer);
  }, [mic.analyser, heardSomething]);

  // A suspended AudioContext reports a flat line, so `heardSomething` never latches and Go
  // live stays disabled. Go live is the one control that cannot be the resuming gesture.
  const { suspended, resume } = mic;
  useEffect(() => {
    if (!suspended) {
      return;
    }

    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
  }, [suspended, resume]);

  /**
   * A refusal is reported and then forgotten: every code the server can answer with means
   * the channel moved on, and the next snapshot is what puts the screen right.
   */
  const runHandover = (call: () => Promise<void>) => {
    setHandoverBusy(true);
    setHandoverFailed(false);
    void call()
      .catch((cause) => {
        setHandoverFailed(true);
        setConfirmedHandover(false);
        logError('handover: refused', cause);
      })
      .finally(() => setHandoverBusy(false));
  };

  if (state === 'displaced') {
    return <SpeakerDisplaced channelName={channel.name} />;
  }

  if (goLivePressed) {
    return (
      <SpeakerOnAir
        channel={channel}
        eventName={eventName}
        pin={pin}
        mic={mic}
        // The channel's own clock, not this studio's: an interpreter taking over continues
        // the broadcast rather than starting a second one. The local press covers only the
        // gap before the first snapshot.
        startedAt={handover?.onAirStartedAt ?? startedAt}
        listeners={listeners}
        listenerHistory={listenerHistory}
        reports={reports}
        reportResolution={reportResolution}
        reportsKnown={reportsKnown}
        state={state}
        link={link}
        handoverPending={handoverKnown && handover?.role === 'live' && handover.pending}
        handoverExpiresAt={handover?.expiresAt ?? null}
        handoverBusy={handoverBusy}
        handoverFailed={handoverFailed}
        onHandOver={() => {
          setConfirmedHandover(true);
          runHandover(onConfirmHandover);
        }}
        onToggleMute={() => {
          const next = !isMuted;
          const requestRevision = channelStatus?.revision ?? 0;
          const producerControl = {
            generation: media.state.generation,
            producerId: media.state.producerId,
          };
          setEffectiveMuted(next);
          // `lastEnd` recorded the mute state at drop time, before this press existed. The
          // reconnect re-produces from it, so a mute pressed during the outage has to land
          // here too or coming back would put the interpreter on air against their last word.
          setLastEnd((previous) => (previous ? { ...previous, muted: next } : previous));
          void media.setProducerPaused(next).catch((cause) => {
            const rollbackMuted = rollbackMutedAfterFailure({
              requestRevision,
              current: channelStatusRef.current,
            });
            if (!media.setLocalProducerPaused(rollbackMuted, producerControl)) {
              return;
            }
            setEffectiveMuted(rollbackMuted);
            setLastEnd((previous) => (previous ? { ...previous, muted: rollbackMuted } : previous));
            logError('media: could not change mute', cause);
          });
        }}
        // Recorded before the close, so the reconnect effect cannot read it as a drop.
        onEnd={() => endBroadcast({ reason: 'deliberate' })}
        preferences={preferences}
        onPreferencesChange={setPreferences}
      />
    );
  }

  const canGoLive = mic.deviceId !== null && heardSomething && mic.outputTrack !== null;

  return (
    <SpeakerPreflight
      action={preflightAction({ linkUp, handoverKnown, handover })}
      handoverBusy={handoverBusy}
      handoverFailed={handoverFailed}
      onRequestHandover={() => runHandover(onRequestHandover)}
      onCancelHandover={() => runHandover(onCancelHandover)}
      onTakeOver={() => runHandover(onTakeOver)}
      eventName={eventName}
      pin={pin}
      channel={channel}
      speakerCode={speakerCode}
      mic={mic}
      preferences={preferences}
      onPreferencesChange={setPreferences}
      canGoLive={canGoLive}
      onGoLive={() => {
        setEffectiveMuted(false);
        setGoLivePressed(true);
        setLastEnd(null);
        setStartedAt(Date.now());
        void produce(false);
      }}
      link={link}
    />
  );
}

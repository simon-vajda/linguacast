import {
  badgeHasLiveDot,
  hasRequestedAudio,
  type ListenActionState,
  type ListenIntentState,
  listenActionState,
  reconcileListenIntent,
} from '@linguacast/client-core/channel';
import {
  consumerPlan,
  filledBars,
  isLinkUp,
  type LinkState,
  linkLabel,
  resolveLinkState,
} from '@linguacast/client-core/media';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEventSocket } from '@/socket/provider';
import { logError } from '../log';
import { isSuperseded } from './use-media';

export interface ListenerView {
  actionState: ListenActionState;
  /** A resumed consumer exists — samples are arriving — not that the target was pressed. */
  isPlaying: boolean;
  /**
   * The guest asked for audio and has not stopped. Outlives a dropped link and the playback
   * hold, both of which the action state reports as something other than playing.
   */
  listening: boolean;
  /** The guest stopped a channel that is still broadcasting, so Play can resume it. */
  paused: boolean;
  holding: boolean;
  linkConnected: boolean;
  link: LinkState;
  /** Empty in the idle state, where the line renders nothing at all. */
  linkLabel: string;
  /** The nine bars, graded from real statistics. */
  filledBars: number;
  hasLiveDot: boolean;
  /** The ladder is spent; only a fresh session can help. */
  restartRecommended: boolean;
  start: () => void;
  stop: () => void;
  restart: () => void;
}

function sameIntent(a: ListenIntentState, b: ListenIntentState): boolean {
  return a.intent === b.intent && a.holdDeadline === b.holdDeadline;
}

/**
 * The listener half of the Channel screen, kept out of the screen so the screen stays a
 * layout. Every decision here comes from the shared listen and media state; what is local
 * is the effect ordering and the timer.
 *
 * There is no audio element on React Native and nothing to attach a track to: a consumed
 * remote track plays as soon as it is added to the peer connection, so the consumer is the
 * whole handle and `consumerPlan` deciding what to open and close is the whole control.
 */
export function useListener(input: {
  slug: string;
  live: boolean;
  muted: boolean | null;
  /** Producer this listener should be receiving; null until a status names one. */
  producerId: string | null;
  /** Set only while a replacement interpreter is transmitting beside the current one. */
  incomingProducerId: string | null;
  closeReason?: 'ended' | 'dropped';
}): ListenerView {
  const { status, hasConnected, media } = useEventSocket();
  const [playback, setPlayback] = useState<ListenIntentState>({
    intent: 'idle',
    holdDeadline: null,
  });

  const link = resolveLinkState({
    socketStatus: status,
    hasConnected,
    mediaHealth: media.health,
    stats: media.stats,
    // The guest's own stored request, not the reconciled one: reconciling needs the link,
    // and a guest who has not asked for audio has no media leg for the line to report on.
    mediaWanted: playback.intent !== 'idle',
  });
  const linkConnected = isLinkUp(link);
  const isPlaying = media.state.consumers[input.slug] !== undefined;

  const playingSnapshot = useRef({ slug: input.slug, isPlaying });
  const wasPlaying =
    playingSnapshot.current.slug === input.slug && playingSnapshot.current.isPlaying;
  useLayoutEffect(() => {
    playingSnapshot.current = { slug: input.slug, isPlaying };
  }, [input.slug, isPlaying]);

  const { live, closeReason } = input;
  const now = Date.now();
  const resolved = reconcileListenIntent(playback, {
    live,
    ...(closeReason === undefined ? {} : { closeReason }),
    linkConnected,
    wasPlaying,
    now,
  });

  useLayoutEffect(() => {
    setPlayback((current) => {
      const next = reconcileListenIntent(current, {
        live,
        ...(closeReason === undefined ? {} : { closeReason }),
        linkConnected,
        wasPlaying,
        now: Date.now(),
      });
      return sameIntent(current, next) ? current : next;
    });
  }, [live, closeReason, linkConnected, wasPlaying]);

  // An absolute deadline rather than a countdown, so a phone throttling timers in the
  // background cannot extend the hold past the window it promised.
  useEffect(() => {
    if (playback.intent !== 'holding' || playback.holdDeadline === null) {
      return;
    }

    const deadline = playback.holdDeadline;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(tick, remaining);
        return;
      }
      setPlayback((current) => {
        const next = reconcileListenIntent(current, {
          live,
          ...(closeReason === undefined ? {} : { closeReason }),
          linkConnected,
          wasPlaying,
          now: Date.now(),
        });
        return sameIntent(current, next) ? current : next;
      });
    };
    timer = setTimeout(tick, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [playback.intent, playback.holdDeadline, live, closeReason, linkConnected, wasPlaying]);

  /**
   * What to open and what to close is `consumerPlan`'s decision, not this effect's: a
   * channel switch, an interpreter dropping and a hold overlap, and deciding them
   * separately here is how the previous channel's consumer gets left open.
   */
  const { startConsuming, stopConsuming, swapConsumer, consumedProducers } = media;
  const consumers = media.state.consumers;
  const { producerId, incomingProducerId } = input;
  const activeSlug =
    resolved.intent === 'playing' || resolved.intent === 'holding' ? input.slug : null;
  const online = live && linkConnected;
  const intentRef = useRef({ activeSlug, online });
  useLayoutEffect(() => {
    intentRef.current = { activeSlug, online };
  }, [activeSlug, online]);

  useEffect(() => {
    const plan = consumerPlan({
      consumers,
      consumedProducers,
      activeSlug,
      online,
      producerId,
      incomingProducerId,
    });
    for (const slug of plan.close) {
      // The local consumer is closed synchronously; only telling the server can fail, and a
      // socket that is already gone is the usual reason. Caught rather than left floating:
      // an unhandled rejection is a red box over a screen that recovered by itself.
      void stopConsuming(slug).catch(() => {});
    }

    const report = (requestedSlug: string, cause: unknown) => {
      // Swallowed silently, a failed consume left the screen claiming it was waiting.
      if (
        intentRef.current.activeSlug === requestedSlug &&
        intentRef.current.online &&
        !isSuperseded(cause)
      ) {
        logError('media: could not listen', cause);
      }
    };

    const swap = plan.swap;
    if (swap) {
      void swapConsumer(swap.slug, swap.outgoing).catch((cause) => report(swap.slug, cause));
      return;
    }

    if (!plan.consume) {
      return;
    }

    const requestedSlug = plan.consume;
    void startConsuming(requestedSlug).catch((cause) => report(requestedSlug, cause));
  }, [
    consumers,
    consumedProducers,
    activeSlug,
    online,
    producerId,
    incomingProducerId,
    startConsuming,
    stopConsuming,
    swapConsumer,
  ]);

  // Leaving the channel room does not close media, so without this the consumer and its
  // remote track outlive the screen that opened them. Held in a ref so a new socket
  // identity does not re-run the teardown while the screen is still open.
  const stopRef = useRef(stopConsuming);
  stopRef.current = stopConsuming;
  useEffect(
    () => () => {
      void stopRef.current(input.slug).catch(() => {});
    },
    [input.slug],
  );

  const actionState = listenActionState({
    ...resolved,
    live,
    isPlaying,
    linkConnected,
    now,
  });

  /**
   * The guest stopped a channel that is still broadcasting, which is a pause rather than a
   * departure. Screen-local, because it is about this control rather than about the audio:
   * the intent this reads from is already idle, and the shared state machine has no fourth
   * state that both clients need.
   */
  const [pausedByGuest, setPausedByGuest] = useState(false);

  // A channel that stopped broadcasting is not paused, it is over. Clearing here withdraws
  // the controls rather than leaving a Play the guest could press for nothing.
  useEffect(() => {
    if (!live) {
      setPausedByGuest(false);
    }
  }, [live]);

  const start = useCallback(() => {
    setPausedByGuest(false);
    setPlayback({ intent: 'playing', holdDeadline: null });
  }, []);

  const stop = useCallback(() => {
    setPausedByGuest(true);
    setPlayback((current) =>
      current.intent === 'idle' ? current : { intent: 'idle', holdDeadline: null },
    );
  }, []);

  const holding = resolved.intent === 'holding';

  return {
    actionState,
    isPlaying,
    listening: hasRequestedAudio(resolved),
    paused: pausedByGuest && live,
    holding,
    linkConnected,
    link,
    linkLabel: linkLabel(link),
    filledBars: filledBars(link),
    hasLiveDot: badgeHasLiveDot({ live, muted: input.muted, holding, linkConnected }),
    restartRecommended: media.restartRecommended,
    start,
    stop,
    restart: media.restartSession,
  };
}

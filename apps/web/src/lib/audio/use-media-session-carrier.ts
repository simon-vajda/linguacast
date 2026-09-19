import { type RefObject, useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { logError } from '@/lib/log';
import { createMediaSessionCarrierWave } from './media-session-carrier';

export interface MediaSessionCarrier {
  audio: RefObject<HTMLAudioElement | null>;
  play(): void;
  pause(): void;
}

/**
 * Owns the looping file that asks Android for persistent media focus, and reports the moment
 * that focus is taken away.
 *
 * A pause nobody here asked for is the only signal a page gets that another app started
 * playing: the browser suspends file playback when it loses audio focus, but leaves a WebRTC
 * `srcObject` running, because it classifies live communication audio as exempt. Without this
 * the interpreted audio goes on playing underneath the song a guest just chose. The carrier
 * loops, so it never pauses of its own accord and every pause has one of two authors.
 */
export function useMediaSessionCarrier(onInterrupted: () => void): MediaSessionCarrier {
  const audio = useRef<HTMLAudioElement | null>(null);
  const requested = useRef(false);
  const interrupted = useEffectEvent(onInterrupted);

  useEffect(() => {
    const element = audio.current;
    if (!element) {
      return;
    }

    const url = URL.createObjectURL(
      new Blob([createMediaSessionCarrierWave()], { type: 'audio/wav' }),
    );
    element.src = url;
    element.load();

    const paused = () => {
      if (requested.current) {
        requested.current = false;
        return;
      }
      interrupted();
    };
    element.addEventListener('pause', paused);

    return () => {
      element.removeEventListener('pause', paused);
      element.pause();
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    };
  }, []);

  const play = useCallback(() => {
    const element = audio.current;
    if (!element?.paused) {
      return;
    }
    requested.current = false;
    void element.play().catch((cause) => logError('media: could not start audio carrier', cause));
  }, []);

  // Claimed before the call and never when the element is already paused: `pause()` on a
  // paused element fires no event, so a claim left standing would swallow the next
  // interruption instead of the pause it was taken for.
  const pause = useCallback(() => {
    const element = audio.current;
    if (!element || element.paused) {
      return;
    }
    requested.current = true;
    element.pause();
  }, []);

  return { audio, play, pause };
}

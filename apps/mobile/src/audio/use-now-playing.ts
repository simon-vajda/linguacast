import { useEffect } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import LinguacastAudio from '../../modules/linguacast-audio';
import { logError } from '../log';
import type { SystemControls } from './now-playing';

/**
 * Android refuses a foreground-service start from the background, and the refusal arrives
 * as a rejected promise. Retried rather than logged once: without this the session is never
 * held for the rest of the screen's life, and the guest is given silence with no signal.
 *
 * Backed off and capped, because the usual refusal clears when the guest returns to the
 * foreground and a failure that never clears must not poll the bridge for the session's life.
 */
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

/** Android 13 gates the service's own notification, which is what draws the controls. */
const NOTIFICATION_PERMISSION_SDK = 33;

/**
 * Holds the platform's audio session and its media controls in step with playback intent.
 *
 * The session follows the guest's request rather than the consumer (`systemControls` decides
 * that): Android refuses to start a foreground service from the background, so anything that
 * deactivates during a hold, an outage or a reconnect could not start one again.
 */
export function useNowPlaying(
  controls: SystemControls,
  handlers: { onPlay: () => void; onPause: () => void },
): void {
  const { active, playing } = controls;
  const title = controls.nowPlaying?.title ?? '';
  const artist = controls.nowPlaying?.artist ?? '';

  useEffect(() => {
    if (!active) {
      void LinguacastAudio.clearNowPlaying().catch(report);
      void LinguacastAudio.deactivate().catch(report);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = RETRY_MS;

    const attempt = () => {
      void LinguacastAudio.activate()
        .then(() => LinguacastAudio.setNowPlaying({ title, artist }))
        .catch((cause) => {
          report(cause);
          if (!cancelled) {
            timer = setTimeout(attempt, wait);
            wait = Math.min(wait * 2, MAX_RETRY_MS);
          }
        });
    };

    // Asked before the first activation, never awaited by it: the answer decides whether the
    // controls can be drawn, and the audio must not wait on a dialog to be held.
    void requestNotificationPermission();
    attempt();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, title, artist]);

  useEffect(() => {
    if (!active) {
      return;
    }

    void LinguacastAudio.setPlaybackState(playing).catch(report);
  }, [active, playing]);

  // Routed into the same handlers the in-app target uses, so the two can never disagree.
  const { onPlay, onPause } = handlers;
  useEffect(() => {
    const play = LinguacastAudio.addListener('onRemotePlay', onPlay);
    const pause = LinguacastAudio.addListener('onRemotePause', onPause);

    return () => {
      play.remove();
      pause.remove();
    };
  }, [onPlay, onPause]);

  // The controls must not outlive the screen that published them.
  useEffect(
    () => () => {
      void LinguacastAudio.clearNowPlaying().catch(report);
      void LinguacastAudio.deactivate().catch(report);
    },
    [],
  );
}

/** The decision belongs to the app rather than to a screen, so it is asked for once. */
let notificationPermissionAsked = false;

/**
 * Asked for, never depended on. A guest who declines still hears the interpreter; what they
 * lose is the lock-screen control, so a refusal must not stop the session from being held.
 */
async function requestNotificationPermission(): Promise<void> {
  if (
    notificationPermissionAsked ||
    Platform.OS !== 'android' ||
    Number(Platform.Version) < NOTIFICATION_PERMISSION_SDK
  ) {
    return;
  }

  notificationPermissionAsked = true;
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(report);
}

function report(cause: unknown): void {
  logError('audio: the listening session could not be updated', cause);
}

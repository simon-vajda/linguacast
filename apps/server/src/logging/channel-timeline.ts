import type { Notification } from '../core/notifications';
import { logger } from '../lib/log';

/**
 * The always-on answer to "was this channel live at the time they say it went quiet, and
 * how many people were on it".
 *
 * It subscribes to notifications the domain already publishes rather than instrumenting
 * the media layer: going on air, going off air, the broadcast claim moving, and the
 * listener count changing are all facts already on the bus.
 *
 * Listener volume is deliberately an aggregate. `listeners-changed` fires once per join
 * and once per leave, so writing a line per notification would put a hundred-listener
 * event's worth of noise between the lines a diagnosis actually needs. The count and the
 * peak are held here and written only at the two boundaries, which makes an event's log
 * cost the same whether five people listened or five hundred.
 *
 * Free of the database singleton and the notification hub on purpose: importing either
 * opens a file at module scope, so `index.ts` does the wiring.
 */

const log = logger('channel');

interface ChannelState {
  count: number;
  peak: number;
  onAir: boolean;
  /** Kept only to tell a first claim from a swap; never written to the log. */
  holder: string | null;
}

export type SlugResolver = (channelId: number) => string | undefined;

export function createChannelTimeline(slugOf: SlugResolver): (n: Notification) => void {
  const channels = new Map<number, ChannelState>();

  const stateOf = (channelId: number): ChannelState => {
    const existing = channels.get(channelId);
    if (existing) {
      return existing;
    }
    const fresh: ChannelState = { count: 0, peak: 0, onAir: false, holder: null };
    channels.set(channelId, fresh);
    return fresh;
  };

  // An unknown reading is not a negative one: a channel row that has gone is named by its
  // id rather than relabelled as some other channel's slug.
  const subject = (eventId: number, channelId: number, slug?: string): string =>
    `event ${eventId} ${slug ?? slugOf(channelId) ?? `channel ${channelId}`}`;

  return (notification) => {
    switch (notification.type) {
      case 'producer-opened': {
        const state = stateOf(notification.channelId);
        // A handover publishes this again on a channel that never went off air — once for
        // the incoming producer, once when it is promoted — because the swap reaches
        // listeners as one continuous broadcast. Treating each as a boundary would restart
        // the peak mid-broadcast and claim the channel went on air three times. The claim
        // moving is already on the timeline as its own line.
        if (state.onAir) {
          return;
        }
        state.onAir = true;
        // Reset here rather than at close, so a second broadcast on the same channel does
        // not inherit the first one's peak.
        state.peak = state.count;
        log.info(
          `${subject(notification.eventId, notification.channelId, notification.slug)} on air, ` +
            `${state.count} listening`,
        );
        return;
      }
      case 'producer-closed': {
        const state = stateOf(notification.channelId);
        state.onAir = false;
        log.info(
          `${subject(notification.eventId, notification.channelId, notification.slug)} off air ` +
            `(${notification.reason}), ${state.count} listening, peak ${state.peak}`,
        );
        state.peak = state.count;
        return;
      }
      case 'listeners-changed': {
        const state = stateOf(notification.channelId);
        state.count = notification.count;
        if (state.onAir && notification.count > state.peak) {
          state.peak = notification.count;
        }
        return;
      }
      case 'claim-changed': {
        const state = stateOf(notification.channelId);
        const previous = state.holder;
        state.holder = notification.sessionId;
        // The session id distinguishes a swap from a first claim but never reaches the
        // log: it is a broadcasting credential.
        const what =
          notification.sessionId === null
            ? 'broadcast rights released'
            : previous === null
              ? 'broadcast rights taken'
              : previous === notification.sessionId
                ? 'broadcast rights rebound to a reconnected studio'
                : 'broadcast rights handed to another studio';
        log.info(`${subject(notification.eventId, notification.channelId)} ${what}`);
        return;
      }
      default:
        return;
    }
  };
}

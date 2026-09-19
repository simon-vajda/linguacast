/**
 * Named notifications and not events: `core/events.service.ts` already exists and means
 * the domain entity. Two modules named around "events" with unrelated meanings is a trap.
 */

import type { ReportResolution, ReportRow } from '@linguacast/contract/socket';
import { logger } from '../lib/log';

export type EvictionReason = 'worker_died' | 'access_revoked';

/**
 * Two eviction variants because they answer different questions. `peer-evicted` names a
 * socket `core/` already registered as a peer. `room-evicted` names an event and leaves
 * the subscriber to resolve it against Socket.IO's own room membership — the only way to
 * reach a listener who owns no media and is therefore invisible here, which is precisely
 * who a regenerated PIN must remove.
 */
export type Notification =
  | { type: 'producer-opened'; eventId: number; channelId: number; slug: string }
  | {
      type: 'producer-closed';
      eventId: number;
      channelId: number;
      slug: string;
      reason: 'ended' | 'dropped';
    }
  | { type: 'producer-paused'; eventId: number; channelId: number; slug: string }
  | { type: 'producer-resumed'; eventId: number; channelId: number; slug: string }
  | {
      type: 'listeners-changed';
      eventId: number;
      channelId: number;
      slug: string;
      count: number;
    }
  | {
      type: 'reports-changed';
      eventId: number;
      channelId: number;
      slug: string;
      rows: ReportRow[];
      soundsGood: ReportResolution;
    }
  | {
      /** Who holds broadcast rights now; both fields null once nobody does. */
      type: 'claim-changed';
      eventId: number;
      channelId: number;
      sessionId: string | null;
      socketId: string | null;
    }
  | {
      /**
       * Something moved in the channel's handover: a request, a withdrawal, a grant, a
       * cancellation, a promotion, or the moment a take-over became available. The
       * subscriber rebuilds each studio's own snapshot rather than being handed one,
       * because the view differs per studio.
       */
      type: 'handover-changed';
      eventId: number;
      channelId: number;
    }
  | {
      /** Permission to produce passed between studios; `from` is null on a free channel. */
      type: 'handover-granted';
      eventId: number;
      channelId: number;
      fromSessionId: string | null;
      toSessionId: string;
    }
  | { type: 'peer-evicted'; socketId: string; reason: EvictionReason }
  | { type: 'room-evicted'; eventId: number; reason: EvictionReason };

export type NotificationListener = (notification: Notification) => void;

/**
 * How a domain fact reaches the transport layer without `core/` knowing what a socket is.
 * Worker death and admin revocation publish here rather than reaching for a socket, and
 * `socket/index.ts` is the only subscriber — so exactly one place in the codebase turns an
 * eviction into a disconnect.
 *
 * Facts, never commands: keeping it that way is what lets `core/` import nothing from
 * `socket/`.
 */
export class NotificationHub {
  private readonly listeners = new Set<NotificationListener>();

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(notification: Notification): void {
    for (const listener of this.listeners) {
      // One subscriber failing must not cost the others their notification — a half-
      // delivered eviction is how a channel ends up looking live and sounding silent.
      try {
        listener(notification);
      } catch (cause) {
        logger('notifications').error('a subscriber threw', cause);
      }
    }
  }
}

export const notifications = new NotificationHub();

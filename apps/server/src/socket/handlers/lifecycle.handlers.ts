import type {
  HandoverState,
  ListenerHistoryPoint,
  ReportCategory,
} from '@linguacast/contract/socket';
import type { SocketAuth } from '../../core/access';
import { getChannelById } from '../../core/channels.service';
import { handover } from '../../core/handover';
import { listenerHistory } from '../../core/listener-history';
import * as media from '../../core/media';
import type { Notification } from '../../core/notifications';
import { presence } from '../../core/presence';
import { reports } from '../../core/reports';
import type { Db } from '../../db/client';
import { logger } from '../../lib/log';
import { channelRoom, eventRoom } from '../lib/rooms';
import { broadcastHandoverState } from './handover.handlers';
import { type ReportsSocket, sendInitialReports } from './reports.handlers';

const log = logger('socket');

/** The subset of Server this module needs; a real Server satisfies it. */
export interface LifecycleServer {
  to(room: string): {
    emit(
      event: 'channel:status',
      payload: {
        slug: string;
        online: boolean;
        muted: boolean;
        reason?: 'ended' | 'dropped';
        producerId: string | null;
        incomingProducerId: string | null;
      },
    ): unknown;
    emit(event: 'media:reset', payload: { reason: 'worker_died' }): unknown;
    emit(event: 'handover:state', payload: HandoverState): unknown;
    emit(event: 'channel:listeners', payload: { slug: string; count: number }): unknown;
    emit(
      event: 'channel:reports',
      payload: {
        slug: string;
        rows: { category: ReportCategory; count: number; ageMs: number }[];
        soundsGood: { count: number; ageMs: number } | null;
      },
    ): unknown;
    emit(
      event: 'channel:listener-history',
      payload: { slug: string; points: ListenerHistoryPoint[] },
    ): unknown;
  };
  in(room: string): { disconnectSockets(close: boolean): unknown };
  sockets: { sockets: Map<string, { disconnect(close: boolean): unknown }> };
}

/** The subset of Socket the connect-time count needs; a real Socket satisfies it. */
export interface LifecycleSocket {
  emit(event: 'channel:listeners', payload: { slug: string; count: number }): unknown;
}

/**
 * The subset of Socket the seeded history needs. Its own interface rather than a second
 * signature on `LifecycleSocket`: one emitter satisfying both would have to be written as
 * an overload, and nothing here gains from the two events travelling together.
 */
export interface ListenerHistorySocket {
  emit(
    event: 'channel:listener-history',
    payload: { slug: string; points: ListenerHistoryPoint[] },
  ): unknown;
}

/**
 * A disconnect closes this socket's media and then gives up its claim, in that order:
 * closing the peer is what publishes the producer going away, and the claim outliving it
 * by a tick is harmless while the reverse would broadcast liveness for a producer that is
 * already gone.
 */
export function releaseSocket(socket: { id: string }, auth: SocketAuth): void {
  media.releasePeer(auth.eventId, socket.id);
  // Whatever this socket was doing in a handover, it can no longer do it.
  handover.releaseSocket(socket.id);
  const onAirSince =
    auth.speakerChannelId === null
      ? null
      : (presence.claimOf(auth.speakerChannelId)?.startedAt ?? null);
  const freed = presence.release(socket.id);
  if (freed !== null) {
    // Only a release that actually freed the claim is a departure. A socket the same
    // studio has already replaced frees nothing, so a reconnect and the drop it replaces
    // are safe to arrive in either order and neither hands the channel to a colleague.
    handover.departed({ eventId: auth.eventId, channelId: freed }, null, onAirSince);
  }
  // Reports stay in the window; cooldown and the right to resolve them go with the socket.
  reports.releaseSocket(socket.id);
}

/**
 * The only place in the codebase that turns a published fact into a socket action.
 *
 * The reason decides which action, because the two are not interchangeable. Access
 * revoked means the session may no longer be here at all, so it is disconnected. A dead
 * worker took the media and nothing else — the PIN is still valid and the claim still
 * held — so those clients are told to discard their identifiers and renegotiate, which
 * is the same path a server restart puts them on. A changed claim is neither: nobody is
 * disconnected for it.
 */
export function applyNotification(io: LifecycleServer, db: Db, notification: Notification): void {
  switch (notification.type) {
    case 'producer-opened':
      io.to(eventRoom(notification.eventId)).emit('channel:status', {
        slug: notification.slug,
        ...media.channelStatus(notification.eventId, notification.channelId),
      });
      return;

    case 'producer-closed':
      io.to(eventRoom(notification.eventId)).emit('channel:status', {
        slug: notification.slug,
        ...media.channelStatus(notification.eventId, notification.channelId),
        reason: notification.reason,
      });
      return;

    case 'producer-paused':
    case 'producer-resumed':
      io.to(channelRoom(notification.channelId)).emit('channel:status', {
        slug: notification.slug,
        ...media.channelStatus(notification.eventId, notification.channelId),
      });
      return;

    /**
     * Addressed to the claim holder, never to `channelRoom(channelId)`: every listening
     * guest is in that room, so a room-scoped emit would hand all n of them a number that
     * is the speaker's alone. `io.to(socketId)` reaches one socket because Socket.IO puts
     * every socket in a room named after its own id. A channel nobody is speaking on has
     * nobody to tell.
     */
    case 'listeners-changed': {
      const holder = presence.holder(notification.channelId);
      if (holder === undefined) {
        return;
      }
      io.to(holder).emit('channel:listeners', {
        slug: notification.slug,
        count: notification.count,
      });
      return;
    }

    /** Addressed to the claim holder for the reason `listeners-changed` is: see above. */
    case 'reports-changed': {
      const holder = presence.holder(notification.channelId);
      if (holder === undefined) {
        return;
      }
      io.to(holder).emit('channel:reports', {
        slug: notification.slug,
        rows: notification.rows,
        soundsGood: notification.soundsGood,
      });
      return;
    }

    /**
     * A claim moving is where a studio's audience becomes its own: the count and the
     * tally are seeded to whoever holds it now, rather than on connect, because a studio
     * in pre-flight has neither.
     */
    case 'claim-changed': {
      const { eventId, channelId, socketId } = notification;
      if (socketId !== null) {
        seedClaimAudience(db, io, eventId, channelId, socketId);
      }
      broadcastHandoverState(db, io, channelId);
      return;
    }

    case 'handover-changed':
    case 'handover-granted':
      broadcastHandoverState(db, io, notification.channelId);
      return;

    case 'peer-evicted': {
      // A socket that has already gone is ordinary here; there is nothing to do about it.
      io.sockets.sockets.get(notification.socketId)?.disconnect(true);
      return;
    }

    case 'room-evicted': {
      const room = eventRoom(notification.eventId);
      const reason = notification.reason;
      // The media under the socket went away but the caller's access did not: renegotiate
      // rather than disconnect.
      if (reason === 'worker_died') {
        io.to(room).emit('media:reset', { reason });
        return;
      }
      // Resolved against Socket.IO's own room membership, which is the only way to reach
      // a listener who owns no media and is therefore invisible to core/.
      io.in(room).disconnectSockets(true);
      return;
    }
  }
}

/**
 * A studio taking the channel must not sit blank until the next change, so it is told the
 * current count the moment the claim becomes its own. Zero is a number the studio can
 * render; sending nothing is not.
 *
 * It lives here rather than in `socket/index.ts` because that module is only reachable
 * through `attachSocket(httpServer)` and could not be tested without binding a real server.
 */
export function sendInitialListenerCount(
  db: Db,
  socket: LifecycleSocket,
  eventId: number,
  channelId: number,
): void {
  // `socket.data` carries no slug, so the wire's identifier is read back off the row.
  const channel = getChannelById(db, channelId);
  if (!channel) {
    return;
  }

  socket.emit('channel:listeners', {
    slug: channel.slug,
    count: media.listenerCount(eventId, channelId),
  });
}

/**
 * The hour behind the number, sent once. A studio taking the channel mid-service inherits
 * the audience its colleague built, and extends the line from `channel:listeners` after
 * this; there is never a second snapshot.
 *
 * Nothing is sent for a channel with no broadcast to describe: an empty chart would claim
 * an hour of silence the channel never had.
 */
export function sendInitialListenerHistory(
  db: Db,
  socket: ListenerHistorySocket,
  eventId: number,
  channelId: number,
): void {
  // `socket.data` carries no slug, so the wire's identifier is read back off the row.
  const channel = getChannelById(db, channelId);
  if (!channel) {
    return;
  }

  const points = listenerHistory.snapshot(
    eventId,
    channelId,
    media.listenerCount(eventId, channelId),
  );
  if (!points) {
    return;
  }

  socket.emit('channel:listener-history', { slug: channel.slug, points });
}

/**
 * What a studio is owed the moment the channel's claim becomes its own. Also called at
 * connection time for a studio that already holds the claim: the rebind is published from
 * inside the handshake, before Socket.IO has put the socket in a room of its own name, so
 * that notification reaches nobody.
 *
 * One try each. Sharing a block would let a failed count suppress the tally, and a studio
 * that never hears one withholds its panel for the life of the connection.
 */
export function seedClaimAudience(
  db: Db,
  io: LifecycleServer,
  eventId: number,
  channelId: number,
  socketId: string,
): void {
  const counts: LifecycleSocket = {
    emit: (event, payload) => io.to(socketId).emit(event, payload),
  };
  const tallies: ReportsSocket = {
    emit: (event, payload) => io.to(socketId).emit(event, payload),
  };
  const history: ListenerHistorySocket = {
    emit: (event, payload) => io.to(socketId).emit(event, payload),
  };
  seed(() => sendInitialListenerCount(db, counts, eventId, channelId), socketId, 'listener count');
  seed(() => sendInitialReports(db, tallies, eventId, channelId), socketId, 'report tally');
  seed(
    () => sendInitialListenerHistory(db, history, eventId, channelId),
    socketId,
    'listener history',
  );
}

function seed(send: () => void, socketId: string, what: string): void {
  try {
    send();
  } catch (cause) {
    log.error(`could not send the initial ${what} to ${socketId}`, cause);
  }
}

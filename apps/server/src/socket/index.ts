import type { ServerType } from '@hono/node-server';
import { clientToServer } from '@linguacast/contract/socket';
import { Server } from 'socket.io';
import { notifications } from '../core/notifications';
import { presence } from '../core/presence';
import { db } from '../db';
import { logger } from '../lib/log';
import { joinChannel, leaveChannel } from './handlers/channels.handlers';
import {
  cancelHandover,
  confirmHandover,
  requestHandover,
  sendHandoverState,
  takeOverHandover,
} from './handlers/handover.handlers';
import { applyNotification, releaseSocket, seedClaimAudience } from './handlers/lifecycle.handlers';
import {
  connectTransport,
  getCapabilities,
  openTransport,
  pauseProducing,
  releaseTransport,
  restartTransport,
  resumeConsuming,
  resumeProducing,
  startConsuming,
  startProducing,
  stopConsuming,
  stopProducing,
} from './handlers/media.handlers';
import { resolveReports, submitReport } from './handlers/reports.handlers';
import { handshakeGate } from './handshake';
import { on } from './lib/on';
import { channelRoom, eventRoom } from './lib/rooms';
import type { SocketServer } from './lib/types';
import { validate } from './lib/validate';

const log = logger('socket');

/**
 * Attach displaces the HTTP server's request listeners, so /api/socket.io is handled
 * before Hono sees it and never reaches app.ts's /api/* 404.
 * A path on the default namespace, not a namespace: all dynamic traffic then sits under
 * /api, so one Vite proxy rule and one reverse-proxy rule cover both.
 */
export function attachSocket(httpServer: ServerType): SocketServer {
  const io: SocketServer = new Server(httpServer, {
    path: '/api/socket.io',
    // Engine.IO heartbeats, unrelated to the `ping` event below. Far below the 25s/20s
    // defaults because a dead speaker socket holds its channel until Socket.IO reaps it:
    // ~5s bounds that window to about ten seconds instead of ~45.
    pingInterval: 5_000,
    pingTimeout: 5_000,
    connectTimeout: 10_000,
  });

  io.use(handshakeGate);

  // The only subscriber: every eviction and liveness change reaches a client through
  // this transport boundary and nowhere else.
  notifications.subscribe((notification) => applyNotification(io, db, notification));

  io.on('connection', (socket) => {
    // Before any handler, so it also sees packets no handler is registered for.
    socket.use(validate(clientToServer));

    // Re-established here rather than in the gate: nothing is sticky across connections
    // and Socket.IO replays the auth payload on reconnect.
    socket.join(eventRoom(socket.data.eventId));

    const speakerChannelId = socket.data.speakerChannelId;
    // Joining the channel room is all a claim buys. Liveness is the producer's to report,
    // so nothing is broadcast here — an open studio is not audio.
    if (speakerChannelId !== null) {
      socket.join(channelRoom(speakerChannelId));
    }

    on(socket, 'ping', () => ({ serverTime: Date.now() }));
    on(socket, 'channel:join', ({ slug }) => joinChannel(db, socket, socket.data, slug));
    on(socket, 'channel:leave', ({ slug }) => {
      leaveChannel(db, socket, socket.data, slug);
      // A fire-and-forget Handler returns `undefined`, not `void`.
      return undefined;
    });

    on(socket, 'handover:request', () => requestHandover(socket, socket.data));
    on(socket, 'handover:cancel', () => cancelHandover(socket, socket.data));
    on(socket, 'handover:confirm', () => confirmHandover(socket, socket.data));
    on(socket, 'handover:take-over', () => takeOverHandover(socket, socket.data));

    on(socket, 'channel:report', (payload) => submitReport(db, socket, socket.data, payload));
    on(socket, 'channel:resolve-reports', (payload) =>
      resolveReports(db, socket, socket.data, payload),
    );

    on(socket, 'media:capabilities', () => getCapabilities(socket, socket.data));
    on(socket, 'media:create-transport', (payload) => openTransport(socket, socket.data, payload));
    on(socket, 'media:connect-transport', (payload) =>
      connectTransport(socket, socket.data, payload),
    );
    on(socket, 'media:restart-ice', (payload) => restartTransport(socket, socket.data, payload));
    on(socket, 'media:close-transport', (payload) =>
      releaseTransport(socket, socket.data, payload),
    );
    on(socket, 'media:produce', (payload) => startProducing(db, socket, socket.data, payload));
    on(socket, 'media:pause-producer', (payload) => pauseProducing(socket, socket.data, payload));
    on(socket, 'media:resume-producer', (payload) => resumeProducing(socket, socket.data, payload));
    on(socket, 'media:close-producer', (payload) => stopProducing(socket, socket.data, payload));
    on(socket, 'media:consume', (payload) => startConsuming(db, socket, socket.data, payload));
    on(socket, 'media:resume-consumer', (payload) => resumeConsuming(socket, socket.data, payload));
    on(socket, 'media:close-consumer', (payload) => stopConsuming(socket, socket.data, payload));

    socket.on('disconnect', () => releaseSocket(socket, socket.data));

    // Last, and guarded. It reads the database synchronously, and this runs in the raw
    // connection listener rather than behind `handle`'s try/catch — so a throw here would
    // escape an EventEmitter and take the whole single-process server down with it. Failing
    // it costs one studio a reading until the next change; failing loudly costs every event.
    const studioSession = socket.data.studioSession;
    if (speakerChannelId !== null && studioSession !== null) {
      try {
        // Unconditional: a studio that has heard nothing cannot tell an idle channel from
        // one it has no reading of, and only this message's arrival separates them. The
        // listener count and the report tally instead follow the claim, which a studio in
        // pre-flight does not hold.
        sendHandoverState(db, socket, {
          eventId: socket.data.eventId,
          channelId: speakerChannelId,
          sessionId: studioSession,
          socketId: socket.id,
        });
      } catch (cause) {
        log.error(`could not send the handover snapshot to ${socket.id}`, cause);
      }
      // A studio reconnecting onto a claim it still holds had that rebind published from
      // inside the handshake, before this socket could be addressed at all.
      if (presence.claimOf(speakerChannelId)?.socketId === socket.id) {
        seedClaimAudience(db, io, socket.data.eventId, speakerChannelId, socket.id);
      }
    }
  });

  return io;
}

import { logger } from '../../lib/log';
import { ROOM_IDLE_GRACE_MS } from './config';
import { Room } from './room';
import type { WorkerLossReason, WorkerPool } from './workers';

const log = logger('media');

export type RoomClosedReason = WorkerLossReason | 'idle' | 'shutdown' | 'revoked';

export interface RoomRegistryOptions {
  graceMs?: number;
  onRoomClosed?: (room: Room, reason: RoomClosedReason) => void;
}

/**
 * One room per event, created lazily on the first produce and torn down once idle.
 *
 * Router creation spans an `await`, so better-sqlite3's synchrony does not protect this
 * the way it protects the handshake: a plain check-then-create would build two routers
 * for one event under two simultaneous Go lives. Every transition into and out of
 * creating and draining goes through the per-event slot below — the cached creation
 * promise and the grace timer — so a timer cannot fire between a check and a create.
 */
export class RoomRegistry {
  private readonly rooms = new Map<number, Room>();
  private readonly creating = new Map<number, Promise<Room>>();
  private readonly teardowns = new Map<number, NodeJS.Timeout>();
  private readonly graceMs: number;
  private readonly onRoomClosed?: (room: Room, reason: RoomClosedReason) => void;

  constructor(
    private readonly pool: WorkerPool,
    options: RoomRegistryOptions = {},
  ) {
    this.graceMs = options.graceMs ?? ROOM_IDLE_GRACE_MS;
    this.onRoomClosed = options.onRoomClosed;
    this.pool.onWorkerLost((index, reason) => this.evictWorker(index, reason));
  }

  get(eventId: number): Room | undefined {
    return this.rooms.get(eventId);
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /** Any use of an existing room cancels its pending teardown, not only a creation. */
  touch(eventId: number): void {
    this.cancelTeardown(eventId);
  }

  /**
   * The only path that creates a room: administrative and guest activity allocate no
   * router; only a produce does.
   */
  async getOrCreate(eventId: number): Promise<Room> {
    this.cancelTeardown(eventId);

    const existing = this.rooms.get(eventId);
    if (existing) {
      return existing;
    }

    const inFlight = this.creating.get(eventId);
    if (inFlight) {
      return inFlight;
    }

    const creation = this.create(eventId).finally(() => {
      // Cleared on both settle paths: a rejection left cached would wedge this event
      // until the process restarted.
      this.creating.delete(eventId);
    });
    this.creating.set(eventId, creation);
    return creation;
  }

  /** Arms the grace timer if the room has nothing left attached; otherwise does nothing. */
  releaseIfIdle(eventId: number): void {
    const room = this.rooms.get(eventId);
    if (!room?.isIdle) {
      return;
    }
    if (this.teardowns.has(eventId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.teardowns.delete(eventId);
      const current = this.rooms.get(eventId);
      // Re-checked, not assumed: anything that arrived during the grace period wins.
      if (!current?.isIdle) {
        return;
      }
      this.closeRoom(eventId, 'idle');
    }, this.graceMs);
    timer.unref?.();
    this.teardowns.set(eventId, timer);
  }

  /** A lost worker takes its rooms with it; rooms on other workers are untouched. */
  evictWorker(index: number, reason: WorkerLossReason = 'worker_died'): void {
    for (const [eventId, room] of this.rooms) {
      if (room.workerIndex === index) {
        this.closeRoom(eventId, reason);
      }
    }
  }

  closeEvent(eventId: number, reason: RoomClosedReason = 'revoked'): void {
    this.closeRoom(eventId, reason);
  }

  async closeAll(): Promise<void> {
    for (const timer of this.teardowns.values()) {
      clearTimeout(timer);
    }
    this.teardowns.clear();
    for (const eventId of [...this.rooms.keys()]) {
      this.closeRoom(eventId, 'shutdown');
    }
  }

  private async create(eventId: number): Promise<Room> {
    try {
      const { router, webRtcServer, workerIndex } = await this.pool.createRouter();
      const room = new Room({ eventId, router, webRtcServer, workerIndex });
      this.rooms.set(eventId, room);
      return room;
    } catch (cause) {
      // One of the few things that explains a channel which never went live.
      log.error(`could not create a room for event ${eventId}`, cause);
      throw cause;
    }
  }

  private cancelTeardown(eventId: number): void {
    const timer = this.teardowns.get(eventId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.teardowns.delete(eventId);
  }

  private closeRoom(eventId: number, reason: RoomClosedReason): void {
    const room = this.rooms.get(eventId);
    if (!room) {
      // A creation in flight is invisible in `rooms`, so closing now would miss it and
      // the router would surface moments later with nothing left to close it.
      const inFlight = this.creating.get(eventId);
      if (inFlight) {
        void inFlight.then(() => this.closeRoom(eventId, reason)).catch(() => {});
      }
      return;
    }
    // Deleted before closing, so nothing can be handed a room whose router is going away.
    this.rooms.delete(eventId);
    this.cancelTeardown(eventId);
    room.close();
    this.onRoomClosed?.(room, reason);
  }
}

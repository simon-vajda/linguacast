import os from 'node:os';
import { createWorker, type types } from 'mediasoup';
import { logger } from '../../lib/log';
import { AppError } from '../../lib/problem';
import { AUDIO_CODECS, listenInfosFor, type MediaNetworkConfig, workerCountFor } from './config';

const log = logger('media');

/**
 * A deterministic crash cause would otherwise spin a subprocess and pin a core, so an
 * index gets a bounded number of replacements per window. Past that it is left down and
 * logged: silencing one event beats silencing the machine.
 */
export const REPLACEMENT_LIMIT = 3;
export const REPLACEMENT_WINDOW_MS = 60_000;

export type WorkerFactory = typeof createWorker;

export interface WorkerPoolOptions {
  net: MediaNetworkConfig;
  createWorker?: WorkerFactory;
  hostCpuCount?: number;
  now?: () => number;
}

/** Why the rooms on a worker index are gone. A death is the only reason left. */
export type WorkerLossReason = 'worker_died';

export interface RouterAllocation {
  router: types.Router;
  webRtcServer: types.WebRtcServer;
  workerIndex: number;
}

interface Slot {
  index: number;
  worker: types.Worker;
  webRtcServer: types.WebRtcServer;
  routers: number;
  /** Rejecters for creations still awaiting this worker, so a death cannot leave one pending. */
  pending: Set<(err: Error) => void>;
}

/**
 * The pool exists for crash isolation, not throughput: audio-only Opus forwarding fits one
 * core at this product's ceiling, and one worker crashing must not silence every concurrent
 * event. mediasoup's own guidance is to exit on a worker death, which assumes an
 * orchestrator; here it would do exactly the damage the pool is meant to prevent.
 */
export class WorkerPool {
  private readonly slots = new Map<number, Slot>();
  private readonly deathsByIndex = new Map<number, number[]>();
  private readonly retries = new Map<number, NodeJS.Timeout>();
  private readonly listeners = new Set<(index: number, reason: WorkerLossReason) => void>();
  private closing = false;

  private readonly net: MediaNetworkConfig;
  private readonly spawnWorker: WorkerFactory;
  private readonly hostCpuCount: number;
  private readonly now: () => number;

  constructor(options: WorkerPoolOptions) {
    this.net = options.net;
    this.spawnWorker = options.createWorker ?? createWorker;
    this.hostCpuCount = options.hostCpuCount ?? os.cpus().length;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.slots.size;
  }

  /** For tests and for the death path's own bookkeeping; not part of the media API. */
  workerAt(index: number): types.Worker | undefined {
    return this.slots.get(index)?.worker;
  }

  async start(): Promise<void> {
    const count = workerCountFor(this.hostCpuCount, this.net.maxWorkers);
    for (let index = 0; index < count; index += 1) {
      await this.spawn(index);
    }
  }

  /**
   * The one line that makes a misconfigured host diagnosable without instrumentation.
   * Both counts, because `os.cpus()` reports the host's cores and not a cgroup quota:
   * an operator running under `--cpus` sees the mismatch here or nowhere.
   *
   * Names the resolved address alongside the configured one: what the workers announce is
   * `PUBLIC_ADDRESS` verbatim, which may be a name, and the operator would otherwise lose
   * sight of the address guests actually reach.
   */
  startupSummary(resolvedAddress?: string): string {
    const ports = [...this.slots.keys()].sort((a, b) => a - b).map((i) => this.net.rtcPortBase + i);
    return [
      `${this.slots.size} worker(s) of ${this.hostCpuCount} detected core(s)`,
      `ports ${ports.join(', ')} (UDP and TCP)`,
      resolvedAddress && resolvedAddress !== this.net.announcedIp
        ? `guests connect to ${this.net.announcedIp} (${resolvedAddress})`
        : `guests connect to ${this.net.announcedIp}`,
    ].join(' · ');
  }

  /** The registry subscribes here to drop the rooms that lived on a lost index. */
  onWorkerLost(listener: (index: number, reason: WorkerLossReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Least-loaded wins, counted in routers, which is one per event. */
  async createRouter(): Promise<RouterAllocation> {
    const slot = this.pick();
    slot.routers += 1;

    let rejectOnDeath!: (err: Error) => void;
    const died = new Promise<never>((_, reject) => {
      rejectOnDeath = reject;
    });
    slot.pending.add(rejectOnDeath);

    try {
      const router = await Promise.race([
        slot.worker.createRouter({ mediaCodecs: AUDIO_CODECS }),
        died,
      ]);
      router.observer.once('close', () => {
        slot.routers = Math.max(0, slot.routers - 1);
      });
      return { router, webRtcServer: slot.webRtcServer, workerIndex: slot.index };
    } catch (err) {
      slot.routers = Math.max(0, slot.routers - 1);
      throw err;
    } finally {
      slot.pending.delete(rejectOnDeath);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.retries.values()) {
      clearTimeout(timer);
    }
    this.retries.clear();

    const slots = [...this.slots.values()];
    this.slots.clear();
    for (const slot of slots) {
      slot.worker.close();
    }
  }

  private pick(): Slot {
    let chosen: Slot | undefined;
    for (const slot of this.slots.values()) {
      if (!chosen || slot.routers < chosen.routers) {
        chosen = slot;
      }
    }
    if (!chosen) {
      throw new AppError('media_unavailable', 'No media worker is available.');
    }
    return chosen;
  }

  private async spawn(index: number): Promise<void> {
    const worker = await this.spawnWorker({ logLevel: 'warn' });
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: listenInfosFor(this.net, index),
    });
    const slot: Slot = { index, worker, webRtcServer, routers: 0, pending: new Set() };
    this.slots.set(index, slot);
    worker.on('died', () => {
      void this.handleDeath(slot);
    });
  }

  private async handleDeath(slot: Slot): Promise<void> {
    // A death arriving after close(), or after this slot was already replaced, is stale.
    if (!this.owns(slot)) {
      return;
    }
    this.slots.delete(slot.index);

    const err = new Error(`mediasoup worker ${slot.index} died`);
    for (const reject of slot.pending) {
      reject(err);
    }
    slot.pending.clear();

    log.error(`worker ${slot.index} died; dropping its rooms`);
    for (const listener of this.listeners) {
      listener(slot.index, 'worker_died');
    }

    const recent = this.recordDeath(slot.index);
    if (recent.length > REPLACEMENT_LIMIT) {
      log.error(
        `worker ${slot.index} died ${recent.length} times in ${
          REPLACEMENT_WINDOW_MS / 1000
        }s; left down rather than respawned`,
      );
      this.scheduleRetry(slot.index);
      return;
    }
    await this.replace(slot.index);
  }

  private recordDeath(index: number): number[] {
    const cutoff = this.now() - REPLACEMENT_WINDOW_MS;
    const recent = [...(this.deathsByIndex.get(index) ?? []), this.now()].filter((t) => t > cutoff);
    this.deathsByIndex.set(index, recent);
    return recent;
  }

  /**
   * Down for a window, not forever: a transient cause recovers on its own and a persistent
   * one costs one spawn a minute rather than a pinned core.
   */
  private scheduleRetry(index: number): void {
    if (this.retries.has(index)) {
      return;
    }
    const timer = setTimeout(() => {
      this.retries.delete(index);
      if (this.closing || this.slots.has(index)) {
        return;
      }
      this.deathsByIndex.delete(index);
      void this.replace(index);
    }, REPLACEMENT_WINDOW_MS);
    timer.unref?.();
    this.retries.set(index, timer);
  }

  /**
   * Whether this slot is still the pool's. A death, a replacement or a close() landing
   * across an await means whoever holds the index now owns its recovery, and acting again
   * would delete a replacement or bind a port it is already holding.
   */
  private owns(slot: Slot): boolean {
    return !this.closing && this.slots.get(slot.index) === slot;
  }

  private async replace(index: number): Promise<void> {
    try {
      await this.spawn(index);
      log.info(`worker ${index} replaced on port ${this.net.rtcPortBase + index}`);
    } catch (cause) {
      log.error(`could not replace worker ${index}`, cause);
      this.scheduleRetry(index);
    }
  }
}

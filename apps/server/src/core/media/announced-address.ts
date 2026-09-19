import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { logger } from '../../lib/log';
import { isUnroutableAnnouncedAddress } from './config';

const log = logger('media');

/**
 * The address that goes into every ICE candidate, kept current on a deployment whose
 * public IP moves.
 *
 * A hostname cannot be announced to every browser: Firefox discards a remote ICE candidate
 * whose connection address is a fully-qualified name (Mozilla bug 1713128, still open),
 * and mediasoup is ice-lite, so it never sends the connectivity check that would otherwise
 * let a peer-reflexive candidate rescue the connection. Chrome resolves such candidates and
 * connects, which is why this fails in exactly one browser and reports success everywhere.
 *
 * So the resolution happens here instead, and mediasoup only ever sees a literal address.
 */

/**
 * A dynamic-IP connection changes address on an ISP reconnect, and DDNS records carry a
 * TTL of about a minute. Longer leaves the deployment announcing a dead address for no
 * reason; shorter buys nothing, because the record itself will not have moved.
 */
export const ANNOUNCED_ADDRESS_POLL_MS = 60_000;

/**
 * Every address the name answers with, not just the first. A name with several A records
 * hands out a different one per lookup, and reading that rotation as a move would rebuild
 * every worker on the poll interval — so the answer set is what the caller compares
 * against, and the address in use is kept while it remains in it.
 */
export type AddressResolver = (hostname: string) => Promise<string[]>;

/**
 * IPv4 only, and deliberately: the workers bind an IPv4 address, so announcing a AAAA
 * record would produce candidates pointing at nothing this process is listening on.
 */
const resolveIpv4: AddressResolver = async (hostname) => {
  const answers = await lookup(hostname, { family: 4, all: true });
  return answers.map(({ address }) => address);
};

export interface AnnouncedAddressOptions {
  /** What the operator put in `PUBLIC_ADDRESS`: an IP literal or a hostname. */
  configured: string;
  resolve?: AddressResolver;
  pollMs?: number;
}

export class AnnouncedAddress {
  private value: string;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private readonly listeners = new Set<(address: string) => void>();

  private readonly configured: string;
  private readonly resolve: AddressResolver;
  private readonly pollMs: number;

  constructor(options: AnnouncedAddressOptions) {
    this.configured = options.configured;
    this.resolve = options.resolve ?? resolveIpv4;
    this.pollMs = options.pollMs ?? ANNOUNCED_ADDRESS_POLL_MS;
    this.value = options.configured;
  }

  /** What to announce right now. Meaningful only after `start()` has resolved. */
  get current(): string {
    return this.value;
  }

  /** True while a hostname is being tracked, which is the only case that polls. */
  get isTracking(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Fatal on failure, in the same class as a worker that cannot start: an unresolvable
   * hostname yields no address to announce at all, and every later symptom of that is
   * silent.
   *
   * A name that answers only with private addresses is the same failure wearing a
   * different hat — split-horizon DNS inside a container resolves the public name to a LAN
   * address, and the deployment then hands every guest a candidate nobody off the machine
   * can reach. Refusing to boot is the only place that is visible.
   */
  async start(): Promise<string> {
    if (isIP(this.configured) !== 0) {
      return this.value;
    }

    let answers: string[];
    try {
      answers = await this.resolve(this.configured);
    } catch (cause) {
      throw new Error(this.unresolvableMessage(), { cause });
    }

    const routable = answers.find((address) => !isUnroutableAnnouncedAddress(address));
    if (routable === undefined) {
      throw new Error(
        answers.length === 0
          ? this.unresolvableMessage()
          : `PUBLIC_ADDRESS is ${this.configured}, which resolves only to private or ` +
              `loopback addresses (${answers.join(', ')}). A guest off this machine cannot ` +
              'reach any of them. Point the name at your public address, or set ' +
              'PUBLIC_ADDRESS to that address directly.',
      );
    }

    this.value = routable;
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
    this.timer.unref?.();
    return this.value;
  }

  private unresolvableMessage(): string {
    return (
      `PUBLIC_ADDRESS is ${this.configured}, which does not resolve to an IPv4 address. ` +
      'Fix the DNS record, or set PUBLIC_ADDRESS to your public IP address instead.'
    );
  }

  onChange(listener: (address: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
  }

  /**
   * A failed lookup keeps the last known address rather than tearing anything down: a DNS
   * blip is not an address change, and treating it as one would drop every live room. An
   * answer that is only private is treated the same way, for the same reason it is fatal
   * at boot — it is not an address this deployment can announce.
   *
   * Skipped while one is already in flight: a resolver slower than the poll interval would
   * otherwise stack lookups and interleave two rebuild passes over the same worker pool.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      let answers: string[];
      try {
        answers = await this.resolve(this.configured);
      } catch (cause) {
        log.warn(
          `could not re-resolve ${this.configured}; still announcing ${this.value}: ${String(cause)}`,
        );
        return;
      }

      const routable = answers.filter((address) => !isUnroutableAnnouncedAddress(address));
      const [next] = routable;
      if (next === undefined) {
        log.warn(
          `${this.configured} resolves to nothing routable ` +
            `(${answers.join(', ') || 'no answer'}); still announcing ${this.value}`,
        );
        return;
      }

      // The address in use is kept while the name still answers with it, so a rotating
      // record is not mistaken for a move.
      if (routable.includes(this.value)) {
        return;
      }

      const previous = this.value;
      this.value = next;
      log.info(`${this.configured} moved from ${previous} to ${next}; re-announcing`);
      for (const listener of this.listeners) {
        listener(next);
      }
    } finally {
      this.refreshing = false;
    }
  }
}

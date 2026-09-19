import type { Context, MiddlewareHandler } from 'hono';
import { env } from '../../env';
import { logger } from '../../lib/log';
import { TokenBucketLimiter } from '../../lib/rate-limit';

const log = logger('proxy');

/** The whole server shares one budget behind the per-IP one, so it needs one key. */
const SHARED_KEY = '*';

/** So a configured `127.0.0.1` still matches a connection arriving as `::ffff:127.0.0.1`. */
function normalizeAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * The rightmost X-Forwarded-For entry, and only from an address the operator listed: that
 * entry is the one the trusted proxy appended, so a client-supplied header cannot displace
 * it. Without this every request behind nginx shares the proxy's bucket.
 */
export function clientIp(
  c: Context,
  trustedProxies: readonly string[] = env.TRUSTED_PROXY_IPS,
): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const remote = incoming?.socket?.remoteAddress;
  const from = remote ? normalizeAddress(remote) : undefined;
  const appended = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();

  if (from !== undefined && trustedProxies.includes(from)) {
    if (appended) {
      return normalizeAddress(appended);
    }
    // Both halves of the setting are right and it still does nothing: the proxy was
    // listed but never told to append the header, so every visitor arrives as the proxy
    // and one guesser spends the throttle budget for all of them. Nothing else says so.
    log.warnOnce(
      'proxy:no-forwarded-header',
      'A listed trusted proxy sent no X-Forwarded-For header, so every visitor shares ' +
        "one throttle bucket. Configure the proxy to append the client's address.",
    );
  } else if (appended && trustedProxies.length > 0) {
    // Named, not judged: a container bridge address is indistinguishable from a stray
    // client's forged header here, and only the operator knows which this is.
    log.warnOnce(
      `proxy:untrusted-forwarder:${from ?? 'unknown'}`,
      `An X-Forwarded-For header arrived from ${from ?? 'an unidentifiable address'}, which ` +
        'is not in TRUSTED_PROXY_IPS, so it was ignored. If that is your proxy, list it.',
    );
  }

  // 'unknown' collapses every unidentifiable caller into one bucket, throttling them
  // together rather than exempting them.
  return from ?? 'unknown';
}

export interface RateLimitOptions {
  perIp: TokenBucketLimiter;
  /** Omitted where a shared budget would behave as a lockout — see the sign-in limiter. */
  shared?: TokenBucketLimiter;
  /** Which response statuses cost a token. Only a caller that is guessing pays. */
  chargeStatuses?: number[];
  /**
   * Charge on the way in and refund on a status that costs nothing, instead of charging on
   * the way out. `allow` does not consume, so a caller firing attempts concurrently is
   * measured against a budget none of them has spent yet — fine for a lookup that answers
   * in a millisecond, not for one that awaits a deliberately slow hash.
   */
  reserve?: boolean;
  message?: string;
  trustedProxies?: readonly string[];
  /** Lets HTML surfaces keep their document shell while API routes retain a JSON Problem. */
  onLimited?: (c: Context) => Response | Promise<Response>;
}

export function createRateLimit(options: RateLimitOptions): MiddlewareHandler {
  const chargeStatuses = options.chargeStatuses ?? [404];
  const message = options.message ?? 'Too many failed lookups.';

  return async (c, next) => {
    const ip = clientIp(c, options.trustedProxies);
    const shared = options.shared;

    const wait = !options.perIp.allow(ip)
      ? options.perIp.retryAfter(ip)
      : shared && !shared.allow(SHARED_KEY)
        ? shared.retryAfter(SHARED_KEY)
        : 0;

    if (wait > 0) {
      c.header('Retry-After', String(wait));
      if (options.onLimited) {
        return options.onLimited(c);
      }
      return c.json({ code: 'rate_limited', message }, 429);
    }

    if (options.reserve) {
      options.perIp.penalize(ip);
      shared?.penalize(SHARED_KEY);
    }

    await next();

    const chargeable = chargeStatuses.includes(c.res.status);
    if (options.reserve && !chargeable) {
      options.perIp.refund(ip);
      shared?.refund(SHARED_KEY);
    } else if (!options.reserve && chargeable) {
      options.perIp.penalize(ip);
      shared?.penalize(SHARED_KEY);
    }
  };
}

/**
 * Burst 20 refilling at 1/s puts a sweep of the 6-digit space at roughly eleven days,
 * while a guest who mistypes twice never notices. The shared budget behind it is for
 * botnets, which sidestep a per-IP limit entirely.
 */
const publicPerIp = new TokenBucketLimiter({ capacity: 20, refillPerSecond: 1 });
const publicShared = new TokenBucketLimiter({ capacity: 200, refillPerSecond: 10 });

/** Both public transports use these same buckets, so neither is an enumeration escape hatch. */
export function createPublicRateLimit(
  onLimited?: RateLimitOptions['onLimited'],
): MiddlewareHandler {
  return createRateLimit({
    perIp: publicPerIp,
    shared: publicShared,
    onLimited,
  });
}

export const publicRateLimit = createPublicRateLimit();

/**
 * Ten wrong answers, then one a minute — an administrator mistyping twice never feels it
 * and a guesser gets nowhere. No shared budget behind it: against a single account that
 * behaves as a lockout, because the budget check runs before the handler and a distributed
 * guesser holding it at zero would refuse the correct password too. What a shared budget
 * would have protected — many 32 MB scrypt allocations at once — is bounded in
 * core/auth/password.ts instead, which makes a caller wait rather than fail.
 *
 * Setup shares the bucket and charges on its own refusal: it takes credentials and pays
 * for a hash, so repeating it must cost something too.
 */
const signInPerIp = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 / 60 });

export const signInRateLimit = createRateLimit({
  perIp: signInPerIp,
  chargeStatuses: [401, 409],
  reserve: true,
  message: 'Too many sign-in attempts.',
});

/**
 * The same bucket as sign-in: a wrong current password is a password guess too, and a
 * bucket of its own would double how fast one address can make them. Only 403 is charged;
 * 401 (no session) is answered by requireAdmin before this runs, and 409 (a change already
 * in flight) guesses nothing.
 */
export const passwordChangeRateLimit = createRateLimit({
  perIp: signInPerIp,
  chargeStatuses: [403],
  reserve: true,
  message: 'Too many password attempts.',
});

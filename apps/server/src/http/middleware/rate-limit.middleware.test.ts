import type { Context } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOnceWarnings } from '../../lib/log';
import { TokenBucketLimiter } from '../../lib/rate-limit';
import { clientIp, createRateLimit } from './rate-limit.middleware';

function build(capacity: number, now: () => number) {
  const app = new Hono();
  app.use(
    '*',
    createRateLimit({
      perIp: new TokenBucketLimiter({ capacity, refillPerSecond: 1, now }),
      shared: new TokenBucketLimiter({ capacity: 1_000, refillPerSecond: 100, now }),
    }),
  );
  app.get('/hit', (c) => c.json({ ok: true }));
  app.get('/miss', (c) => c.json({ code: 'not_found', message: 'Not found.' }, 404));
  return app;
}

// @hono/node-server puts the IncomingMessage on c.env.incoming; app.request's third
// argument is that env, so the same extraction path is exercised here as in production.
const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });

// The header belongs in the request init; the connecting address belongs in the env.
const forwarded = (ip: string, chain: string) =>
  [{ headers: { 'x-forwarded-for': chain } }, from(ip)] as const;

describe('createRateLimit', () => {
  it('never charges a successful lookup', async () => {
    const now = 0;
    const app = build(2, () => now);

    for (let i = 0; i < 10; i++) {
      expect((await app.request('/hit', undefined, from('1.1.1.1'))).status).toBe(200);
    }
  });

  it('admits the burst, then answers 429 with Retry-After', async () => {
    const now = 0;
    const app = build(2, () => now);

    expect((await app.request('/miss', undefined, from('2.2.2.2'))).status).toBe(404);
    expect((await app.request('/miss', undefined, from('2.2.2.2'))).status).toBe(404);

    const throttled = await app.request('/miss', undefined, from('2.2.2.2'));

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Retry-After')).toBe('1');
  });

  it('refills over time', async () => {
    let now = 0;
    const app = build(1, () => now);
    await app.request('/miss', undefined, from('3.3.3.3'));

    expect((await app.request('/miss', undefined, from('3.3.3.3'))).status).toBe(429);

    now += 1_000;

    expect((await app.request('/miss', undefined, from('3.3.3.3'))).status).toBe(404);
  });

  it('can render a transport-specific limited response', async () => {
    const now = 0;
    const app = new Hono();
    app.use(
      '*',
      createRateLimit({
        perIp: new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: () => now }),
        onLimited: (c) => c.html('<title>Slow down</title>', 429),
      }),
    );
    app.get('/miss', (c) => c.json({ code: 'not_found', message: 'Not found.' }, 404));

    await app.request('/miss', undefined, from('3.3.3.4'));
    const throttled = await app.request('/miss', undefined, from('3.3.3.4'));

    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('Content-Type')).toContain('text/html');
    expect(await throttled.text()).toBe('<title>Slow down</title>');
  });

  it('throttles one address without touching another', async () => {
    const now = 0;
    const app = build(1, () => now);
    await app.request('/miss', undefined, from('4.4.4.4'));

    expect((await app.request('/miss', undefined, from('4.4.4.4'))).status).toBe(429);
    expect((await app.request('/miss', undefined, from('5.5.5.5'))).status).toBe(404);
  });
});

function buildFor(options: {
  capacity: number;
  chargeStatuses?: number[];
  trustedProxies?: readonly string[];
  reserve?: boolean;
  slowMs?: number;
}) {
  const now = 0;
  const app = new Hono();
  app.use(
    '*',
    createRateLimit({
      perIp: new TokenBucketLimiter({
        capacity: options.capacity,
        refillPerSecond: 1,
        now: () => now,
      }),
      chargeStatuses: options.chargeStatuses,
      trustedProxies: options.trustedProxies,
      reserve: options.reserve,
    }),
  );
  app.get('/miss', (c) => c.json({ code: 'not_found', message: 'Not found.' }, 404));
  app.get('/refused', async (c) => {
    // Stands in for the deliberately slow hash a real sign-in awaits.
    if (options.slowMs) {
      await new Promise((resolve) => setTimeout(resolve, options.slowMs));
    }
    return c.json({ code: 'invalid_credentials', message: 'No.' }, 401);
  });
  app.get('/ok', (c) => c.json({ ok: true }));
  return app;
}

describe('reserve', () => {
  it('bounds attempts that are in flight together, not just ones that have answered', async () => {
    const app = buildFor({ capacity: 3, chargeStatuses: [401], reserve: true, slowMs: 20 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => app.request('/refused', undefined, from('9.1.1.1'))),
    );

    // Without the reservation every one of the ten passes the check before any of them has
    // answered, and the budget of three is spent ten times over.
    expect(results.filter((res) => res.status === 401)).toHaveLength(3);
    expect(results.filter((res) => res.status === 429)).toHaveLength(7);
  });

  it('refunds a status that costs nothing, so success is still free', async () => {
    const app = buildFor({ capacity: 2, chargeStatuses: [401], reserve: true });

    for (let i = 0; i < 10; i++) {
      expect((await app.request('/ok', undefined, from('9.2.2.2'))).status).toBe(200);
    }
  });
});

describe('chargeStatuses', () => {
  it('charges the configured status and nothing else', async () => {
    const app = buildFor({ capacity: 1, chargeStatuses: [401] });

    expect((await app.request('/miss', undefined, from('6.6.6.6'))).status).toBe(404);
    expect((await app.request('/refused', undefined, from('6.6.6.6'))).status).toBe(401);

    expect((await app.request('/refused', undefined, from('6.6.6.6'))).status).toBe(429);
    // The 404 above cost nothing, so the same address still has its whole budget there.
    expect((await app.request('/miss', undefined, from('7.7.7.7'))).status).toBe(404);
  });
});

describe('clientIp behind a proxy', () => {
  it('buckets by the rightmost forwarded entry when the proxy is trusted', async () => {
    const app = buildFor({ capacity: 1, trustedProxies: ['10.0.0.9'] });
    const proxy = from('10.0.0.9');

    await app.request('/miss', { headers: { 'x-forwarded-for': '1.1.1.1' } }, proxy);

    expect(
      (await app.request('/miss', { headers: { 'x-forwarded-for': '1.1.1.1' } }, proxy)).status,
    ).toBe(429);
    expect(
      (await app.request('/miss', { headers: { 'x-forwarded-for': '2.2.2.2' } }, proxy)).status,
    ).toBe(404);
  });

  it('cannot be displaced by an entry the client supplied', async () => {
    const app = buildFor({ capacity: 1, trustedProxies: ['10.0.0.9'] });
    const proxy = from('10.0.0.9');
    const spoofed = { headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } };

    await app.request('/miss', spoofed, proxy);

    // Bucketed on 1.1.1.1, the entry the trusted proxy appended, not on the forged one.
    expect((await app.request('/miss', spoofed, proxy)).status).toBe(429);
    expect(
      (await app.request('/miss', { headers: { 'x-forwarded-for': '9.9.9.9' } }, proxy)).status,
    ).toBe(404);
  });

  it('ignores the header from an address that is not a trusted proxy', async () => {
    const app = buildFor({ capacity: 1, trustedProxies: ['10.0.0.9'] });

    await app.request('/miss', ...forwarded('8.8.8.8', '1.1.1.1'));

    expect((await app.request('/miss', ...forwarded('8.8.8.8', '2.2.2.2'))).status).toBe(429);
  });

  it('ignores the header entirely when no proxy is trusted', async () => {
    const app = buildFor({ capacity: 1, trustedProxies: [] });

    await app.request('/miss', ...forwarded('8.8.8.9', '1.1.1.1'));

    expect((await app.request('/miss', ...forwarded('8.8.8.9', '2.2.2.2'))).status).toBe(429);
  });

  it('matches a configured IPv4 address against an IPv4-mapped connection', async () => {
    const app = buildFor({ capacity: 1, trustedProxies: ['10.0.0.9'] });
    const proxy = from('::ffff:10.0.0.9');

    await app.request('/miss', { headers: { 'x-forwarded-for': '1.1.1.1' } }, proxy);

    expect(
      (await app.request('/miss', { headers: { 'x-forwarded-for': '1.1.1.1' } }, proxy)).status,
    ).toBe(429);
  });
});

describe('trusted-proxy misconfiguration warnings', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetOnceWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lines = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  it('warns once when a trusted proxy appends no forwarded header', async () => {
    const app = buildFor({ capacity: 1_000, trustedProxies: ['10.0.0.9'] });

    for (let i = 0; i < 100; i++) {
      await app.request('/miss', undefined, from('10.0.0.9'));
    }

    expect(warn).toHaveBeenCalledOnce();
    expect(lines()[0]).toContain('one throttle bucket');
  });

  it('warns once per unlisted address that carries a forwarded header, naming it', async () => {
    const app = buildFor({ capacity: 1_000, trustedProxies: ['10.0.0.9'] });

    for (let i = 0; i < 10; i++) {
      await app.request('/miss', ...forwarded('172.18.0.4', '1.1.1.1'));
    }

    expect(warn).toHaveBeenCalledOnce();
    expect(lines()[0]).toContain('172.18.0.4');
  });

  it('warns for a second unlisted address rather than suppressing it behind the first', async () => {
    const app = buildFor({ capacity: 1_000, trustedProxies: ['10.0.0.9'] });

    await app.request('/miss', ...forwarded('172.18.0.4', '1.1.1.1'));
    await app.request('/miss', ...forwarded('203.0.113.7', '1.1.1.1'));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(lines()[1]).toContain('203.0.113.7');
  });

  it('emits both warnings in a process that meets both shapes, distinguishably', async () => {
    const app = buildFor({ capacity: 1_000, trustedProxies: ['10.0.0.9'] });

    await app.request('/miss', undefined, from('10.0.0.9'));
    await app.request('/miss', ...forwarded('172.18.0.4', '1.1.1.1'));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(lines()[0]).not.toBe(lines()[1]);
    expect(lines()[0]).not.toContain('172.18.0.4');
  });

  it('stays silent when no proxy is trusted, which the boot warning already covers', async () => {
    const app = buildFor({ capacity: 1_000, trustedProxies: [] });

    await app.request('/miss', ...forwarded('172.18.0.4', '1.1.1.1'));
    await app.request('/miss', undefined, from('172.18.0.4'));

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent on the correctly configured path', async () => {
    const app = buildFor({ capacity: 1_000, trustedProxies: ['10.0.0.9'] });

    await app.request('/miss', { headers: { 'x-forwarded-for': '1.1.1.1' } }, from('10.0.0.9'));

    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves the same client address in every one of those shapes', () => {
    const contextFor = (remoteAddress: string, chain?: string) =>
      ({
        env: { incoming: { socket: { remoteAddress } } },
        req: { header: () => chain },
      }) as unknown as Context;

    const trusted = ['10.0.0.9'];

    expect(clientIp(contextFor('10.0.0.9'), trusted)).toBe('10.0.0.9');
    expect(clientIp(contextFor('10.0.0.9', '1.1.1.1'), trusted)).toBe('1.1.1.1');
    expect(clientIp(contextFor('172.18.0.4', '1.1.1.1'), trusted)).toBe('172.18.0.4');
    expect(clientIp(contextFor('172.18.0.4', '1.1.1.1'), [])).toBe('172.18.0.4');
    expect(clientIp(contextFor('::ffff:10.0.0.9', '1.1.1.1'), trusted)).toBe('1.1.1.1');
  });
});

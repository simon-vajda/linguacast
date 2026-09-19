import path from 'node:path';
import { z } from 'zod';

const BaseEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Resolved against the bundle, so it survives relocation by `pnpm deploy` or a COPY.
  // Under tsx it points at src/, where no public/ exists, which is right: Vite serves dev.
  WEB_ROOT: z
    .string()
    .min(1)
    .default(path.join(import.meta.dirname, 'public')),
  // Everything the operator must keep: the SQLite database and admin.json both live here,
  // so one mount and one variable cover the whole of it. Resolved against the working
  // directory, unlike WEB_ROOT — user data would be destroyed by every redeploy if it
  // lived inside dist/.
  DATA_DIR: z.string().min(1).default('./data'),

  // The addresses a reverse proxy may reach us from. Unset means no X-Forwarded-For is
  // ever believed: the app stays reachable at its own port on the LAN, so an unconditional
  // trust would let anyone forge an address and walk past the throttle.
  TRUSTED_PROXY_IPS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),

  // What the workers bind. 0.0.0.0 is right behind a router doing the forwarding.
  MEDIA_LISTEN_IP: z.string().min(1).default('0.0.0.0'),
  // Where guests reach this server for audio, which bypasses the reverse proxy entirely:
  // a public hostname or a public IP. There is no safe default — a wrong value produces
  // well-formed ICE candidates nobody can connect to, with no error anywhere, so
  // production refuses to boot without it. Announced verbatim, and
  // `core/media/announced-address.ts` resolves it so the literal is offered alongside it.
  PUBLIC_ADDRESS: z.string().min(1).optional(),
  // Worker i binds base + i, on UDP and TCP. The operator forwards this many ports.
  MEDIA_RTC_PORT_BASE: z.coerce.number().int().min(1024).max(65_000).default(44400),
  MEDIA_MAX_WORKERS: z.coerce.number().int().positive().max(64).default(4),
  MEDIA_ROOM_IDLE_GRACE_MS: z.coerce.number().int().positive().optional(),

  // The verbose logging tier: per-transport ICE and DTLS narration, and the guest
  // addresses that go with it. Off by default because the always-on tier is sized to
  // diagnose a ticket without it, and its volume would bury that tier at event scale.
  LOG_VERBOSE: z
    .string()
    .default('')
    .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())),

  // Defaulted rather than left off: a guest behind a symmetric NAT needs one to discover
  // the address to advertise, and a deployment shipping without it fails for exactly the
  // guests least able to diagnose it. Set the variable empty to decline the default — a
  // STUN server this reaches is a third party learning that a guest connected here.
  MEDIA_STUN_URL: z
    .string()
    .default('stun:stun.l.google.com:19302')
    .transform((value) => value.trim() || undefined),
});

export const EnvSchema = BaseEnvSchema.refine(
  (env) => env.NODE_ENV !== 'production' || env.PUBLIC_ADDRESS !== undefined,
  {
    path: ['PUBLIC_ADDRESS'],
    message: 'Required in production: guests connect to this address directly for audio.',
  },
  // Loopback is the only address that is honest when nothing was configured: it works for
  // a browser on this machine and fails visibly anywhere else.
).transform((env) => ({ ...env, PUBLIC_ADDRESS: env.PUBLIC_ADDRESS ?? '127.0.0.1' }));

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;

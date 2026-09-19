# apps/server

Rules local to the server. Repo-wide rules, the socket protocol and versioning live in the root `AGENTS.md`.

## Structure

- Hono + `@hono/zod-openapi`. `app.ts` builds the app without listening; `index.ts` owns the listener, runs migrations, then `serve()`.
- `defaultHook` must be passed to **every** `OpenAPIHono` instance that registers routes — sub-apps do not inherit it.
- `src` is split by dependency direction:
  - `core/` — the domain. Must not import `hono`, `@hono/zod-openapi` or `socket.io`, nor reach into `http/` or `socket/`. May import `drizzle-orm`, `better-sqlite3`, `mediasoup`.
  - `http/` — every Hono-coupled module.
  - `socket/` — every Socket.IO-coupled module; `socket/lib/` plumbing, `socket/handlers/` per-feature events.
  - `lib/` — neither domain knowledge nor transport coupling (`log.ts`, `problem.ts`, `rate-limit.ts`, `semver.ts`).
  - `logging/` — subscribers that read the notification bus to write a log line. Consumers of `core/`, never a dependency of it, so they sit outside it; they stay free of the `db` and `notifications` singletons (importing either opens a file at module scope) and `index.ts` does the wiring.
  - `db/` — its own conventions (below).
- Boundary enforced by `core/boundary.test.ts`, a source scan that includes relative paths: `docs/solutions/architecture-patterns/guard-a-layer-boundary-with-a-self-testing-import-scan.md`.
- Nothing is injected into `core/`. Module singletons (`db`, `core/media`, `core/auth`) are reached by import. No handler registry maps event names to handlers as data.

## Database

- better-sqlite3 + Drizzle. `db/client.ts` holds `createDb(path)` and must stay free of import side effects; `db/index.ts` holds the `db` singleton and opens the file at module scope. `db/testing.ts` imports the factory, never the singleton.
- After changing `schema.ts`: `pnpm -F @linguacast/server db:generate`, read the SQL, commit it. `drizzle-kit push` is rejected. There is no `db:migrate` script — `runMigrations(db)` runs at boot, so upgrading is "pull and restart".
- `db/migrations` is excluded from Biome (drizzle-kit rewrites its JSON without a trailing newline). Migration `0000` stays in history although `0001` dropped its `meta` table.
- `migrate.ts` resolves migrations against `import.meta.dirname` (they ship at `dist/migrations`); `DATA_DIR` resolves against the working directory, because the database is user data.
- The four pragmas in `createDb` are non-defaults. `foreign_keys` is per-connection and silently inert when unset, hence its test.
- `drizzle-zod` is deliberately absent. Row types come from `$inferSelect`/`$inferInsert`; API schemas are never derived from tables.
- Tables `events` and `channels`, both default disabled, no lifecycle column. `pin` and `speaker_code` are regenerable natural keys, never primary keys. A channel `slug` is immutable and unique within its event (`channels_event_id_slug_unique`).
- The admin events list issues one `listChannels` per event — deliberate at this scale.

## HTTP

- 404 parity: disabled event, disabled channel and unknown PIN produce byte-identical responses (test in `http/routes/events.routes.test.ts`). Channel lookup checks existence before the speaker code. Failed public lookups are rate limited per IP (burst 20, refill 1/s) with a smaller global budget, charged on 404 only.
- `http/spa.routes.ts` serves the production SPA: every Vite output is static except `index.html`, read once at boot. It requires the single `linguacast:metadata` marker pair and replaces only the four escaped title/description tags. Exact event/channel URLs get indexed lookups and event/listener/speaker metadata; missing or disabled resources return the shell with 404, a stale non-empty speaker code with 403. The speaker code is compared, never rendered. Page lookups share the public rate-limit buckets. Rendered shells are `no-cache`; `/assets/*` stay immutable. A missing web build is normal in development; a present build with no usable index is fatal.

## Auth

- `core/auth/`: `password.ts` (scrypt, self-describing hashes, a dummy hash for unknown usernames, a semaphore bounding concurrent 32 MB derivations), `credentials.ts` (`admin.json`, atomic write, strict parse), `account.ts` (singleton from `startAuth()`), `sessions.ts`, `index.ts` facade.
- Credentials live only in `DATA_DIR/admin.json` — never SQLite, never a hand-edited config. Recovery is deleting that file and restarting. Read once at boot; a file that exists but does not parse is **fatal**, never "unconfigured" (that would reopen the account-claim window).
- `createAccount` takes its claim synchronously before hashing. `resetAuth()` exists for tests.
- Sessions are rows keyed on SHA-256 of the token, never the token. 30 days, renewed only within the last day, swept at boot and deleted when found expired.
- Cookie `__Host-linguacast_session` (the prefix must appear at all three call sites in `http/session-cookie.ts`), httpOnly, `SameSite=Lax`, `Secure` unconditionally.
- Endpoints are `/auth/*`, outside `/admin`. `http/middleware/require-admin.middleware.ts` checks an account exists **before** checking the session. Refusals are a 401 `Problem`, never a redirect.
- Sign-in is throttled per address and never locked out: `createRateLimit` charges 401 and 409, with **no** shared global budget (against one account that is a lockout of the correct password). The semaphore bounds scrypt load instead.
- `clientIp` believes the rightmost `X-Forwarded-For` entry only from an address in `TRUSTED_PROXY_IPS`; unset means never.
- A signed-in admin changes the password at `POST /admin/password`, behind `requireAdmin`. A wrong current password is 403 `invalid_credentials`, never 401 (under `/admin` that signs the client out). It spends the sign-in per-address bucket (`passwordChangeRateLimit` charges 403). Success rotates sessions: delete all, issue the caller a fresh one. `verifyCredentials` refuses when the account was replaced during its derivation, so an in-flight sign-in cannot outlive the rotation. There is no reset surface: a forgotten password is still recovery by deleting `admin.json`.

## Presence, handover, reports, notifications

- `core/presence.ts` holds the broadcast claim in memory, never SQLite. It tracks every studio socket per channel. `isOnline` (an unclosed producer exists) lives elsewhere; the claim means broadcast rights.
- The claim is keyed on a **studio session** — an opaque id the studio page generates once — so a reconnect rebinds, a reload is a different studio, and a `release` from a replaced socket is a no-op in either order (`docs/solutions/conventions/state-keyed-on-a-studio-session-follows-its-reconnect.md`). Taken by `take` at go-live, moved only by `core/handover.ts` promotion; every transition publishes one `claim-changed`.
- The claim carries its on-air start; rebinds and moves inherit it (including a move after the holder's socket dropped), and only a release with nobody waiting resets it. It reaches the studio as `onAirMs` on the handover snapshot, never on `ChannelStatus`.
- `authorizeHandshake` makes the whole connection decision, **takes no claim**, registers the studio socket, rebinds a session that already holds the claim, and stays synchronous so the lookup and rebind cannot interleave. `presence.release` on disconnect is its other half. There is no `channel_busy` and no displaced socket.
- `core/handover.ts`: at most one pending request per channel; `TAKEOVER_AFTER_MS` 30 000; `GRANT_DEADLINE_MS` 10 000; injectable clock; one unref'd timer per channel; `handover-changed`/`handover-granted` notifications. Confirm, force, end and depart all reach one `grant` — permission to produce, not the claim. The claim moves at `complete`. A cancelled grant reaches media through `onGrantCancelled` (a registration point, to avoid an import cycle).
- Produce is authorised by the claim (`channel_taken` otherwise), taken before the handler's first `await` and released if produce fails. A granted produce runs beside the standing producer; the swap window closes when the last listener leaves the outgoing producer or at `SWAP_DEADLINE_MS`. A producer replaced by a swap closes silently.
- `core/reports.ts`: per-channel process-memory tally — five problem categories in a five-minute window, a positive `Audio sounds good now` tally in a 30-second window, a two-minute per-socket category cooldown, one unref'd timer per channel at the next expiry. An accepted problem opens a connection-scoped feedback episode; its positive follow-up clears that connection's active entries but keeps hidden timestamps until the cooldown passes. Confirmation, disconnect or a deliberate end closes the episode. Cooldown bounds a connection, not a person — accepted; do not key on address or a client identifier.
- `core/listener-history.ts`: per-channel process-memory series of coalesced listener counts, appended only on a change and pruned to the shared window plus the newest point before it. It belongs to the claim's `startedAt`, not to a producer, so a speaker reconnect, a handover and a take-over all continue one broadcast while a new `startedAt` resets it. Recorded in the `ListenerCountPublisher`'s `publish` wrapper, so every point is a change somebody could see. Forgotten beside `reports.forgetChannel` on a deliberate end and on revocation — **never on room close**, because a dead worker keeps the claim while clients renegotiate and forgetting there would redraw the hour behind it as a flat zero.
- Reports and listener counts are seeded on `claim-changed` to the socket that acquired or rebound the claim, not on connect; the connect handler re-seeds a studio that already holds it (a rebind publishes before Socket.IO can address the socket). The handover snapshot **is** sent unconditionally on connect. All report guards (membership, producer, cooldown) are server-side; a non-member gets the same `not_found` as an unknown slug.
- `core/notifications.ts` is a typed subscribe registry for events originating in `core/`; `socket/index.ts` is its only subscriber and the only place an eviction becomes a disconnect. `EvictionReason` is `worker_died` or `access_revoked` only. Revoking a channel evicts **every** studio socket on it.

## Socket implementation

- Socket.IO attaches at the `http.Server` and intercepts `/api/socket.io` before Hono — invisible from `app.ts`.
- Register handlers with `on(socket, 'event', fn)` from `socket/lib/on.ts`, never `socket.on`. There is no compile-time exhaustiveness: an unregistered client event surfaces at runtime as an `unknown_event` ack.
- Rooms are nested: selector listeners are in the event room; channel listeners are in both. Aggregates (`channel:status`) go to the event room, per-channel signalling to the channel room. Membership is re-established in the connect handler, because Socket.IO replays auth on reconnect.

## Media

- `core/media/`: `config.ts` (codecs, listen infos, ICE servers, candidate augmentation), `workers.ts`, `room.ts`, `peer.ts`, `registry.ts` (one room per event, creation slot, idle teardown), `announced-address.ts`, `reflexive-address.ts`, `index.ts` facade. Singleton started by `startMedia()`; `testing.ts` starts it on fake workers.
- One router per **event**, never per channel, so a language switch is a consumer swap. Nothing is piped between routers (one event is capped at one core; the pool is for crash isolation). A room is created only by a produce and torn down after a grace period once empty. A worker failing at boot is fatal; one dying later is not.
- Media state is never persisted; client recovery is described under "Media recovery" in the root `AGENTS.md`.
- `PUBLIC_ADDRESS` is announced verbatim and resolved to IPv4 at boot — fatally if unresolvable or answering only private/loopback — and re-resolved every minute. `augmentCandidates` offers a literal-addressed twin of every candidate with priority lifted clear of every hostname candidate. A polled change rebuilds nothing and evicts nobody; the next transport carries the new literal. `media:reset` has no `address_changed` reason. See `docs/solutions/integration-issues/announce-a-resolved-address-because-firefox-drops-hostname-ice-candidates.md` and `docs/solutions/integration-issues/derive-appended-ice-candidate-priorities-from-the-whole-list.md`.
- `reflexive-address.ts` is a boot-time STUN cross-check, never a source for the announced address. Fire-and-forget, skipped when the address is known unroutable, off unless `probeReflexiveAddress` is passed (only `index.ts` does; tests must never send a datagram). It re-probes on `AnnouncedAddress.onChange` and binds an ephemeral port, so only the address is compared.

## Environment

- `DATA_DIR` holds both user-data files, `linguacast.db` and `admin.json`; each filename lives with its owner.
- `TRUSTED_PROXY_IPS` — optional, comma-separated, unset by default. A listed proxy sending no forwarded header, and a forwarded header from an unlisted address, each warn once per process (the second once per observed address); both are otherwise silent.
- `LOG_VERBOSE` — the verbose logging tier, off by default. Parsed as a defaulted string read as true for `1`, `true`, `yes` or `on`, so a typo leaves it off. `env.ts` keeps its own `console.error`: it fires before a parsed environment exists, and routing it through the writer would be an import cycle.
- Media: `PUBLIC_ADDRESS` (required in production, no safe default), `MEDIA_LISTEN_IP`, `MEDIA_RTC_PORT_BASE` (worker *i* binds base + *i* on UDP and TCP), `MEDIA_MAX_WORKERS`, `MEDIA_ROOM_IDLE_GRACE_MS`, `MEDIA_STUN_URL` (public default; empty means off, parsed as a defaulted string trimmed to `undefined`). A network blocking both UDP and TCP to the RTC ports is not served.
- Operator-facing text (`.env.example`, `docs/hosting.md`, boot logs, errors) says "public address", never "announced address" or "ICE candidate". Internally it stays `announcedIp`. The startup summary names both the configured and resolved address.

## Tests

- `testing/api.ts` sets `DATA_DIR` before **dynamically** importing `../db`; a static import would provision the real `./data/linguacast.db`.
- A test reaches `core/auth` **only** through `createTestApi()` (`signInAsAdmin`, `createSession`, `resetAuth`, `SESSION_TTL_MS`). A static `import … from '../core/auth'` anywhere in a test's graph loads `env.ts` early, and `resetAuth()` then deletes the operator's real `admin.json`. `createTestApi` passes an explicit `admin.json` path to `startAuth()` for the same reason.

## Deployment

- `Dockerfile`, `.dockerignore`, `compose.yaml`, `.env.example`, `docker/entrypoint.sh` and `.github/workflows/server-release.yml` are the deployment artifact; `docs/hosting.md` is the operator guide.
- The image compiles once on `$BUILDPLATFORM` and installs only the two tsdown externals per `$TARGETPLATFORM` from the manifest `scripts/emit-runtime-manifest.mjs` generates.
- The mediasoup worker is fetched explicitly against a pinned `MEDIASOUP_WORKER_KERNEL`; the build asserts exit status 41 (a prebuilt binary ran). See `docs/solutions/integration-issues/pin-mediasoups-prebuilt-worker-to-a-kernel-line-the-base-image-can-load.md`.
- The entrypoint owns `/data` and drops privileges with `setpriv` unless Compose's `user:` already did.
- RTC ports are published one-to-one; a remapped port breaks audio silently.
- Every operator setting lives in `.env.example` only. Uncommented lines are decisions (`PUBLIC_ADDRESS`, `TRUSTED_PROXY_IPS`, `LINGUACAST_VERSION`); defaults stay commented. `compose.yaml` reads it via `env_file` and interpolates `LINGUACAST_VERSION`; `PUBLIC_ADDRESS` is repeated under `environment:` only for its `:?` guard.

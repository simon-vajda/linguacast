# AGENTS.md

Guidance for coding agents working in this repository. This file holds what applies everywhere; each app carries its own `AGENTS.md` for rules local to it, loaded when working there:

- `apps/server/AGENTS.md` — domain layers, persistence, auth, presence and handover, media, deployment.
- `apps/web/AGENTS.md` — routing, shadcn customisations, design scale, studio/guest/admin surfaces, browser audio.
- `apps/mobile/AGENTS.md` — Expo listener, native audio module, theme, sheets.

Keep these files current as decisions are made. A rule goes in the narrowest file that covers every place it applies. Rationale longer than a clause belongs in `docs/solutions`, linked from the rule.

## Product

LinguaCast is a self-hosted, open-source simultaneous-interpretation platform for live in-person events; low audio latency is the core requirement. It targets one modest server run by a church or educational institution, a handful of concurrent events, and tens to low hundreds of listeners. Prefer simple operation over scale; horizontal scaling, multi-tenancy, sharding and cloud-managed dependencies are out of scope.

There is one authenticated Admin. Events own Channels; an Event PIN grants listening, a per-Channel Speaker code grants broadcasting. Speakers and listeners have no accounts: possession of the link or code is the entire authorization. Preserve that property and question features that appear to need listener identity. `CONCEPTS.md` is the authoritative domain vocabulary.

## Status

Implemented: workspace, contract, API, SQLite persistence, validated Socket.IO transport, authenticated admin, design-complete web screens, end-to-end mediasoup audio, and a working Expo listener (`apps/mobile`) with lock-screen media controls. Two interpreters sharing a channel swap through a negotiated handover, not a takeover.

Not built: the **mobile speaker studio** — the next mobile work. Deferred with reasons: moving `apps/mobile/src/media/{transport,device,diagnostics}.ts` into `packages/client-core` (wait for a second mediasoup shell to shape the seam); an app-drawn output device list (neither platform offers one); replacing the web silent-WAV carrier; app icon, splash, store metadata, EAS config and store automation.

Non-blocking follow-ups: automated `/data` backup and a pre-flight "someone is waiting" signal. That signal needs channel-room membership and a new concept — do not relax the meaning of `Listening`, because a guest waiting on an offline Channel allocates nothing server-side.

Settings storage: mobile appearance is device-local (see mobile file); storage for other settings is undecided. Record further decisions here.

## Layout

- `packages/contract` — hand-written Zod schemas and `createRoute()` definitions, consumed as TypeScript source (never built).
- `packages/client-core` — platform-free client logic both apps consume as source.
- `tools/openapi-codegen` — holds `typescript@5.9.3` for OpenAPI codegen only.
- `apps/server` — Hono + `@hono/zod-openapi`, Socket.IO, SQLite/Drizzle, mediasoup.
- `apps/web` — Vite 8 + React 19 SPA, TanStack Router.
- `apps/mobile` — Expo SDK 57 + React Native 0.86 listener.
- `docs/solutions` — solutions to past problems, filed by category with YAML frontmatter (`module`, `tags`, `problem_type`); read the entries covering an area before working in it.

## Commands

- `pnpm dev` — contract gen watcher, server on 3000 (`tsx watch`), Vite on 5173 proxying `/api`. Does **not** start Metro: run `pnpm -F @linguacast/mobile start`.
- `pnpm gen` — regenerate `packages/contract/openapi.json` and `src/generated/api.d.ts`. Run after any schema or route change; CI fails on drift.
- `pnpm typecheck` — runs `pnpm gen` first, so a clean `git status` afterwards *is* the drift check.
- `pnpm check` / `pnpm check:fix` — Biome, plus `version:check`.
- `pnpm test` — Vitest in server, web, contract and client-core, plus `jest-expo` in mobile. `pnpm -r` silently skips a package without a matching script.
- `pnpm build` — contract gen, web build, server build (`tsdown` + `scripts/copy-migrations.mjs`), web `dist` copied into `apps/server/dist/public`.

## Toolchain

- Node 24 LTS (`.nvmrc`, `engines.node`). Stay on LTS: mediasoup is a native addon.
- Every real package pins `typescript@7.0.2`. TypeScript 5 must stay unreachable as a binary from any package that compiles source; `pnpm why -r typescript` is the check. See `docs/solutions/architecture-patterns/isolate-a-legacy-compiler-behind-a-codegen-tool-package.md`.
- No `tsconfig.json` may declare `baseUrl` (removed in TypeScript 7); `paths` alone resolves.
- `@hono/zod-openapi` is pinned to exactly `1.4.0`. 1.5.x has broken declarations that silently degrade every schema type to `any` under `skipLibCheck`.
- `pnpm-workspace.yaml` `allowBuilds`: `better-sqlite3` is `false` (do not `pnpm approve-builds` it — `docs/solutions/integration-issues/decline-the-inferred-native-build-for-better-sqlite3.md`); `mediasoup` is `true` because its postinstall downloads the prebuilt worker.
- Vitest tests import `describe`/`it`/`expect` explicitly; never enable `globals` (it would break `packages/contract`'s `"types": []`). `*.test-d.ts` files are type assertions checked by `pnpm typecheck`.

## Shared packages

**`packages/contract`**
- Every export points at TypeScript source; consumers compile it. Never add a build step.
- `src/socket` is behind `./socket` and is **not** re-exported from the root barrel, which pulls in Hono via `./openapi`. Browser and mobile clients import subpaths only. `./schemas` also pulls in Hono.
- `./patterns` holds the bare regexes (`PIN_PATTERN`, `SLUG_PATTERN`, `SEMVER_PATTERN`) and the password rules (`PASSWORD_MIN_LENGTH`, `PASSWORD_NUMBER_PATTERN`, `PASSWORD_SPECIAL_PATTERN`, plus the request-size ceiling `PASSWORD_MAX_LENGTH`, which is not a checklist line). A space counts as the special character.
- `./page-titles` keeps public browser titles identical between server-rendered HTML and SPA navigation.
- Imports neither `socket.io` nor mediasoup. Its tsconfig sets `"types": []` with no DOM: a `node:` or DOM import in `src` must fail to compile.
- `scripts/gen.ts` reads `apps/server/package.json` for `info.version`; no file under `src` may do that.
- Route paths are declared without `/api`; the prefix lives in the document's `servers` entry and the server mount.

**`packages/client-core`**
- Consumed as source like the contract, with subpath exports (`./socket`, `./channel`, `./media`, `./server`, `./query-retry`).
- Boundary is **no platform**: no DOM library, React Native, `expo-*`, mediasoup-client, or bare `window`/`document`/`navigator`/`localStorage`. Enforced by `test/boundary.test.ts`, which lives under its own tsconfig (`"types": ["node"]`), so `typecheck` is two invocations.
- React is a **peer** dependency. `react` and `@types/react` must stay at one version across web and mobile, or Metro resolves a second React and the first hook throws invalid-hook-call. `dependenciesMeta.injected` is rejected: it is a build step.
- Mobile runs the React Compiler and web does not, so hooks here are auto-memoized on one platform only. Accepted.
- Platform-coupled media code (mediasoup shells, capture, audio-session hooks) stays in the app that owns it.

## Socket protocol

Applies to the server and both clients.

- Endpoint `path: '/api/socket.io'` on the default namespace — a path, not a namespace, so one proxy rule covers API and socket.
- Validation is asymmetric: the server parses everything from a client; the client trusts the server. Version drift is handled once, at the handshake.
- Client sets `ackTimeout: 10_000` and must **never** set `retries` (replay; signalling is not idempotent). Server `HANDLER_TIMEOUT_MS` is 8s, below the client deadline.
- Handshake: `{ clientVersion, pin, speakerCode?, studioSession? }`; `speakerCode` and `studioSession` are required together. `clientType` defaults to `web`.
- Handover: four acked client verbs (`handover:request`, `handover:cancel`, `handover:confirm`, `handover:take-over`) with a **strictly empty** payload, and one server `handover:state` snapshot built per studio socket (`holder`, `role`, `pending`, `remainingMs`, `canTakeOver`). `canTakeOver` is the server's answer; never re-derive it from a client clock. See `docs/solutions/conventions/an-identifier-returned-to-a-client-is-not-a-capability.md`.
- `ChannelStatus` and the `channel:join` ack carry `producerId` and, during a swap, `incomingProducerId`, so a listener follows a replacement as one status rather than a close then an open.
- Reports: `channel:report` (client, acked) and `channel:reports` (server). The tally is addressed to the claim holder only, like `channel:listeners`.
- Listener history: `channel:listener-history` (server) carries `{ slug, points: [{ count, ageMs }] }`, oldest first, to the claim holder only. It is a snapshot, never a delta — sent once when a studio gains or rebinds the claim, and extended from `channel:listeners` after that. `LISTENER_HISTORY_WINDOW_MS` in `packages/contract` is the one window both sides prune to.
- Durations on the wire (`remainingMs`, `ageMs`, `onAirMs`) are anchored at receipt.

## Media recovery

Applies to the server and both clients.

- Media state is process memory: a reconnect and a server restart are indistinguishable, and every socket `connect` discards held identifiers and renegotiates from capabilities.
- A transport stuck `new`, `connecting` or `disconnected` for five seconds recovers on a ladder: first an ICE restart on the same transport, then full rebuilds, giving up after four. A direction that has never reached `connected` waits `ICE_FIRST_GATHER_DELAY_MS` instead; that fact and the attempt count live on the session per direction, so a rebuild neither shortens the deadline nor restarts the ladder. `failed` skips the restart and rebuilds immediately. A socket connect supersedes any attempt in flight.
- A rebuild calls `media:close-transport` first: the server permits one transport per direction per socket.
- Rebuilt transports inherit a Chromium page's stale network view; only a reload recovers. At the first five-second snapshot a receive transport whose literal local and offered candidate families don't overlap, with no candidate pairs, exposes the listener's `Reconnect` reload while recovery continues. Hostname or unknown-family candidates never justify that diagnosis. See `docs/solutions/integration-issues/recover-a-chromium-listener-whose-page-cannot-see-the-new-network.md`.
- A speaker re-produces after reconnect with the same `paused` value it had at drop time; recovery never forces a speaker muted or unmuted.

## Cross-cutting product rules

- **Listening** means a guest holding an open, locally unpaused consumer on the channel's producer — not a page being open. Counts appear only on the speaker studio and admin event detail; **no guest surface carries a count**.
- **No copy may claim anybody is hearing audio unless a producer exists.** Web enforces it in `broadcastState`, `listenActionState`, `statusNote`; mobile in `channel-copy.ts`, `report-rows.ts`, `server-check.ts`. All carry tests enumerating their strings against a forbidden-claim list — keep them when editing. No guest surface may state how long a channel has been on air.
- An unknown reading is not a negative one: withhold rather than relabel (`docs/solutions/conventions/an-unknown-reading-is-not-a-negative-one.md`).
- A disabled event, a disabled channel and a nonexistent PIN are indistinguishable to guests (`docs/solutions/conventions/identical-404s-for-disabled-and-nonexistent-resources.md`).
- A slot whose content toggles holds its size in every state, so a state change is a data change, not a re-layout.
- Listener broadcast badge reads `On air · muted` for a muted producer on web and mobile (shared `badgeLabel`); the studio's mute control and the report self-check keep `Muted`.
- Guest channel screens share one full-width `Report a problem` pill (`MessageCircleWarning`) at the thumb line, shown per `hasRequestedAudio` of reconciled intent, including startup and the temporary hold.
- **Server logging has exactly two tiers.** A line is always-on only if it answers a check in `docs/solutions/operations/diagnosing-live-audio-from-a-user-report.md` or places a failure on its capacity ladder; everything else is verbose, behind `LOG_VERBOSE`, off by default. Always-on cost is flat per event: no always-on line per listener, so listener volume appears only as the count at each on-air and off-air boundary and the peak between them. Listener addresses and short transport identifiers are verbose only. No line in either tier, server or client, carries a PIN, speaker code, session identifier or password. The runbook and this rule are written against each other; neither drifts alone.
- Every server line goes through `apps/server/src/lib/log.ts`, which stamps a self-emitted ISO-8601 timestamp and a subsystem prefix; the clients write through `apps/web/src/lib/log.ts` and `apps/mobile/src/log.ts`, whose informational and warning writers compile out of a production build while the error writer does not. Biome's `noConsole` forbids a bare call anywhere else outside tests and build scripts.
- Listener rings on web and mobile settle over 280ms when the interpreter mutes (visual only; playback and badge update immediately); stop listening and Reduce Motion hide them at once.

## Versioning

- Two release tracks: `apps/server/package.json` owns server + bundled web; `apps/mobile/package.json` owns mobile (and Expo's version via `app.config.ts`; `app.json` must not mirror it). Every other manifest stays private at `0.0.0`.
- `pnpm version:server [X.Y.Z]` / `pnpm version:mobile [X.Y.Z]` bump without committing, tagging or publishing. Tags are `server-vX.Y.Z` / `mobile-vX.Y.Z`.
- A release is a bump PR; the successful `main` build drafts it and publishing the draft on GitHub creates the tag and promotes the image. Never push a tag or push to `main`.
- Web handshake must equal the server version exactly. Mobile must meet `MIN_MOBILE_VERSION` (`apps/server/src/version.ts`); raise it whenever an older client would be left broken rather than merely behind.
- `MIN_SERVER_VERSION` (policy) and `SERVER_CAPABILITIES` (feature selection) in `packages/client-core/src/server/compatibility.ts` stay separate constants even while equal.
- A handshake with no `clientType` gets the legacy `client_too_old`; remove that and the default once no bundle predating server 0.4.0 can be open.
- Full contract: `docs/versioning.md` and the `release` skill — keep both current with each other.

## Working in this repo

- `docs/` is local-only scratch (plans, design handoffs, `docs/superpowers`) and gitignored on purpose; never stage it or "fix" its absence. Tracked exceptions: `docs/solutions`, `docs/hosting.md`, `docs/versioning.md`. `.claude/skills` is tracked; `.claude/settings.local.json` is not.
- Source comments must not depend on gitignored plan, requirement, decision, brainstorm or design identifiers. State the rationale self-contained or link tracked documentation.
- Directories name the role; filenames name the entity plus a role suffix (`.service.ts`, `.mapper.ts`, `.routes.ts`, `.middleware.ts`, `.handlers.ts`). A stem already unique and role-descriptive takes none. Tests are colocated as `<module>.test.ts`. File a module by what it is, not by where its only consumer lives.
- Helper-only test suites on web and mobile: never render a component; keep screen logic in a pure module beside the screen.

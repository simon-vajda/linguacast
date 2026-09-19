---
title: Diagnosing live audio from a user's description, with no monitoring stack
date: 2026-08-18
category: operations
module: apps/server/src/core/media
problem_type: operational_issue
component: media_pipeline
symptoms:
  - "Audio sounds robotic or crackly for everyone on one channel while other events are fine"
  - "A group of listeners loses audio at the same moment rather than individually"
  - "New listeners cannot join while the ones already connected are unaffected"
  - "Audio works on the venue network and is silent from mobile data"
root_cause: capacity_limit
resolution_type: operational_procedure
severity: medium
tags:
  - mediasoup
  - webrtc
  - capacity
  - troubleshooting
  - self-hosting
---

# Diagnosing live audio from a user's description

## Problem

A LinguaCast deployment has no monitoring stack, by design: it runs on a NAS box or a
consumer server in a church or a school, and nobody is watching a dashboard. A support
request is the only telemetry that exists, so the description of the symptom has to be
enough to identify the cause.

## The symptom ladder

These appear in this order as one event outgrows its single CPU core. One event is capped
at one core deliberately — nothing is piped between routers — so this ladder is the
expected failure sequence rather than a set of unrelated faults.

1. **"It crackled at the start, then was fine."** Join-burst CPU spike. ICE and DTLS
   negotiation is expensive, and a hundred people opening the link at once saturates the
   thread briefly. Self-clearing, and not a capacity problem in itself.
2. **"It sounds robotic for everyone on that channel."** Steady-state saturation of that
   event's router thread. Other events being unaffected is the distinguishing sign.
3. **"A bunch of people lost audio at the same time."** The same saturation, now delaying
   keepalives, so listeners fail together rather than individually.
4. **"New people can't join but the ones already listening are fine."** Contention has
   reached the signalling thread and the 8s handler timeout is firing.
5. **"Everyone dropped."** Process level. Recovery is a restart; clients renegotiate from
   capabilities on their own. Listener playback returns to idle because link loss clears its
   bounded recovery hold.

## What the log gives you before you ask for anything

Logging has two tiers. The **always-on** tier is sized so that a log pasted straight out of
`docker compose logs` answers the checks below on its own: it carries the server version,
the media configuration, both trusted-proxy misconfigurations, the three silent-failure
warnings (a transport that never connected, a producer receiving no RTP, a consumer
sending none), worker death and replacement, room-creation failure, socket handler
timeouts, unhandled errors, and a per-channel timeline of going on air and off air with
the listener count at each boundary and the peak between them. The timeline's cost is
flat per event — there is no always-on line per listener — so a healthy hundred-listener
event and a healthy five-listener one produce comparable volume. The silent-failure
warnings are per connection, so a deployment carrying no audio at all is loud in
proportion to its audience; that is the signal, not noise.

What is **not** always-on: a transport that connected and later dropped, and a DTLS
failure after a successful handshake. Both are per-connection narration and live in the
verbose tier. Every line carries a timestamp the server
emits itself and a subsystem prefix.

The **verbose** tier is off unless the operator sets `LOG_VERBOSE`. It adds the
per-transport narration: creation with its offered candidates, ICE and DTLS progress, the
selected candidate pair, close — and the short transport identifiers and **the network
addresses of the people listening** that go with them.

Ask for verbose only when the always-on tier has not settled it, and say this when you
ask: turn it on, reproduce the problem, turn it back off, and **read the excerpt before
pasting it into a ticket** — it names guests' addresses, and whether that disclosure is
acceptable for a particular congregation is the operator's judgment, not ours.

## First things to check, in order

1. Ask the affected listener what their active Channel screen says. **"Interpreter muted"**
   means the Producer still exists and the Channel is still Live; the interpreter paused it
   intentionally, so audio resumes without any infrastructure repair. Admin and Channel lists
   remain "On air" in this state by design. See
   [Separate channel liveness from listener mute state](../conventions/separate-channel-liveness-from-listener-mute-state.md).
2. The process is alive, and the version on its first log line is the one they think they
   are running.
3. The announced address in the startup log is the router's public address. A stale value
   is the most common silent failure: the candidates are well-formed and unreachable, and
   nothing errors anywhere. On a dynamic residential IP this is a DDNS problem. The
   always-on log says so from the other side too: a transport that has not connected
   within the silence window warns, with no verbose tier needed.
4. The guest link works from off the venue network — open it on mobile data. Silence there
   with audio on the LAN means the announced address is wrong.
5. The number of `mediasoup-worker` processes matches the configured worker count. The
   startup line prints the count against the detected core count; under Docker
   `os.cpus()` reports the host's cores rather than a `--cpus` quota, so a mismatch there
   is a misconfigured container.
6. If only one event is affected, its listener count against the capacity guideline. The
   channel timeline gives it without asking: each off-air line carries the peak reached
   while that channel was live.
7. Whether the channel was live at all at the time they name. The timeline's on-air and
   off-air lines, and the claim moving between studios, settle "it went quiet at 10:15"
   against "nobody was broadcasting then" without a round trip.
8. If a reverse proxy fronts the deployment, whether either trusted-proxy warning fired.
   Both are silent failures otherwise: a listed proxy that appends no forwarded header
   puts every visitor in one throttle bucket, and a forwarded header from an unlisted
   address is discarded.

## Capacity, and why the number is soft

Community figures put a mediasoup worker at roughly 500 audio consumers on cloud-class
CPUs. On NAS-class hardware a conservative planning figure is **150–250 listeners per
event**. This is an extrapolation, not a measurement — nobody has benchmarked mediasoup on
an N100 or comparable — so treat it as something to document and test against rather than
a fact. Whatever the real number is, an event that exceeds it degrades along the ladder
above rather than failing outright.

## Two things that are not the cause

- **The single shared UDP socket per worker.** Two hundred listeners at 20ms
  packetization is roughly ten thousand packets per second, orders of magnitude below
  where one socket's receive path contends. Recorded here so it is not reopened as a
  suspect when audio goes choppy; the cause will be the per-event core ceiling.
- **The jitter buffer.** It is deliberately left at the browser default. Enlarging it is
  the only latency knob left once forwarding is fixed, and spending it trades away the
  product's core requirement.

## A venue that blocks UDP

Every worker listens on TCP at the same port as its UDP one, so an institutional network
that blocks UDP still connects directly. A network that also blocks TCP to the RTC port
is not served.

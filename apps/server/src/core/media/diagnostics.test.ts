import { EventEmitter } from 'node:events';
import type { types } from 'mediasoup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchConsumer, watchProducer, watchTransport } from './diagnostics';

const { envMock } = vi.hoisted(() => ({ envMock: { LOG_VERBOSE: false } }));
vi.mock('../../env', () => ({ env: envMock }));

const SILENCE_CHECK_MS = 5_000;
const REMOTE_ADDRESS = '198.51.100.77';
const TRANSPORT_ID = 'abcdef0123456789';

class FakeTransport extends EventEmitter {
  readonly id = TRANSPORT_ID;
  readonly observer = new EventEmitter();
  closed = false;
  iceState = 'new';
  dtlsState = 'new';
  readonly iceCandidates = [{ protocol: 'udp', address: '203.0.113.10', port: 44400 }];
}

class FakeProducer {
  readonly id = TRANSPORT_ID;
  readonly observer = new EventEmitter();
  closed = false;
  paused = false;
  constructor(private readonly bytes: number) {}
  async getStats() {
    return [{ type: 'inbound-rtp', byteCount: this.bytes }];
  }
}

class FakeConsumer {
  readonly id = TRANSPORT_ID;
  readonly observer = new EventEmitter();
  closed = false;
  paused = false;
  constructor(private readonly bytes: number) {}
  async getStats() {
    return [{ type: 'outbound-rtp', byteCount: this.bytes }];
  }
}

const asTransport = (t: FakeTransport) => t as unknown as types.WebRtcTransport;
const asProducer = (p: FakeProducer) => p as unknown as types.Producer;
const asConsumer = (c: FakeConsumer) => c as unknown as types.Consumer;

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** Lets the getStats promise settle after the timer that started it has fired. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SILENCE_CHECK_MS);
  await vi.waitFor(() => {});
}

const lines = () =>
  [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0]));

beforeEach(() => {
  vi.useFakeTimers();
  envMock.LOG_VERBOSE = false;
  info = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the always-on silent-failure warnings', () => {
  it('warns about a transport that never connected, with the flag unset', async () => {
    watchTransport(asTransport(new FakeTransport()), 3, 'recv');

    await settle();

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('no ICE connectivity');
  });

  it('stays silent about a transport that did connect', async () => {
    const transport = new FakeTransport();
    transport.iceState = 'connected';
    watchTransport(asTransport(transport), 3, 'recv');

    await settle();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about a producer that received no RTP, with the flag unset', async () => {
    watchProducer(asProducer(new FakeProducer(0)), 3, 'de');

    await settle();

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('no RTP received');
  });

  it('warns about a consumer that sent no RTP, with the flag unset', async () => {
    watchConsumer(asConsumer(new FakeConsumer(0)), 3, 'de');

    await settle();

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('no RTP sent');
  });

  it('names the event and the channel slug rather than a transport identifier', async () => {
    watchProducer(asProducer(new FakeProducer(0)), 3, 'de');
    watchConsumer(asConsumer(new FakeConsumer(0)), 3, 'de');

    await settle();

    for (const line of lines()) {
      expect(line).toContain('event 3 de');
      expect(line).not.toContain(TRANSPORT_ID.slice(0, 8));
    }
  });

  it('names the event and direction for a transport, which belongs to no one channel', async () => {
    watchTransport(asTransport(new FakeTransport()), 3, 'recv');

    await settle();

    expect(String(warn.mock.calls[0]?.[0])).toContain('event 3 recv');
  });

  it('carries no remote address and no transport identifier on any line', async () => {
    const transport = new FakeTransport();
    watchTransport(asTransport(transport), 3, 'recv');
    transport.emit('iceselectedtuplechange', {
      protocol: 'udp',
      localAddress: '0.0.0.0',
      localPort: 44400,
      remoteIp: REMOTE_ADDRESS,
      remotePort: 50000,
    });
    watchProducer(asProducer(new FakeProducer(0)), 3, 'de');

    await settle();

    for (const line of lines()) {
      expect(line).not.toContain(REMOTE_ADDRESS);
      expect(line).not.toContain(TRANSPORT_ID.slice(0, 8));
    }
  });
});

describe('the verbose transport narration', () => {
  function narrate(transport: FakeTransport): void {
    watchTransport(asTransport(transport), 3, 'recv');
    transport.emit('icestatechange', 'connected');
    transport.emit('icestatechange', 'disconnected');
    transport.emit('dtlsstatechange', 'connected');
    transport.emit('dtlsstatechange', 'failed');
    transport.emit('iceselectedtuplechange', {
      protocol: 'udp',
      localAddress: '0.0.0.0',
      localPort: 44400,
      remoteIp: REMOTE_ADDRESS,
      remotePort: 50000,
    });
    transport.observer.emit('close');
  }

  it('writes nothing with the flag unset', () => {
    narrate(new FakeTransport());

    expect(lines()).toEqual([]);
  });

  it('writes creation, ICE, DTLS and close with the flag set', () => {
    envMock.LOG_VERBOSE = true;

    narrate(new FakeTransport());

    const joined = lines().join('\n');
    expect(joined).toContain('transport created, offering');
    expect(joined).toContain('ice connected');
    expect(joined).toContain('ice disconnected');
    expect(joined).toContain('dtls failed');
    expect(joined).toContain('transport closed');
    expect(joined).toContain(REMOTE_ADDRESS);
  });

  it('keeps the healthy byte counts verbose too', async () => {
    envMock.LOG_VERBOSE = true;
    watchProducer(asProducer(new FakeProducer(4_096)), 3, 'de');

    await settle();

    expect(lines().join('\n')).toContain('receiving RTP (4096 bytes)');
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a healthy producer's bytes to nobody with the flag unset", async () => {
    watchProducer(asProducer(new FakeProducer(4_096)), 3, 'de');

    await settle();

    expect(lines()).toEqual([]);
  });
});

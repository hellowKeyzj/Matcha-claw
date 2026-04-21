import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalGatewayPort = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
const originalGatewayToken = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN;

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sentMessages.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close(code?: number, reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code ?? 1000, reason);
  }

  emitJson(payload: Record<string, unknown>) {
    this.emit('message', JSON.stringify(payload));
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.resetModules();
  vi.doUnmock('ws');
  if (originalGatewayPort === undefined) {
    delete process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
  } else {
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = originalGatewayPort;
  }
  if (originalGatewayToken === undefined) {
    delete process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN;
  } else {
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN = originalGatewayToken;
  }
});

describe('runtime-host process gateway rpc client reconnect', () => {
  it('重连前会清掉旧连接残留的握手状态', async () => {
    vi.doMock('ws', () => ({ default: FakeWebSocket }));

    const { createGatewayClient } = await import('../../runtime-host/openclaw-bridge/client');
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = '18789';
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN = 'reconnect-token';

    const client = createGatewayClient();

    const firstConnect = client.gatewayRpc('channels.status', { probe: true });
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeTruthy();
    firstSocket.emit('open');

    firstSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-1' },
    });

    const firstConnectRequest = firstSocket.sentMessages.find((message) => message.method === 'connect');
    expect(firstConnectRequest).toBeTruthy();

    firstSocket.emitJson({
      type: 'res',
      id: firstConnectRequest?.id,
      ok: true,
      payload: { hello: 'ok' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstRpcRequest = firstSocket.sentMessages.find((message) => message.method === 'channels.status');
    expect(firstRpcRequest).toBeTruthy();

    firstSocket.emitJson({
      type: 'res',
      id: firstRpcRequest?.id,
      ok: true,
      payload: { ok: true },
    });

    await expect(firstConnect).resolves.toEqual({ ok: true });

    // Simulate a stale socket state: the transport is no longer open,
    // but its close event has not yet reset the previous handshake flags.
    firstSocket.readyState = FakeWebSocket.CLOSED;

    const reconnect = client.gatewayRpc('channels.status', { probe: true });
    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket).toBeTruthy();
    secondSocket.emit('open');

    secondSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-2' },
    });

    const secondConnectRequest = secondSocket.sentMessages.find((message) => message.method === 'connect');
    expect(secondConnectRequest).toBeTruthy();

    secondSocket.emitJson({
      type: 'res',
      id: secondConnectRequest?.id,
      ok: true,
      payload: { hello: 'ok' },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondRpcRequest = secondSocket.sentMessages.find((message) => message.method === 'channels.status');
    expect(secondRpcRequest).toBeTruthy();

    secondSocket.emitJson({
      type: 'res',
      id: secondRpcRequest?.id,
      ok: true,
      payload: { ok: true },
    });

    await expect(reconnect).resolves.toEqual({ ok: true });

    client.close();
  });
});

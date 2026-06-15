import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NodeGatewayDeviceCrypto,
  NodeGatewayDeviceIdentityRepository,
} from '../../runtime-host/composition/gateway-device-identity-adapters';
import { createTestRuntimeClock } from './helpers/runtime-clock';
import { createTestRuntimeIdGenerator } from './helpers/runtime-id-generator';
import { createTestRuntimeScheduler } from './helpers/runtime-scheduler';
import { createTestRuntimeTcpProbe } from './helpers/runtime-tcp-probe';

const originalGatewayPort = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
let gatewayToken = '';

function createTestGatewayClient(
  createGatewayClient: typeof import('../../runtime-host/openclaw-bridge/client').createGatewayClient,
  options: Partial<Parameters<typeof createGatewayClient>[0]> = {},
) {
  const deviceCrypto = new NodeGatewayDeviceCrypto();
  const clock = createTestRuntimeClock();
  return createGatewayClient({
    runtimeHostDataDir: process.cwd(),
    gatewayPort: 18789,
    readGatewayToken: async () => gatewayToken,
    platform: process.platform,
    clock,
    idGenerator: createTestRuntimeIdGenerator(),
    identityRepository: new NodeGatewayDeviceIdentityRepository(deviceCrypto, clock),
    deviceCrypto,
    scheduler: createTestRuntimeScheduler(),
    tcpProbe: createTestRuntimeTcpProbe(),
    ...options,
  });
}

async function finishGatewayHandshake(socket: FakeWebSocket, nonce: string) {
  socket.emit('open');
  socket.emitJson({
    type: 'event',
    event: 'connect.challenge',
    payload: { nonce },
  });
  await vi.waitFor(() => {
    expect(socket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
  });
  const connectRequest = socket.sentMessages.find((message) => message.method === 'connect');
  socket.emitJson({
    type: 'res',
    id: connectRequest?.id,
    ok: true,
    payload: { hello: 'ok' },
  });
  await Promise.resolve();
}

async function establishGatewayClient(client: ReturnType<typeof createTestGatewayClient>) {
  const firstCall = client.gatewayRpc('channels.status', { probe: true });
  const firstSocket = FakeWebSocket.instances[0];
  expect(firstSocket).toBeTruthy();
  await finishGatewayHandshake(firstSocket, 'nonce-1');
  await vi.waitFor(() => {
    expect(firstSocket.sentMessages.find((message) => message.method === 'channels.status')).toBeTruthy();
  });
  const firstRpcRequest = firstSocket.sentMessages.find((message) => message.method === 'channels.status');
  firstSocket.emitJson({ type: 'res', id: firstRpcRequest?.id, ok: true, payload: { ok: true } });
  await expect(firstCall).resolves.toEqual({ ok: true });
  return firstSocket;
}

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
  gatewayToken = '';
});

describe('runtime-host process gateway rpc client reconnect', () => {
  it('显式恢复会丢弃旧连接并重新验证控制 RPC', async () => {
    vi.doMock('ws', () => ({ default: FakeWebSocket }));

    const { createGatewayClient } = await import('../../runtime-host/openclaw-bridge/client');
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = '18789';
    gatewayToken = 'recover-token';

    const client = createTestGatewayClient(createGatewayClient);

    const firstCall = client.gatewayRpc('channels.status', { probe: true });
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeTruthy();
    firstSocket.emit('open');
    firstSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-1' },
    });
    await vi.waitFor(() => {
      expect(firstSocket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
    });
    const firstConnectRequest = firstSocket.sentMessages.find((message) => message.method === 'connect');
    firstSocket.emitJson({
      type: 'res',
      id: firstConnectRequest?.id,
      ok: true,
      payload: { hello: 'ok' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstRpcRequest = firstSocket.sentMessages.find((message) => message.method === 'channels.status');
    expect(firstRpcRequest).toBeTruthy();
    firstSocket.emitJson({ type: 'res', id: firstRpcRequest?.id, ok: true, payload: { ok: true } });
    await expect(firstCall).resolves.toEqual({ ok: true });

    const recovery = client.recoverGatewayConnection('gateway-restart');
    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket).toBeTruthy();
    secondSocket.emit('open');
    secondSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-2' },
    });
    await vi.waitFor(() => {
      expect(secondSocket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
    });
    const secondConnectRequest = secondSocket.sentMessages.find((message) => message.method === 'connect');
    secondSocket.emitJson({
      type: 'res',
      id: secondConnectRequest?.id,
      ok: true,
      payload: { hello: 'ok' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const presenceRequest = secondSocket.sentMessages.find((message) => message.method === 'system-presence');
    expect(presenceRequest).toBeTruthy();
    secondSocket.emitJson({ type: 'res', id: presenceRequest?.id, ok: true, payload: { ok: true } });

    await expect(recovery).resolves.toMatchObject({
      state: 'connected',
      portReachable: true,
      gatewayReady: true,
    });
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);

    client.close();
  });

  it('连续 RPC 超时后会自动丢弃旧连接并恢复控制通道', async () => {
    vi.doMock('ws', () => ({ default: FakeWebSocket }));

    const { createGatewayClient } = await import('../../runtime-host/openclaw-bridge/client');
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = '18789';
    gatewayToken = 'auto-recover-token';

    const client = createTestGatewayClient(createGatewayClient);

    const firstCall = client.gatewayRpc('channels.status', { probe: true });
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeTruthy();
    firstSocket.emit('open');
    firstSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-1' },
    });
    await vi.waitFor(() => {
      expect(firstSocket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
    });
    const firstConnectRequest = firstSocket.sentMessages.find((message) => message.method === 'connect');
    firstSocket.emitJson({
      type: 'res',
      id: firstConnectRequest?.id,
      ok: true,
      payload: { hello: 'ok' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstRpcRequest = firstSocket.sentMessages.find((message) => message.method === 'channels.status');
    expect(firstRpcRequest).toBeTruthy();
    firstSocket.emitJson({ type: 'res', id: firstRpcRequest?.id, ok: true, payload: { ok: true } });
    await expect(firstCall).resolves.toEqual({ ok: true });

    for (let index = 0; index < 3; index += 1) {
      await expect(client.gatewayRpc(`stuck.method.${index}`, {}, 1)).rejects.toThrow('Gateway RPC timeout');
    }

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances.length).toBe(2);
    });
    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket).toBeTruthy();
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);

    secondSocket.emit('open');
    secondSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-2' },
    });
    await vi.waitFor(() => {
      expect(secondSocket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
    });
    const secondConnectRequest = secondSocket.sentMessages.find((message) => message.method === 'connect');
    secondSocket.emitJson({
      type: 'res',
      id: secondConnectRequest?.id,
      ok: true,
      payload: { hello: 'ok' },
    });
    await vi.waitFor(() => {
      expect(secondSocket.sentMessages.find((message) => message.method === 'system-presence')).toBeTruthy();
    });
    const presenceRequest = secondSocket.sentMessages.find((message) => message.method === 'system-presence');
    secondSocket.emitJson({ type: 'res', id: presenceRequest?.id, ok: true, payload: { ok: true } });

    await vi.waitFor(async () => {
      await expect(client.readGatewayConnectionState()).resolves.toMatchObject({
        state: 'connected',
        gatewayReady: true,
      });
    });

    client.close();
  });

  it('RPC recovery 失败后会低频继续恢复且端口可达时不重启 Gateway', async () => {
    vi.doMock('ws', () => ({ default: FakeWebSocket }));

    const { createGatewayClient } = await import('../../runtime-host/openclaw-bridge/client');
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = '18789';
    gatewayToken = 'backoff-recover-token';
    const requestGatewayRestart = vi.fn(async () => undefined);
    const tcpProbe = { isReachable: vi.fn(async () => true) };

    const client = createTestGatewayClient(createGatewayClient, {
      requestGatewayRestart,
      tcpProbe,
    });
    const firstSocket = await establishGatewayClient(client);

    vi.useFakeTimers();
    try {
      const stuckCalls = [0, 1, 2].map((index) => {
        const call = client.gatewayRpc(`stuck.method.${index}`, {}, 1);
        return expect(call).rejects.toThrow('Gateway RPC timeout');
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.all(stuckCalls);

      await vi.advanceTimersByTimeAsync(0);
      const secondSocket = FakeWebSocket.instances[1];
      expect(secondSocket).toBeTruthy();
      expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
      await finishGatewayHandshake(secondSocket, 'nonce-2');
      await vi.waitFor(() => {
        expect(secondSocket.sentMessages.find((message) => message.method === 'system-presence')).toBeTruthy();
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(tcpProbe.isReachable).toHaveBeenCalled();
      expect(requestGatewayRestart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeWebSocket.instances.length).toBe(3);

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('RPC recovery 失败且端口不可达时会升级请求 Gateway restart', async () => {
    vi.doMock('ws', () => ({ default: FakeWebSocket }));

    const { createGatewayClient } = await import('../../runtime-host/openclaw-bridge/client');
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = '18789';
    gatewayToken = 'restart-recover-token';
    const requestGatewayRestart = vi.fn(async () => undefined);
    const tcpProbe = { isReachable: vi.fn(async () => false) };

    const client = createTestGatewayClient(createGatewayClient, {
      requestGatewayRestart,
      tcpProbe,
    });
    await establishGatewayClient(client);

    vi.useFakeTimers();
    try {
      const stuckCalls = [0, 1, 2].map((index) => {
        const call = client.gatewayRpc(`dead.method.${index}`, {}, 1);
        return expect(call).rejects.toThrow('Gateway RPC timeout');
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await Promise.all(stuckCalls);

      await vi.advanceTimersByTimeAsync(0);
      const secondSocket = FakeWebSocket.instances[1];
      expect(secondSocket).toBeTruthy();
      await finishGatewayHandshake(secondSocket, 'nonce-2');

      await vi.advanceTimersByTimeAsync(10_000);
      expect(requestGatewayRestart).toHaveBeenCalledWith('transport-unresponsive');

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('重连前会清掉旧连接残留的握手状态', async () => {
    vi.doMock('ws', () => ({ default: FakeWebSocket }));

    const { createGatewayClient } = await import('../../runtime-host/openclaw-bridge/client');
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = '18789';
    gatewayToken = 'reconnect-token';

    const client = createTestGatewayClient(createGatewayClient);

    const firstConnect = client.gatewayRpc('channels.status', { probe: true });
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeTruthy();
    firstSocket.emit('open');

    firstSocket.emitJson({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'nonce-1' },
    });

    await vi.waitFor(() => {
      expect(firstSocket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
    });
    const firstConnectRequest = firstSocket.sentMessages.find((message) => message.method === 'connect');

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

    await vi.waitFor(() => {
      expect(secondSocket.sentMessages.find((message) => message.method === 'connect')).toBeTruthy();
    });
    const secondConnectRequest = secondSocket.sentMessages.find((message) => message.method === 'connect');

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


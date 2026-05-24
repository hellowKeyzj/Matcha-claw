import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createGatewayClient } from '../../runtime-host/openclaw-bridge';
import { parseGatewayPort } from '../../runtime-host/openclaw-bridge/client-auth';
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

function createTestGatewayClient(options: Partial<Parameters<typeof createGatewayClient>[0]> = {}) {
  const rawPort = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
  if (typeof rawPort !== 'string' || !rawPort.trim()) {
    throw new Error('Missing required runtime-host env: MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT');
  }
  const deviceCrypto = new NodeGatewayDeviceCrypto();
  const clock = createTestRuntimeClock();
  return createGatewayClient({
    runtimeHostDataDir: process.cwd(),
    gatewayPort: parseGatewayPort(rawPort),
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

afterEach(() => {
  if (originalGatewayPort === undefined) {
    delete process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
  } else {
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = originalGatewayPort;
  }
  gatewayToken = '';
});

describe('runtime-host process gateway rpc client', () => {
  it('gateway 端口环境变量缺失时拒绝调用', async () => {
    delete process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
    expect(() => createTestGatewayClient()).toThrow(
      'Missing required runtime-host env: MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT',
    );
  });

  it('gateway 端口环境变量非法时拒绝调用', async () => {
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = 'abc';
    expect(() => createTestGatewayClient()).toThrow(
      'Invalid runtime-host gateway port: abc',
    );
  });

  it('isGatewayRunning 只做轻量端口探活，不要求完成 websocket 握手', async () => {
    const port = 47400 + Math.floor(Math.random() * 400);
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);

    const server = net.createServer((socket) => {
      socket.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });

    try {
      const client = createTestGatewayClient();
      await expect(client.isGatewayRunning()).resolves.toBe(true);
      client.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('readGatewayConnectionState 只读端口与连接快照，不会偷偷发起 websocket 握手', async () => {
    const port = 47500 + Math.floor(Math.random() * 400);
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);

    const server = net.createServer((socket) => {
      socket.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });

    try {
      const client = createTestGatewayClient();
      await expect(client.readGatewayConnectionState()).resolves.toMatchObject({
        state: 'disconnected',
        portReachable: true,
      });
      client.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('gatewayRpc 复用长连接，不再每次请求新建 socket', async () => {
    const port = 47800 + Math.floor(Math.random() * 400);
    const token = 'gateway-client-long-connection-token';
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);
    gatewayToken = token;

    let connectionCount = 0;
    const methods: string[] = [];
    let connectParamsSnapshot: Record<string, unknown> | null = null;
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    wss.on('connection', (socket) => {
      connectionCount += 1;
      socket.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-${Date.now()}` },
      }));

      socket.on('message', (rawData) => {
        const message = JSON.parse(rawData.toString()) as Record<string, unknown>;
        if (message.type !== 'req' || typeof message.id !== 'string') {
          return;
        }
        if (message.method === 'connect') {
          const params = (message.params && typeof message.params === 'object')
            ? message.params as Record<string, unknown>
            : {};
          connectParamsSnapshot = params;
          const auth = (params.auth && typeof params.auth === 'object')
            ? params.auth as Record<string, unknown>
            : {};
          if (auth.token !== token) {
            socket.send(JSON.stringify({
              type: 'res',
              id: message.id,
              ok: false,
              error: { code: 'FORBIDDEN', message: 'invalid token' },
            }));
            socket.close();
            return;
          }
          socket.send(JSON.stringify({
            type: 'res',
            id: message.id,
            ok: true,
            payload: { hello: 'ok' },
          }));
          return;
        }
        methods.push(String(message.method));
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: { ok: true, method: message.method },
        }));
      });
    });

    try {
      const client = createTestGatewayClient();
      await expect(client.gatewayRpc('channels.status', { probe: true })).resolves.toEqual({
        ok: true,
        method: 'channels.status',
      });
      await expect(client.gatewayRpc('cron.list', { includeDisabled: true })).resolves.toEqual({
        ok: true,
        method: 'cron.list',
      });
      client.close();

      expect(methods).toEqual(['channels.status', 'cron.list']);
      expect(connectionCount).toBe(1);
      expect(connectParamsSnapshot).toBeTruthy();
      expect(connectParamsSnapshot).toMatchObject({
        minProtocol: 4,
        maxProtocol: 4,
      });
      expect((connectParamsSnapshot as { scopes?: string[] }).scopes).toContain('operator.read');
      expect((connectParamsSnapshot as { scopes?: string[] }).scopes).toContain('operator.write');
      expect((connectParamsSnapshot as { caps?: string[] }).caps).toContain('tool-events');
      expect((connectParamsSnapshot as { client?: { id?: string; displayName?: string; mode?: string } }).client)
        .toMatchObject({
          id: 'gateway-client',
          displayName: 'MatchaClaw Runtime Host',
          mode: 'backend',
        });
      const device = (connectParamsSnapshot as { device?: Record<string, unknown> }).device;
      expect(device).toBeTruthy();
      expect(typeof device?.id).toBe('string');
      expect(typeof device?.publicKey).toBe('string');
      expect(typeof device?.signature).toBe('string');
      expect(typeof device?.signedAt).toBe('number');
      expect(typeof device?.nonce).toBe('string');
    } finally {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('会透传 gateway 连接态变化（connected/reconnecting/disconnected）', async () => {
    const port = 48200 + Math.floor(Math.random() * 300);
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);
    gatewayToken = 'connection-state-token';

    const snapshots: Array<{ state: string; portReachable: boolean; lastError?: string }> = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-${Date.now()}` },
      }));

      socket.on('message', (rawData) => {
        const message = JSON.parse(rawData.toString()) as Record<string, unknown>;
        if (message.type !== 'req' || typeof message.id !== 'string') {
          return;
        }
        if (message.method === 'connect') {
          socket.send(JSON.stringify({
            type: 'res',
            id: message.id,
            ok: true,
            payload: { hello: 'ok' },
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: { ok: true },
        }));
      });
    });

    try {
      const client = createTestGatewayClient({
        onGatewayConnectionState: (payload) => {
          snapshots.push({
            state: payload.state,
            portReachable: payload.portReachable,
            transportEpoch: payload.transportEpoch,
            lastError: payload.lastError,
          });
        },
      });
      await client.gatewayRpc('channels.status', { probe: true });
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(snapshots.map((item) => item.state)).toContain('disconnected');
      expect(snapshots.map((item) => item.state)).toContain('reconnecting');
      expect(snapshots.map((item) => item.state)).toContain('connected');
      expect(snapshots.some((item) => item.state === 'connected' && item.portReachable)).toBe(true);
      expect(snapshots.some((item) => item.state === 'connected' && item.transportEpoch >= 1)).toBe(true);
      expect(snapshots.at(-1)).toEqual(expect.objectContaining({
        state: 'disconnected',
      }));
    } finally {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('ensureGatewayReady 会完成握手并验证轻量 RPC', async () => {
    const port = 48300 + Math.floor(Math.random() * 300);
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);
    gatewayToken = 'gateway-ready-token';

    const methods: string[] = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-${Date.now()}` },
      }));

      socket.on('message', (rawData) => {
        const message = JSON.parse(rawData.toString()) as Record<string, unknown>;
        if (message.type !== 'req' || typeof message.id !== 'string') {
          return;
        }
        methods.push(String(message.method));
        if (message.method === 'connect') {
          socket.send(JSON.stringify({
            type: 'res',
            id: message.id,
            ok: true,
            payload: {
              hello: 'ok',
              features: {
                methods: ['status', 'config.get', 'agents.list', 'skills.status', 'system-presence'],
              },
            },
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: { ok: true },
        }));
      });
    });

    let client: ReturnType<typeof createTestGatewayClient> | null = null;
    try {
      client = createTestGatewayClient();
      await expect(client.ensureGatewayReady(3000)).resolves.toBeUndefined();
      expect(methods).toEqual(['connect', 'status']);
      client.close();
    } finally {
      client?.close();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('诊断快照变化会继续透传，不会被状态相同误吞', async () => {
    const port = 48400 + Math.floor(Math.random() * 300);
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);
    gatewayToken = 'gateway-diagnostics-token';

    const snapshots: Array<{
      state: string;
      gatewayReady: boolean;
      diagnostics: {
        lastAliveAt?: number;
        lastRpcSuccessAt?: number;
        consecutiveRpcFailures: number;
      };
    }> = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-${Date.now()}` },
      }));

      socket.on('message', (rawData) => {
        const message = JSON.parse(rawData.toString()) as Record<string, unknown>;
        if (message.type !== 'req' || typeof message.id !== 'string') {
          return;
        }
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: { ok: true, method: message.method },
        }));
      });
    });

    try {
      const client = createTestGatewayClient({
        onGatewayConnectionState: (payload) => {
          snapshots.push({
            state: payload.state,
            gatewayReady: payload.gatewayReady,
            diagnostics: {
              lastAliveAt: payload.diagnostics.lastAliveAt,
              lastRpcSuccessAt: payload.diagnostics.lastRpcSuccessAt,
              consecutiveRpcFailures: payload.diagnostics.consecutiveRpcFailures,
            },
          });
        },
      });

      await client.gatewayRpc('channels.status', { probe: true });
      client.close();

      expect(snapshots.some((item) => item.state === 'connected' && item.gatewayReady)).toBe(true);
      expect(
        snapshots.some((item) => item.diagnostics.lastAliveAt && item.diagnostics.lastRpcSuccessAt),
      ).toBe(true);
      expect(
        snapshots.some((item) => item.diagnostics.consecutiveRpcFailures === 0),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});


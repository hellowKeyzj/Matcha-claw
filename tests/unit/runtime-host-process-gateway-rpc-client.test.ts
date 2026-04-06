import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createGatewayClient } from '../../runtime-host/openclaw-bridge';

const originalGatewayPort = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
const originalGatewayToken = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN;

afterEach(() => {
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

describe('runtime-host process gateway rpc client', () => {
  it('gateway 端口环境变量缺失时拒绝调用', async () => {
    delete process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
    const client = createGatewayClient();

    await expect(client.gatewayRpc('channels.status', {})).rejects.toThrow(
      'Missing required runtime-host env: MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT',
    );
  });

  it('gateway 端口环境变量非法时拒绝调用', async () => {
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = 'abc';
    const client = createGatewayClient();

    await expect(client.isGatewayRunning()).rejects.toThrow(
      'Invalid runtime-host gateway port: abc',
    );
  });

  it('gatewayRpc 复用长连接，不再每次请求新建 socket', async () => {
    const port = 47800 + Math.floor(Math.random() * 400);
    const token = 'gateway-client-long-connection-token';
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT = String(port);
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN = token;

    let connectionCount = 0;
    const methods: string[] = [];
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
      const client = createGatewayClient();
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
    process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN = 'connection-state-token';

    const states: string[] = [];
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
      const client = createGatewayClient({
        onGatewayConnectionState: (payload) => {
          states.push(payload.state);
        },
      });
      await client.gatewayRpc('channels.status', { probe: true });
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(states).toContain('disconnected');
      expect(states).toContain('reconnecting');
      expect(states).toContain('connected');
      expect(states.at(-1)).toBe('disconnected');
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

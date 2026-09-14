import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelAuthorizationRoutes } from '../../electron/api/routes/channel-authorization';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('channel authorization Host API route', () => {
  it('forwards a valid start request to the dedicated transport', async () => {
    const body = {
      action: 'start',
      channel: 'qqbot',
      accountId: 'main',
      agentId: 'support',
      config: { locale: 'zh' },
    } as const;
    const authorize = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        outcome: 'progress',
        channel: 'qqbot',
        accountId: 'main',
        qrDataUrl: 'data:image/png;base64,qr',
        sessionKey: 'auth-session-1',
      },
    });
    const result = response();

    await expect(handleChannelAuthorizationRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/authorization'),
      { authorize },
    )).resolves.toBe(true);

    expect(authorize).toHaveBeenCalledWith(body, undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        outcome: 'progress',
        channel: 'qqbot',
        accountId: 'main',
        qrDataUrl: 'data:image/png;base64,qr',
        sessionKey: 'auth-session-1',
      },
    });
  });

  it('forwards wait and cancel with a required session key', async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: { outcome: 'connected', channel: 'dingtalk', sessionKey: 'auth-session-1' } })
      .mockResolvedValueOnce({ status: 200, body: { outcome: 'cancelled', channel: 'dingtalk', sessionKey: 'auth-session-1' } });

    for (const body of [
      { action: 'wait', channel: 'dingtalk', sessionKey: 'auth-session-1', timeoutMs: 300_000 },
      { action: 'cancel', channel: 'dingtalk', sessionKey: 'auth-session-1' },
    ] as const) {
      const result = response();
      await handleChannelAuthorizationRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/authorization'),
        { authorize },
      );
      expect(result.state.statusCode).toBe(200);
    }

    expect(authorize).toHaveBeenNthCalledWith(1, { action: 'wait', channel: 'dingtalk', sessionKey: 'auth-session-1', timeoutMs: 300_000 }, undefined);
    expect(authorize).toHaveBeenNthCalledWith(2, { action: 'cancel', channel: 'dingtalk', sessionKey: 'auth-session-1' }, undefined);
  });

  it('rejects invalid authorization requests without invoking the transport', async () => {
    const authorize = vi.fn();
    for (const body of [
      { action: 'start', channel: 'wecom', accountId: 'main' },
      { action: 'start', channel: 'qqbot', accountId: 'bad id' },
      { action: 'wait', channel: 'qqbot' },
      { action: 'cancel', channel: 'feishu', sessionKey: '' },
      { action: 'cancel', channel: 'feishu', sessionKey: 'auth-session-1', secret: 'private' },
    ]) {
      const result = response();
      await handleChannelAuthorizationRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/authorization'),
        { authorize },
      );
      expect(result.state).toEqual({ statusCode: 400, body: { outcome: 'rejected' } });
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it('maps transport throws to the sealed unknown outcome', async () => {
    const result = response();

    await handleChannelAuthorizationRoutes(
      request({ action: 'start', channel: 'feishu', accountId: 'main' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/authorization'),
      { authorize: vi.fn().mockRejectedValue(new Error('private app secret failure')) },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { outcome: 'unknown', channel: 'feishu' },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('private app secret failure');
  });
});

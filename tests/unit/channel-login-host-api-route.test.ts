import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelLoginRoutes } from '../../electron/api/routes/channel-login';

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

describe('channel login Host API route', () => {
  it('forwards a valid start request to the dedicated transport', async () => {
    const body = {
      action: 'start',
      channel: 'whatsapp',
      accountId: 'main',
      config: { phoneNumber: '+1' },
      force: true,
      timeoutMs: 120_000,
    } as const;
    const login = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        outcome: 'progress',
        channel: 'whatsapp',
        accountId: 'main',
        qrDataUrl: 'data:image/png;base64,qr',
        sessionKey: 'login-session-1',
      },
    });
    const result = response();

    await expect(handleChannelLoginRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/login'),
      { login },
    )).resolves.toBe(true);

    expect(login).toHaveBeenCalledWith(body, undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        outcome: 'progress',
        channel: 'whatsapp',
        accountId: 'main',
        qrDataUrl: 'data:image/png;base64,qr',
        sessionKey: 'login-session-1',
      },
    });
  });

  it('forwards a valid wait request to the dedicated transport', async () => {
    const body = {
      action: 'wait',
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      sessionKey: 'login-session-1',
      currentQrDataUrl: 'data:image/png;base64,qr-old',
      timeoutMs: 300_000,
    } as const;
    const login = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        outcome: 'connected',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        sessionKey: 'login-session-1',
      },
    });
    const result = response();

    await expect(handleChannelLoginRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/login'),
      { login },
    )).resolves.toBe(true);

    expect(login).toHaveBeenCalledWith(body, undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        outcome: 'connected',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        sessionKey: 'login-session-1',
      },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('alreadyConnected');
    expect(JSON.stringify(result.state.body)).not.toContain('token');
    expect(JSON.stringify(result.state.body)).not.toContain('xxx@im.bot');
  });

  it('forwards Weixin direct-login start as the sealed connected public response', async () => {
    const body = {
      action: 'start',
      channel: 'openclaw-weixin',
      accountId: 'wechat-main',
      config: {},
      force: true,
    } as const;
    const login = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        outcome: 'connected',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        sessionKey: 'login-session-connected',
      },
    });
    const result = response();

    await expect(handleChannelLoginRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/login'),
      { login },
    )).resolves.toBe(true);

    expect(login).toHaveBeenCalledWith(body, undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        outcome: 'connected',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        sessionKey: 'login-session-connected',
      },
    });
    expect(Object.keys(result.state.body as Record<string, unknown>).sort()).toEqual([
      'accountId',
      'channel',
      'outcome',
      'sessionKey',
    ]);
  });

  it('rejects extra keys and invalid identities without invoking the transport', async () => {
    const login = vi.fn();
    for (const body of [
      { action: 'start', channel: 'whatsapp', accountId: 'main', config: {}, extra: true },
      { action: 'start', channel: 'openclaw-weixin', accountId: 'wechat-main', directLogin: true },
      { action: 'wait', channel: 'openclaw-weixin', accountId: 'wechat-main', alreadyConnected: true },
      { action: 'wait', channel: 'openclaw-weixin', accountId: 'wechat-main', token: 'native-token' },
      { action: 'wait', channel: 'openclaw-weixin', accountId: 'wechat-main', message: 'native message' },
      { action: 'wait', channel: 'bad channel', accountId: 'main' },
      { action: 'logout', channel: 'whatsapp', accountId: '' },
    ]) {
      const result = response();
      await handleChannelLoginRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/login'),
        { login },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { outcome: 'rejected' },
      });
    }
    expect(login).not.toHaveBeenCalled();
  });

  it('maps transport throws to the sealed unknown outcome', async () => {
    const result = response();

    await handleChannelLoginRoutes(
      request({ action: 'start', channel: 'whatsapp', accountId: 'main' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/login'),
      { login: vi.fn().mockRejectedValue(new Error('private native login failure')) },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { outcome: 'unknown' },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('private native login failure');
  });
});

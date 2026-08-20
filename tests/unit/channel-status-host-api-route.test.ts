import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelStatusRoutes } from '../../electron/api/routes/channel-status';

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

describe('channel status Host API route', () => {
  it('forwards only the fixed empty request to the dedicated transport', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      body: { accounts: [{ channel: 'discord', accountId: 'primary', connection: 'connected' }] },
    });
    const result = response();

    await expect(handleChannelStatusRoutes(
      request({}) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/status'),
      { read, readSnapshot: vi.fn() },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledOnce();
    expect(result.state).toEqual({
      statusCode: 200,
      body: { accounts: [{ channel: 'discord', accountId: 'primary', connection: 'connected' }] },
    });
  });

  it('projects the fixed snapshot transport into the historical GET envelope', async () => {
    const read = vi.fn();
    const readSnapshot = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        ts: 1_725_000_000_000,
        channelOrder: ['discord'],
        channels: { discord: { configured: true, running: true } },
        channelAccounts: {
          discord: [{ accountId: 'primary', connected: true }],
        },
        channelDefaultAccountId: { discord: 'primary' },
      },
    });
    const result = response();

    await expect(handleChannelStatusRoutes(
      request({ ignored: 'caller-body' }, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/snapshot'),
      { read, readSnapshot },
    )).resolves.toBe(true);

    expect(read).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        snapshot: {
          ts: 1_725_000_000_000,
          channelOrder: ['discord'],
          channels: { discord: { configured: true, running: true } },
          channelAccounts: {
            discord: [{ accountId: 'primary', connected: true }],
          },
          channelDefaultAccountId: { discord: 'primary' },
        },
        ready: true,
        refreshing: false,
        updatedAt: 1_725_000_000_000,
        error: null,
      },
    });
  });

  it('fails closed when snapshot delivery is unavailable or malformed', async () => {
    for (const readSnapshot of [
      vi.fn().mockResolvedValue({
        status: 503,
        body: { success: false, error: 'Channel status is unavailable' },
      }),
      vi.fn().mockResolvedValue({
        status: 200,
        body: { ts: 1 },
      }),
      vi.fn().mockRejectedValue(new Error('private native failure')),
    ]) {
      const result = response();
      await handleChannelStatusRoutes(
        request({}, 'GET') as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/snapshot'),
        { read: vi.fn(), readSnapshot },
      );
      expect(result.state).toEqual({
        statusCode: 503,
        body: { success: false, error: 'Channel status is unavailable' },
      });
    }
  });

  it('rejects every non-empty or non-POST request without invoking the transport', async () => {
    const read = vi.fn();
    for (const [body, method] of [[{ probe: true }, 'POST'], [{}, 'GET']] as const) {
      const result = response();
      await handleChannelStatusRoutes(
        request(body, method) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/status'),
        { read, readSnapshot: vi.fn() },
      );
      if (method === 'POST') {
        expect(result.state).toEqual({
          statusCode: 400,
          body: { success: false, error: 'Channel status request is invalid' },
        });
      }
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    const result = response();
    await expect(handleChannelStatusRoutes(
      request({}) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels'),
      { read: vi.fn(), readSnapshot: vi.fn() },
    )).resolves.toBe(false);
  });
});

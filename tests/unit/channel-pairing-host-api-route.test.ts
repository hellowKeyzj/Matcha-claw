import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelPairingRoutes } from '../../electron/api/routes/channel-pairing';

const SYNTHETIC_CODE_SENTINEL = 'SYNTHETICPAIRINGCODE';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
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

describe('channel pairing Host API route', () => {
  it('forwards only a channel list request to the dedicated transport', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: { requests: [{ id: 'request-1', status: 'pending' }] },
    });
    const result = response();

    await expect(handleChannelPairingRoutes(
      request({ channel: 'feishu', accountId: 'default' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/pairing'),
      { list, approve: vi.fn() },
    )).resolves.toBe(true);

    expect(list).toHaveBeenCalledWith('feishu', 'default');
    expect(result.state).toEqual({
      statusCode: 200,
      body: { requests: [{ id: 'request-1', status: 'pending' }] },
    });
  });

  it('forwards a channel list GET to the dedicated transport', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: { requests: [{ id: 'request-1', status: 'pending' }] },
    });
    const result = response();

    await expect(handleChannelPairingRoutes(
      request(undefined, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/pairing/feishu?accountId=default'),
      { list, approve: vi.fn() },
    )).resolves.toBe(true);

    expect(list).toHaveBeenCalledWith('feishu', 'default');
    expect(result.state).toEqual({
      statusCode: 200,
      body: { requests: [{ id: 'request-1', status: 'pending' }] },
    });
  });

  it('forwards an explicit pairing code to the dedicated transport', async () => {
    const approve = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'confirmed' } });
    const result = response();
    await handleChannelPairingRoutes(request({ action: 'approve', channel: 'feishu', accountId: 'default', code: SYNTHETIC_CODE_SENTINEL }) as never, result.raw as never, new URL('http://127.0.0.1/api/channels/pairing'), { list: vi.fn(), approve });
    expect(approve).toHaveBeenCalledWith({ channel: 'feishu', accountId: 'default', code: SYNTHETIC_CODE_SENTINEL });
    expect(result.state.body).toEqual({ outcome: 'confirmed' });
  });

  it('rejects codes and invalid requests without invoking the transport', async () => {
    const list = vi.fn();
    const approve = vi.fn();
    for (const body of [
      {},
      { channel: 'feishu', code: SYNTHETIC_CODE_SENTINEL },
      { channel: 'feishu', account: 'default' },
      { channel: 'fei shu' },
    ]) {
      const result = response();
      await handleChannelPairingRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/pairing'),
        { list, approve },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Channel pairing request is invalid' },
      });
    }
    expect(list).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });
});

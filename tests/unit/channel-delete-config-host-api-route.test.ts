import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelDeleteConfigRoutes } from '../../electron/api/routes/channel-delete-config';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json', 'x-matchaclaw-session-trace': '12345678-1234-4234-8234-123456789abc' },
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

describe('channel delete-config Host API route', () => {
  it('forwards the exact delete DTO to the dedicated transport', async () => {
    const body = { channel: 'feishu' } as const;
    const receipt = { callId: '0123456789abcdef0123456789abcdef', accepted: true };
    const deleteConfig = vi.fn().mockResolvedValue({ status: 202, body: receipt });
    const result = response();

    await expect(handleChannelDeleteConfigRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/delete-config'),
      { deleteConfig },
    )).resolves.toBe(true);

    expect(deleteConfig).toHaveBeenCalledWith(body, '12345678-1234-4234-8234-123456789abc');
    expect(result.state).toEqual({
      statusCode: 202,
      body: receipt,
    });
  });

  it('rejects malformed bodies without invoking the transport', async () => {
    const deleteConfig = vi.fn();
    for (const body of [
      {},
      { channel: 'feishu', accountId: null },
      { channel: 'bad channel', accountId: 'default' },
      { channel: 'feishu', accountId: '' },
      { channel: 'feishu', accountId: 'default', extra: true },
    ]) {
      const result = response();
      await handleChannelDeleteConfigRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/delete-config'),
        { deleteConfig },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { outcome: 'rejected' },
      });
    }
    expect(deleteConfig).not.toHaveBeenCalled();
  });

  it.each([[400, 'rejected'], [503, 'unknown']] as const)('preserves HTTP %s with the sealed %s outcome', async (status, outcome) => {
    const result = response();

    await handleChannelDeleteConfigRoutes(
      request({ channel: 'feishu', accountId: 'default' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/delete-config'),
      { deleteConfig: vi.fn().mockResolvedValue({ status, body: { outcome } }) },
    );

    expect(result.state).toEqual({
      statusCode: status,
      body: { outcome },
    });
  });

  it('maps transport throws to the sealed unknown outcome', async () => {
    const result = response();

    await handleChannelDeleteConfigRoutes(
      request({ channel: 'feishu', accountId: 'default' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/delete-config'),
      { deleteConfig: vi.fn().mockRejectedValue(new Error('private native delete failure')) },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { outcome: 'unknown' },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('private native delete failure');
  });
});

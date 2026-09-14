import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelConfigureRoutes } from '../../electron/api/routes/channel-configure';

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

describe('channel configure Host API route', () => {
  it('forwards a valid form request to the dedicated transport', async () => {
    const form = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        fields: [{ key: 'botId', label: 'Bot ID', kind: 'text', required: true }],
      },
    });
    const result = response();

    await expect(handleChannelConfigureRoutes(
      request({ action: 'form', channel: 'wecom' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/configure'),
      { read: vi.fn(), form, apply: vi.fn() },
    )).resolves.toBe(true);

    expect(form).toHaveBeenCalledWith('wecom', undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        fields: [{ key: 'botId', label: 'Bot ID', kind: 'text', required: true }],
      },
    });
  });

  it('forwards a valid apply request to the dedicated transport', async () => {
    const body = {
      action: 'apply',
      channel: 'wecom',
      accountId: 'main',
      values: { botId: 'bot-1' },
    } as const;
    const apply = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'confirmed' } });
    const result = response();

    await expect(handleChannelConfigureRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/configure'),
      { read: vi.fn(), form: vi.fn(), apply },
    )).resolves.toBe(true);

    expect(apply).toHaveBeenCalledWith({
      channel: 'wecom',
      accountId: 'main',
      values: { botId: 'bot-1' },
    }, undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { outcome: 'confirmed' },
    });
  });

  it('rejects empty identity values and extra keys without invoking the transport', async () => {
    const form = vi.fn();
    const apply = vi.fn();
    for (const body of [
      { action: 'form', channel: '', extra: true },
      { action: 'apply', channel: 'wecom', accountId: '', values: { botId: 'bot-1' } },
      { action: 'apply', channel: 'wecom', accountId: 'main', values: { botId: 'bot-1' }, extra: true },
    ]) {
      const result = response();
      await handleChannelConfigureRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/configure'),
        { read: vi.fn(), form, apply },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Channel configuration request is invalid' },
      });
    }
    expect(form).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('maps transport throws to a sealed unavailable envelope', async () => {
    const result = response();

    await handleChannelConfigureRoutes(
      request({ action: 'apply', channel: 'wecom', accountId: 'main', values: { botId: 'bot-1' } }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/configure'),
      { read: vi.fn(), form: vi.fn(), apply: vi.fn().mockRejectedValue(new Error('private native configure failure')) },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Channel configuration is unavailable' },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('private native configure failure');
  });
});

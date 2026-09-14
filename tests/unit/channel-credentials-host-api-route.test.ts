import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleChannelCredentialsRoutes } from '../../electron/api/routes/channel-credentials';

const SYNTHETIC_TOKEN = 'synthetic-token-sentinel';

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

describe('channel credentials Host API route', () => {
  it('forwards the frozen candidate DTO to the dedicated transport', async () => {
    const validate = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        success: true,
        valid: true,
        errors: [],
        warnings: [],
        details: { botUsername: 'matcha-bot' },
      },
    });
    const result = response();

    await expect(handleChannelCredentialsRoutes(
      request({ channelType: 'discord', config: { token: SYNTHETIC_TOKEN } }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/credentials/validate'),
      { validate },
    )).resolves.toBe(true);

    expect(validate).toHaveBeenCalledWith({
      channelType: 'discord',
      config: { token: SYNTHETIC_TOKEN },
    }, undefined);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        valid: true,
        errors: [],
        warnings: [],
        details: { botUsername: 'matcha-bot' },
      },
    });
  });

  it('forwards config validate alias to the same transport', async () => {
    const validate = vi.fn().mockResolvedValue({ status: 200, body: { success: true, valid: true, errors: [], warnings: [] } });
    const result = response();

    await expect(handleChannelCredentialsRoutes(
      request({ channelType: 'discord', config: { token: SYNTHETIC_TOKEN } }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/channels/config/validate'),
      { validate },
    )).resolves.toBe(true);

    expect(validate).toHaveBeenCalledWith({ channelType: 'discord', config: { token: SYNTHETIC_TOKEN } }, undefined);
    expect(result.state).toEqual({ statusCode: 200, body: { success: true, valid: true, errors: [], warnings: [] } });
  });

  it('preserves an invalid credential result and stable unavailable mapping', async () => {
    const invalidResult = response();
    await handleChannelCredentialsRoutes(
      request({ channelType: 'discord', config: { token: SYNTHETIC_TOKEN } }) as never,
      invalidResult.raw as never,
      new URL('http://127.0.0.1/api/channels/credentials/validate'),
      {
        validate: vi.fn().mockResolvedValue({
          status: 200,
          body: { success: true, valid: false, errors: ['Credential rejected'], warnings: [] },
        }),
      },
    );
    expect(invalidResult.state).toEqual({
      statusCode: 200,
      body: { success: true, valid: false, errors: ['Credential rejected'], warnings: [] },
    });

    const unavailableResult = response();
    await handleChannelCredentialsRoutes(
      request({ channelType: 'discord', config: { token: SYNTHETIC_TOKEN } }) as never,
      unavailableResult.raw as never,
      new URL('http://127.0.0.1/api/channels/credentials/validate'),
      { validate: vi.fn().mockRejectedValue(new Error('private native detail')) },
    );
    expect(unavailableResult.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Channel credentials validation is unavailable' },
    });
  });

  it('rejects malformed requests without invoking the transport', async () => {
    const validate = vi.fn();
    for (const body of [
      {},
      { channelType: 'discord' },
      { channelType: 'discord', config: { token: 42 } },
      { channelType: 'bad channel', config: {} },
      { channelType: 'discord', config: {}, extra: true },
    ]) {
      const result = response();
      await handleChannelCredentialsRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/channels/credentials/validate'),
        { validate },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Channel credentials request is invalid' },
      });
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and does not claim unrelated paths or methods', async () => {
    const invalidJson = response();
    await handleChannelCredentialsRoutes(
      Object.assign(Readable.from(['{']), { method: 'POST', headers: { 'content-type': 'application/json' } }) as never,
      invalidJson.raw as never,
      new URL('http://127.0.0.1/api/channels/credentials/validate'),
      { validate: vi.fn() },
    );
    expect(invalidJson.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Channel credentials request is invalid' },
    });

    for (const [url, method] of [
      ['http://127.0.0.1/api/channels/credentials/validate', 'GET'],
      ['http://127.0.0.1/api/channels/status', 'POST'],
      ['http://127.0.0.1/api/channels/config/validate', 'GET'],
    ] as const) {
      const result = response();
      await expect(handleChannelCredentialsRoutes(
        request({}, method) as never,
        result.raw as never,
        new URL(url),
        { validate: vi.fn() },
      )).resolves.toBe(false);
      expect(result.state).toEqual({ statusCode: 200, body: undefined });
    }
  });
});

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleSettingsDesiredRoutes } from '../../electron/api/routes/settings-desired';

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

const commandRequest = {
  browserMode: 'relay',
  launchAtStartup: false,
  gatewayAutoStart: true,
  proxyEnabled: true,
  proxyServer: 'http://proxy.example.test:8080',
  proxyBypassRules: '<local>;localhost',
} as const;

const transportRequest = {
  id: 'settings.desired',
  operationId: 'settings.replace',
  scope: { kind: 'settings-desired' },
  target: { kind: 'settings' },
  input: {
    browserMode: 'relay',
    launchAtStartup: false,
    gatewayAutoStart: true,
    proxy: {
      enabled: true,
      server: 'http://proxy.example.test:8080',
      bypassRules: '<local>;localhost',
      credentialReference: null,
    },
  },
} as const;

describe('Settings desired Host API route', () => {
  it('forwards only a sanitized proxy intent to the dedicated transport', async () => {
    const submit = vi.fn().mockResolvedValue({
      status: 200,
      body: { desired: { revision: 1, outcome: 'confirmed' } },
    });
    const result = response();

    await expect(handleSettingsDesiredRoutes(
      request(commandRequest) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/settings/desired'),
      { submit },
    )).resolves.toBe(true);

    expect(submit).toHaveBeenCalledWith(transportRequest);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { desired: { revision: 1, outcome: 'confirmed' } },
    });
  });

  it('rejects unsafe or malformed public settings before transport', async () => {
    const submit = vi.fn();
    const cases = [
      {
        ...commandRequest,
        proxyServer: 'http://user:password@proxy.example.test:8080',
      },
      {
        ...commandRequest,
        proxyEnabled: true,
        proxyServer: '',
      },
      {
        ...commandRequest,
        launchAtStartup: 'false',
      },
      {
        ...commandRequest,
        extra: 'private-native-detail',
      },
    ];

    for (const body of cases) {
      const result = response();
      await handleSettingsDesiredRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/settings/desired'),
        { submit },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Settings desired request is invalid' },
      });
    }
    expect(submit).not.toHaveBeenCalled();
  });
});

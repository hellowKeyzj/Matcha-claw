import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('Settings private proxy IPC', () => {
  it('normalizes a non-secret proxy endpoint and fixes the public reference to null', async () => {
    const { splitSettingsProxyIntent } = await import('../../electron/main/ipc/settings-private-proxy');

    await expect(splitSettingsProxyIntent({
      enabled: true,
      server: 'proxy.example.test:8080',
      bypassRules: '<local>;localhost',
    })).resolves.toEqual({
      enabled: true,
      server: 'http://proxy.example.test:8080',
      bypassRules: '<local>;localhost',
      credentialReference: null,
    });
  });

  it('keeps a disabled proxy non-secret and rejects credential-bearing endpoints', async () => {
    const { splitSettingsProxyIntent } = await import('../../electron/main/ipc/settings-private-proxy');

    await expect(splitSettingsProxyIntent({
      enabled: false,
      server: 'ignored.example.test:8080',
      bypassRules: '<local>',
    })).resolves.toEqual({
      enabled: false,
      server: '',
      bypassRules: '<local>',
      credentialReference: null,
    });
    await expect(splitSettingsProxyIntent({
      enabled: true,
      server: 'http://user:password@proxy.example.test:8080',
      bypassRules: '',
    })).rejects.toThrow('Settings proxy credentials are not supported');
  });

  it('rejects malformed and control-character input', async () => {
    const { splitSettingsProxyIntent } = await import('../../electron/main/ipc/settings-private-proxy');

    await expect(splitSettingsProxyIntent({
      enabled: true,
      server: 'http://proxy.example.test/path',
      bypassRules: '',
    })).rejects.toThrow('Settings proxy request is invalid');
    await expect(splitSettingsProxyIntent({
      enabled: true,
      server: 'proxy.example.test:8080\n',
      bypassRules: '',
    })).rejects.toThrow('Settings proxy request is invalid');
  });
});

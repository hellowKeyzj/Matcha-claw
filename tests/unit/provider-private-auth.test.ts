import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallRecord } from '../../src/types/call-log';
import type { ProviderCallDetail } from '../../src/types/call-log/provider';
import { waitForCallRecord } from '../../src/types/call-log/wait';
import type { ProviderPrivateCredentialResolver } from '../../electron/main/ipc/provider-private-auth';
import { clearPrivateAccountTransactions } from '../../electron/main/ipc/provider-private-auth/account-transactions';

const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  userData: 'C:/matchaclaw',
  openClaw: 'C:/openclaw',
}));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  ipcMain: { handle: (name: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => handlers.set(name, handler) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('node:fs', () => {
  const fs = { existsSync: (path: string) => state.files.has(path) };
  return { ...fs, default: fs };
});

vi.mock('node:sqlite', () => {
  class DatabaseSync {
    private cells: Record<string, string>;
    private tableExists: boolean;
    private readonly readOnly: boolean;
    isTransaction = false;

    constructor(private readonly path: string, options?: { readOnly?: boolean }) {
      const raw = state.files.get(path);
      this.cells = raw ? JSON.parse(raw) : {};
      this.tableExists = raw !== undefined;
      this.readOnly = options?.readOnly === true;
    }

    exec(sql: string): void {
      const statement = sql.trim().toUpperCase();
      if (statement.startsWith('CREATE TABLE')) this.tableExists = true;
      if (statement === 'BEGIN IMMEDIATE') this.isTransaction = true;
      if (statement === 'COMMIT') {
        this.isTransaction = false;
        this.persist();
      }
      if (statement === 'ROLLBACK') {
        this.isTransaction = false;
      }
    }

    prepare(sql: string): { get: (key?: string) => unknown; run: (key: string, value: string) => void } {
      if (sql.includes('sqlite_master')) {
        return { get: () => this.tableExists ? { 1: 1 } : undefined, run: () => undefined };
      }
      if (sql.includes('SELECT value_json')) {
        return { get: (key?: string) => key && this.cells[key] ? { value_json: this.cells[key] } : undefined, run: () => undefined };
      }
      return {
        get: () => undefined,
        run: (key: string, value: string) => {
          this.tableExists = true;
          this.cells[key] = value;
        },
      };
    }

    close(): void {}

    private persist(): void {
      if (!this.readOnly) state.files.set(this.path, JSON.stringify(this.cells));
    }
  }

  return { DatabaseSync, default: { DatabaseSync } };
});

vi.mock('node:fs/promises', () => {
  const fsPromises = {
    mkdir: vi.fn(async () => undefined),
    open: vi.fn(async (path: string, mode: string) => ({
      writeFile: async (value: string) => { state.files.set(path, value); },
      sync: async () => undefined,
      close: async () => undefined,
      ...(mode === 'r' ? {} : {}),
    })),
    rm: vi.fn(async (path: string) => { state.files.delete(path); }),
    readFile: vi.fn(async (path: string) => {
      const value = state.files.get(path);
      if (value === undefined) {
        const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
        throw error;
      }
      return value;
    }),
    writeFile: vi.fn(async (path: string, value: string) => { state.files.set(path, value); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = state.files.get(from);
      if (value === undefined) throw new Error('temporary file is unavailable');
      state.files.delete(from);
      state.files.set(to, value);
    }),
  };
  return { ...fsPromises, default: fsPromises };
});

vi.mock('../../electron/utils/paths', () => ({}));

vi.mock('../../electron/services/providers/oauth/openai-codex-oauth', () => ({
  loginOpenAICodexOAuth: vi.fn(),
}));

vi.mock('../../electron/services/providers/oauth/device-oauth-providers', () => ({
  loginMiniMaxPortalOAuth: vi.fn(),
  loginQwenPortalOAuth: vi.fn(),
}));

const account = {
  id: 'openai-main',
  provider: 'openai',
  label: 'OpenAI',
  enabled: true,
  kind: 'chat' as const,
  authMode: 'apiKey' as const,
  revision: 1,
};

const privateStorePath = 'C:/matchaclaw/provider-private-auth.v1.json';
const receipt = { callId: 'a'.repeat(32), accepted: true } as const;

function terminalAccountCall(
  target: { id: string; revision: number },
  detail: Partial<ProviderCallDetail> = {},
): CallRecord<'provider'> {
  return {
    callId: receipt.callId,
    module: 'provider',
    command: 'providerAccounts.replace',
    status: 'unknown',
    start: 1,
    end: 2,
    revision: 3,
    detail: {
      kind: 'replaceAccount', phase: 'terminal', outcome: 'stored',
      count: null, acceptedCount: null, persisted: 'confirmed', commit: 'committed',
      accountId: target.id, accountRevision: target.revision, diagnostic: null,
      native: { changed: false, applied: 'unknown', observed: 'unavailable' },
      ...detail,
    },
  };
}

async function ownerTransactionRequest(
  resolver: ProviderPrivateCredentialResolver,
  transactionId: string,
  operation: 'claim' | 'settle',
  settlement?: 'retained' | 'rejected' | 'unknown',
): Promise<void> {
  const response = await fetch(resolver.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${resolver.authorization}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      operation, transactionId, reference: 'credential:v1:openai-main', revision: 1,
      ...(settlement ? { settlement } : {}),
    }),
  });
  expect(response.status).toBe(204);
  await expect(response.text()).resolves.toBe('');
}

type HostEvent = Readonly<{
  eventName: string;
  payload: Record<string, unknown>;
}>;

function createEventSink(): {
  events: HostEvent[];
  getMainWindow: () => never;
} {
  const events: HostEvent[] = [];
  return {
    events,
    getMainWindow: () => ({
      webContents: {
        send: (channel: string, envelope: HostEvent) => {
          if (channel === 'host:event') events.push(envelope);
        },
      },
    }) as never,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  clearPrivateAccountTransactions();
  handlers.clear();
  state.files.clear();
  vi.clearAllMocks();
});

describe('Provider private auth Main ownership', () => {
  it('restores a replaced vault entry when Rust explicitly rejects the account', async () => {
    state.files.set(privateStorePath, JSON.stringify({ 'credential:v1:openai-main': Buffer.from('{"kind":"apiKey","provider":"openai","key":"old"}').toString('base64') }));
    const { registerProviderPrivateAuthHandlers, startProviderPrivateCredentialResolver } = await import('../../electron/main/ipc/provider-private-auth');
    const execute = vi.fn().mockResolvedValue({ status: 202, body: receipt });
    const observer = vi.fn();
    registerProviderPrivateAuthHandlers(() => null, { execute }, observer);
    const resolver = await startProviderPrivateCredentialResolver(state.openClaw);
    try {
      await expect(handlers.get('providers:storeAccount')?.({}, { account, apiKey: 'new' })).resolves.toEqual(receipt);
      expect(observer).not.toHaveBeenCalled();
      const transactionId = execute.mock.calls[0][0].input.privateTransactionId;
      await ownerTransactionRequest(resolver, transactionId, 'claim');
      await ownerTransactionRequest(resolver, transactionId, 'settle', 'rejected');
      expect([...state.files.values()].join()).toContain(Buffer.from('{"kind":"apiKey","provider":"openai","key":"old"}').toString('base64'));
      expect([...state.files.values()].join()).not.toContain(Buffer.from('{"kind":"apiKey","provider":"openai","key":"new"}').toString('base64'));
    } finally {
      await resolver.close();
    }
  });

  it('keeps a possibly committed vault mutation when transport outcome is unknown', async () => {
    const { registerProviderPrivateAuthHandlers, startProviderPrivateCredentialResolver } = await import('../../electron/main/ipc/provider-private-auth');
    const execute = vi.fn().mockResolvedValue({ status: 202, body: receipt });
    const observer = vi.fn();
    registerProviderPrivateAuthHandlers(() => null, { execute }, observer);
    const resolver = await startProviderPrivateCredentialResolver(state.openClaw);
    try {
      await expect(handlers.get('providers:storeAccount')?.({}, { account, apiKey: 'new' })).resolves.toEqual(receipt);
      expect(observer).not.toHaveBeenCalled();
      const transactionId = execute.mock.calls[0][0].input.privateTransactionId;
      await ownerTransactionRequest(resolver, transactionId, 'claim');
      await ownerTransactionRequest(resolver, transactionId, 'settle', 'unknown');
      await expect(waitForCallRecord(receipt, 'provider', async () => terminalAccountCall(account, {
        outcome: 'unknown', persisted: 'unknown', commit: 'unknown',
      }), undefined, () => () => {})).resolves.toMatchObject({ status: 'unknown', detail: { persisted: 'unknown', commit: 'unknown' } });
      expect([...state.files.values()].join()).toContain(Buffer.from('{"kind":"apiKey","provider":"openai","key":"new"}').toString('base64'));
    } finally {
      await resolver.close();
    }
  });

  it('applies, resolves, and deletes the OpenClaw private credential over the loopback authority', async () => {
    const { registerProviderPrivateAuthHandlers, startProviderPrivateCredentialResolver } = await import('../../electron/main/ipc/provider-private-auth');
    const execute = vi.fn().mockResolvedValue({ status: 202, body: receipt });
    const observer = vi.fn();
    registerProviderPrivateAuthHandlers(() => null, { execute }, observer);
    await expect(handlers.get('providers:storeAccount')?.({}, { account, apiKey: 'secret-canary' })).resolves.toEqual(receipt);
    expect(observer).not.toHaveBeenCalled();

    const resolver = await startProviderPrivateCredentialResolver(state.openClaw);
    try {
      const transactionId = execute.mock.calls[0][0].input.privateTransactionId;
      await ownerTransactionRequest(resolver, transactionId, 'claim');
      const apply = await fetch(resolver.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${resolver.authorization}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'credential:v1:openai-main', provider: 'openai', credentialProvider: 'openai', authMode: 'apiKey', revision: 1 }),
      });
      expect(apply.status).toBe(204);
      await expect(apply.text()).resolves.toBe('');
      await ownerTransactionRequest(resolver, transactionId, 'settle', 'retained');
      await expect(waitForCallRecord(receipt, 'provider', async () => terminalAccountCall(account), undefined, () => () => {}))
        .resolves.toMatchObject({ detail: { outcome: 'stored', persisted: 'confirmed', commit: 'committed' } });
      const authProfileCells = [...state.files.values()]
        .map((value) => JSON.parse(value))
        .find((value) => value['authProfiles.store']);
      expect(JSON.parse(authProfileCells['auth.sharedStore'])).toEqual({ location: 'state-db' });
      expect(JSON.parse(authProfileCells['authProfiles.store'])).toMatchObject({
        profiles: { 'openai:default': { type: 'api_key', provider: 'openai', key: 'secret-canary' } },
      });
      expect(JSON.parse(authProfileCells['authProfiles.state'])).toMatchObject({
        order: { openai: ['openai:default'] },
        lastGood: { openai: 'openai:default' },
      });

      const resolved = await fetch(resolver.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${resolver.authorization}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'credential:v1:openai-main' }),
      });
      expect(resolved.status).toBe(200);
      await expect(resolved.json()).resolves.toEqual({ value: 'secret-canary' });

      const invalid = await fetch(resolver.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${resolver.authorization}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'credential:v1:openai-main', provider: 'openai', authMode: 'apiKey', revision: 1, key: 'secret-canary' }),
      });
      expect(invalid.status).toBe(400);

      const remove = await fetch(resolver.endpoint, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${resolver.authorization}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'credential:v1:openai-main', provider: 'openai', revision: 1 }),
      });
      expect(remove.status).toBe(204);
      expect([...state.files.values()].join()).not.toContain('secret-canary');
    } finally {
      await resolver.close();
    }
  });

  it('rejects secret responses from the public provider transport boundary', async () => {
    const { createProviderAccountsTransport } = await import('../../electron/main/runtime-host-delivery/transport/providers/accounts');
    const { createRuntimeHostDeliveryIssuer } = await import('../../electron/main/runtime-host-delivery/issuer');
    const transport = createProviderAccountsTransport(createRuntimeHostDeliveryIssuer(), 3240, vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ ...receipt, account: { ...account, key: 'secret-canary' } }),
    }));

    await expect(transport.execute({
      id: 'provider.accounts',
      operationId: 'providerAccounts.replace',
      scope: { kind: 'provider-account-catalog' },
      target: { kind: 'provider-accounts' },
      input: { kind: 'replace', account },
    })).resolves.toMatchObject({ status: 503 });
  });

  it('projects the existing browser flow to manual code and confirmed success events', async () => {
    const token = deferred<{ access: string; refresh: string; expires: number; accountId: string }>();
    const { loginOpenAICodexOAuth } = await import('../../electron/services/providers/oauth/openai-codex-oauth');
    vi.mocked(loginOpenAICodexOAuth).mockImplementation(async ({ onManualCodeRequired }) => {
      onManualCodeRequired?.({
        authorizationUrl: 'https://auth.example/authorize',
        reason: 'port_in_use',
      });
      return await token.promise;
    });
    const { registerProviderPrivateAuthHandlers } = await import('../../electron/main/ipc/provider-private-auth');
    const { events, getMainWindow } = createEventSink();
    const browserAccount = { ...account, id: 'confirmed-openai', authMode: 'oauthBrowser' as const };
    registerProviderPrivateAuthHandlers(getMainWindow, {
      execute: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
    }, (accepted) => waitForCallRecord(accepted, 'provider', async () => terminalAccountCall(browserAccount), undefined, () => () => {}));

    await expect(handlers.get('providers:startOAuth')?.({}, {
      flowId: 'browser-flow',
      provider: 'openai',
      account: browserAccount,
    })).resolves.toEqual({ flowId: 'browser-flow', status: 'started' });
    await vi.waitFor(() => expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'browser-flow', status: 'started' } },
      {
        eventName: 'provider-oauth',
        payload: {
          flowId: 'browser-flow',
          status: 'manual_code_required',
          authorizationUrl: 'https://auth.example/authorize',
        },
      },
      {
        eventName: 'oauth:code',
        payload: {
          provider: 'openai',
          mode: 'manual',
          authorizationUrl: 'https://auth.example/authorize',
          message: 'OpenAI OAuth callback port 1455 is in use. Complete sign-in, then paste the final callback URL or code.',
        },
      },
    ]));

    token.resolve({
      access: 'access-canary',
      refresh: 'refresh-canary',
      expires: 1_800_000_000_000,
      accountId: 'native-account-canary',
    });
    await vi.waitFor(() => expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'browser-flow', status: 'started' } },
      {
        eventName: 'provider-oauth',
        payload: {
          flowId: 'browser-flow',
          status: 'manual_code_required',
          authorizationUrl: 'https://auth.example/authorize',
        },
      },
      {
        eventName: 'oauth:code',
        payload: {
          provider: 'openai',
          mode: 'manual',
          authorizationUrl: 'https://auth.example/authorize',
          message: 'OpenAI OAuth callback port 1455 is in use. Complete sign-in, then paste the final callback URL or code.',
        },
      },
      { eventName: 'provider-oauth', payload: { flowId: 'browser-flow', status: 'completed' } },
      {
        eventName: 'oauth:success',
        payload: { provider: 'openai', accountId: 'confirmed-openai', success: true },
      },
    ]));
    expect(JSON.stringify(events)).not.toContain('access-canary');
    expect(JSON.stringify(events)).not.toContain('refresh-canary');
  });

  it('projects device codes through the same flow before its completion event', async () => {
    const token = deferred<{ access: string; refresh: string; expires: number }>();
    const { loginMiniMaxPortalOAuth } = await import('../../electron/services/providers/oauth/device-oauth-providers');
    vi.mocked(loginMiniMaxPortalOAuth).mockImplementation(async ({ note }) => {
      await note('Open https://auth.example/device?user_code=MINIMAX-123 to approve access.');
      return await token.promise;
    });
    const { registerProviderPrivateAuthHandlers } = await import('../../electron/main/ipc/provider-private-auth');
    const { events, getMainWindow } = createEventSink();
    const deviceAccount = {
      ...account,
      id: 'minimax-main',
      provider: 'minimax-portal',
      label: 'MiniMax',
      authMode: 'oauthDevice' as const,
    };
    registerProviderPrivateAuthHandlers(getMainWindow, {
      execute: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
    }, (accepted) => waitForCallRecord(accepted, 'provider', async () => terminalAccountCall(deviceAccount), undefined, () => () => {}));

    await expect(handlers.get('providers:startOAuth')?.({}, {
      flowId: 'device-flow',
      provider: 'minimax-portal',
      account: deviceAccount,
    })).resolves.toEqual({ flowId: 'device-flow', status: 'started' });
    await vi.waitFor(() => expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'device-flow', status: 'started' } },
      {
        eventName: 'provider-oauth',
        payload: {
          flowId: 'device-flow',
          status: 'device_code',
          verificationUri: 'https://auth.example/device?user_code=MINIMAX-123',
          userCode: 'MINIMAX-123',
          expiresIn: 300,
        },
      },
      {
        eventName: 'oauth:code',
        payload: {
          provider: 'minimax-portal',
          verificationUri: 'https://auth.example/device?user_code=MINIMAX-123',
          userCode: 'MINIMAX-123',
          expiresIn: 300,
        },
      },
    ]));

    token.resolve({ access: 'device-access-canary', refresh: 'device-refresh-canary', expires: 1_800_000_000_000 });
    await vi.waitFor(() => expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'device-flow', status: 'started' } },
      {
        eventName: 'provider-oauth',
        payload: {
          flowId: 'device-flow',
          status: 'device_code',
          verificationUri: 'https://auth.example/device?user_code=MINIMAX-123',
          userCode: 'MINIMAX-123',
          expiresIn: 300,
        },
      },
      {
        eventName: 'oauth:code',
        payload: {
          provider: 'minimax-portal',
          verificationUri: 'https://auth.example/device?user_code=MINIMAX-123',
          userCode: 'MINIMAX-123',
          expiresIn: 300,
        },
      },
      { eventName: 'provider-oauth', payload: { flowId: 'device-flow', status: 'completed' } },
      {
        eventName: 'oauth:success',
        payload: { provider: 'minimax-portal', accountId: 'minimax-main', success: true },
      },
    ]));
    expect(JSON.stringify(events)).not.toContain('device-access-canary');
    expect(JSON.stringify(events)).not.toContain('device-refresh-canary');
  });

  it('maps a rejected provider account result to its stable public OAuth error', async () => {
    const { loginOpenAICodexOAuth } = await import('../../electron/services/providers/oauth/openai-codex-oauth');
    vi.mocked(loginOpenAICodexOAuth).mockResolvedValue({
      access: 'access-canary',
      refresh: 'refresh-canary',
      expires: 1_800_000_000_000,
      accountId: 'native-account-canary',
    });
    const { registerProviderPrivateAuthHandlers } = await import('../../electron/main/ipc/provider-private-auth');
    const { events, getMainWindow } = createEventSink();
    const browserAccount = { ...account, authMode: 'oauthBrowser' as const };
    registerProviderPrivateAuthHandlers(getMainWindow, {
      execute: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
    }, (accepted) => waitForCallRecord(accepted, 'provider', async () => ({
      ...terminalAccountCall(browserAccount, { outcome: 'rejected', persisted: null, commit: null }),
      status: 'rejected',
    }), undefined, () => () => {}));

    await handlers.get('providers:startOAuth')?.({}, {
      flowId: 'rejected-flow',
      provider: 'openai',
      account: browserAccount,
    });
    await vi.waitFor(() => expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'rejected-flow', status: 'started' } },
      { eventName: 'provider-oauth', payload: { flowId: 'rejected-flow', status: 'rejected' } },
      {
        eventName: 'oauth:error',
        payload: { message: 'Provider account request was rejected' },
      },
    ]));
    expect(JSON.stringify(events)).not.toContain('access-canary');
    expect(JSON.stringify(events)).not.toContain('refresh-canary');
  });

  it('redacts native OAuth failures behind a fixed public error', async () => {
    const { loginOpenAICodexOAuth } = await import('../../electron/services/providers/oauth/openai-codex-oauth');
    vi.mocked(loginOpenAICodexOAuth).mockRejectedValue(new Error('native failure access-canary refresh-canary'));
    const { registerProviderPrivateAuthHandlers } = await import('../../electron/main/ipc/provider-private-auth');
    const { events, getMainWindow } = createEventSink();
    const browserAccount = { ...account, authMode: 'oauthBrowser' as const };
    registerProviderPrivateAuthHandlers(getMainWindow, { execute: vi.fn() }, vi.fn());

    await handlers.get('providers:startOAuth')?.({}, {
      flowId: 'failed-flow',
      provider: 'openai',
      account: browserAccount,
    });
    await vi.waitFor(() => expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'failed-flow', status: 'started' } },
      { eventName: 'provider-oauth', payload: { flowId: 'failed-flow', status: 'unknown' } },
      { eventName: 'oauth:error', payload: { message: 'Provider OAuth authentication failed' } },
    ]));
    expect(JSON.stringify(events)).not.toContain('native failure');
    expect(JSON.stringify(events)).not.toContain('access-canary');
    expect(JSON.stringify(events)).not.toContain('refresh-canary');
  });

  it('does not project a terminal legacy event after cancellation wins the flow gate', async () => {
    const token = deferred<{ access: string; refresh: string; expires: number; accountId: string }>();
    const { loginOpenAICodexOAuth } = await import('../../electron/services/providers/oauth/openai-codex-oauth');
    vi.mocked(loginOpenAICodexOAuth).mockImplementation(async () => await token.promise);
    const { registerProviderPrivateAuthHandlers } = await import('../../electron/main/ipc/provider-private-auth');
    const { events, getMainWindow } = createEventSink();
    const browserAccount = { ...account, authMode: 'oauthBrowser' as const };
    registerProviderPrivateAuthHandlers(getMainWindow, {
      execute: vi.fn().mockResolvedValue({ status: 202, body: receipt }),
    }, (accepted) => waitForCallRecord(accepted, 'provider', async () => terminalAccountCall(browserAccount), undefined, () => () => {}));

    await handlers.get('providers:startOAuth')?.({}, {
      flowId: 'cancelled-flow',
      provider: 'openai',
      account: browserAccount,
    });
    await vi.waitFor(() => expect(loginOpenAICodexOAuth).toHaveBeenCalledTimes(1));
    await expect(handlers.get('providers:cancelOAuth')?.({}, { flowId: 'cancelled-flow' }))
      .resolves.toEqual({ flowId: 'cancelled-flow', status: 'cancelled' });
    token.resolve({
      access: 'access-canary',
      refresh: 'refresh-canary',
      expires: 1_800_000_000_000,
      accountId: 'native-account-canary',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual([
      { eventName: 'provider-oauth', payload: { flowId: 'cancelled-flow', status: 'started' } },
      { eventName: 'provider-oauth', payload: { flowId: 'cancelled-flow', status: 'cancelled' } },
    ]);
  });

});

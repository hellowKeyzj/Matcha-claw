import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const proxyAwareFetchMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../../electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

vi.mock('../../electron/utils/config', () => ({
  getPort: vi.fn(() => 13210),
}));

vi.mock('../../electron/api/server', () => ({
  getHostApiBaseUrl: vi.fn(() => 'http://127.0.0.1:45678'),
  getHostApiToken: vi.fn(() => 'host-token'),
}));

vi.mock('@electron/e2e-fixture-loader', () => ({
  handleE2EHostApiFetch: vi.fn(async () => null),
}));

describe('hostapi proxy ipc', () => {
  beforeEach(() => {
    vi.resetModules();
    registeredHandlers.clear();
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
      text: async () => 'ok',
    });
  });

  async function fetchViaProxy(request: Record<string, unknown>) {
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();
    const handler = registeredHandlers.get('hostapi:fetch');
    expect(handler).toBeTypeOf('function');
    return await handler?.({}, request);
  }

  async function resolveHostApiBaseUrlViaIpc() {
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();
    const handler = registeredHandlers.get('hostapi:base-url');
    expect(handler).toBeTypeOf('function');
    return await handler?.({});
  }

  it('exposes the actual Host API base URL for direct WebSocket connections', async () => {
    await expect(resolveHostApiBaseUrlViaIpc()).resolves.toBe('http://127.0.0.1:45678');
  });

  it('forwards allowed capability calls with host token', async () => {
    const result = await fetchViaProxy({ path: '/api/capabilities/execute', method: 'POST', body: { id: 'workspace.file' } });

    expect(result).toMatchObject({ ok: true, data: { status: 200, ok: true } });
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/capabilities/execute',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
        body: JSON.stringify({ id: 'workspace.file' }),
      }),
    );
  });

  it('preserves a complete media session prompt result JSON response', async () => {
    const userAttachment = {
      fileName: 'receipt.png',
      mimeType: 'image/png',
      fileSize: 2048,
      preview: 'data:image/png;base64,AA==',
      filePath: '/tmp/receipt.png',
      gatewayUrl: 'http://127.0.0.1:13210/media/receipt.png',
      source: 'user-upload',
    };
    const userMessage = {
      key: 'item-user-1',
      kind: 'user-message',
      sessionKey: 'session-media-1',
      runId: 'run-media-1',
      role: 'user',
      text: 'Please inspect the attached receipt.',
      images: [{ mimeType: 'image/png', data: 'AA==' }],
      attachedFiles: [userAttachment],
      messageId: 'message-user-1',
    };
    const sessionPromptResult = {
      success: true,
      sessionKey: 'session-media-1',
      runId: 'run-media-1',
      item: userMessage,
      snapshot: {
        sessionKey: 'session-media-1',
        catalog: {
          key: 'session-media-1',
          agentId: 'agent-1',
          protocolId: 'matcha-agent',
          runtimeEndpointId: 'runtime-matcha-agent',
          sessionIdentity: {
            endpoint: {
              kind: 'native-runtime',
              runtimeAdapterId: 'matcha-agent',
              runtimeInstanceId: 'runtime-matcha-agent',
            },
            agentId: 'agent-1',
            sessionKey: 'session-media-1',
          },
          kind: 'session',
          preferred: true,
          status: 'active',
          displayName: 'Receipt review',
        },
        items: [userMessage],
        approvals: [],
        usage: [],
        artifacts: [],
        replayComplete: true,
        runtime: {
          activeRunId: 'run-media-1',
          runPhase: 'submitted',
          activeTurnItemKey: 'item-user-1',
          pendingTurnKey: 'turn-media-1',
          pendingTurnLaneKey: 'lane-media-1',
          runtimeActivity: null,
          lastUserMessageAt: 1_700_000_000_000,
          lastError: null,
          lastIssue: null,
          updatedAt: 1_700_000_000_001,
        },
        window: {
          totalItemCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    };
    proxyAwareFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => sessionPromptResult,
      text: async () => 'ok',
    });

    const result = await fetchViaProxy({
      path: '/api/capabilities/execute',
      method: 'POST',
      body: { id: 'session.prompt' },
    });

    expect(result).toEqual({
      ok: true,
      data: { status: 200, ok: true, json: sessionPromptResult },
    });
  });

  it('forwards explicit public read-only routes including query strings', async () => {
    await fetchViaProxy({ path: '/api/openclaw/logs?tailLines=10', method: 'GET' });
    await fetchViaProxy({ path: '/api/matcha-agent/app-server/status', method: 'GET' });

    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:13210/api/openclaw/logs?tailLines=10',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:13210/api/matcha-agent/app-server/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('forwards allowed process restart routes with host token', async () => {
    await fetchViaProxy({ path: '/api/gateway/restart', method: 'POST' });
    await fetchViaProxy({ path: '/api/matcha-agent/app-server/restart', method: 'POST' });
    await fetchViaProxy({ path: '/api/runtime-host/restart', method: 'POST' });

    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:13210/api/gateway/restart',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
      }),
    );
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:13210/api/matcha-agent/app-server/restart',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
      }),
    );
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:13210/api/runtime-host/restart',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
      }),
    );
  });

  it('forwards explicit public validation POST routes', async () => {
    await fetchViaProxy({
      path: '/api/channels/credentials/validate',
      method: 'POST',
      body: { channelType: 'feishu', config: { appId: 'cli_xxx', appSecret: 'secret' } },
    });

    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/channels/credentials/validate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channelType: 'feishu', config: { appId: 'cli_xxx', appSecret: 'secret' } }),
      }),
    );
  });

  it('forwards remote fleet probe-connection POST calls with host token', async () => {
    const result = await fetchViaProxy({
      path: '/api/remote-fleet/probe-connection',
      method: 'POST',
      body: { connectionId: 'connection-1' },
    });

    expect(result).toMatchObject({ ok: true, data: { status: 200, ok: true } });
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/remote-fleet/probe-connection',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
        body: JSON.stringify({ connectionId: 'connection-1' }),
      }),
    );
  });

  it('forwards explicit public Remote Fleet credential and terminal control routes', async () => {
    await fetchViaProxy({
      path: '/api/remote-fleet/write-credential',
      method: 'POST',
      body: { nodeId: 'node-1', credentialName: 'ssh', plaintext: 'secret-value' },
    });
    await fetchViaProxy({
      path: '/api/remote-fleet/terminal/open',
      method: 'POST',
      body: { endpointId: 'endpoint-1' },
    });
    await fetchViaProxy({
      path: '/api/remote-fleet/terminal/sessions',
      method: 'GET',
    });

    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:13210/api/remote-fleet/write-credential',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
        body: JSON.stringify({ nodeId: 'node-1', credentialName: 'ssh', plaintext: 'secret-value' }),
      }),
    );
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:13210/api/remote-fleet/terminal/open',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
        body: JSON.stringify({ endpointId: 'endpoint-1' }),
      }),
    );
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:13210/api/remote-fleet/terminal/sessions',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('forwards the public Remote Fleet registration lifecycle routes', async () => {
    const registrationRequests = [
      { path: '/api/remote-fleet/register-connection', body: { connection: { id: 'connection-1' } } },
      { path: '/api/remote-fleet/register-environment', body: { environment: { id: 'environment-1', connectionId: 'connection-1' } } },
      { path: '/api/remote-fleet/deploy-environment', body: { environmentId: 'environment-1' } },
      { path: '/api/remote-fleet/delete-environment', body: { environmentId: 'environment-1' } },
    ] as const;

    for (const request of registrationRequests) {
      await expect(fetchViaProxy({ ...request, method: 'POST' })).resolves.toMatchObject({ ok: true, data: { status: 200, ok: true } });
    }

    registrationRequests.forEach((request, index) => {
      expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(
        index + 1,
        `http://127.0.0.1:13210${request.path}`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
          body: JSON.stringify(request.body),
        }),
      );
    });
  });

  it('rejects legacy file routes, secret routes, mutations, internal routes, and absolute URLs before forwarding', async () => {
    for (const request of [
      { path: '/api/files/read-text', method: 'POST' },
      { path: '/api/files/write-text', method: 'POST' },
      { path: '/api/provider-accounts/account-1/api-key', method: 'GET' },
      { path: '/api/provider-accounts/validate', method: 'POST' },
      { path: '/api/gateway/start', method: 'POST' },
      { path: '/api/remote-fleet/probe-connection', method: 'GET' },
      { path: '/api/remote-fleet/terminal/stream', method: 'GET' },
      { path: '/api/matcha-agent/app-server/status', method: 'POST' },
      { path: '/api/matcha-agent/app-server/restart', method: 'GET' },
      { path: '/api/matcha-agent/app-server/restart', method: 'PUT' },
      { path: '/internal/runtime-host/shell-actions', method: 'POST' },
      { path: 'http://127.0.0.1:13210/api/capabilities/list', method: 'GET' },
    ]) {
      const result = await fetchViaProxy(request);
      expect(result).toMatchObject({ ok: false });
    }

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});

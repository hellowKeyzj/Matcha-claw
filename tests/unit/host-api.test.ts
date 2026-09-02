import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();

const testRuntimeEndpoint = {
  kind: 'native-runtime' as const,
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

const testSessionIdentity = {
  endpoint: testRuntimeEndpoint,
  agentId: 'default',
  sessionKey: 'agent:default:main',
};

function proxyEnvelope(json: unknown, status = 200) {
  return {
    ok: true,
    data: {
      status,
      ok: status >= 200 && status < 300,
      json,
    },
  };
}

function mockWorkspaceCapabilityExecute(json: unknown, status = 200) {
  invokeIpcMock.mockResolvedValueOnce(proxyEnvelope(json, status));
}

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('host-api', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('uses IPC proxy and returns unified envelope json', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true },
      },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    const result = await hostApiFetch<{ success: boolean }>('/api/settings');

    expect(result.success).toBe(true);
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({ path: '/api/settings', method: 'GET' }),
    );
  });

  it('resolves the direct Host API base URL through IPC', async () => {
    invokeIpcMock.mockResolvedValueOnce('http://127.0.0.1:45678');

    const { resolveHostApiBase } = await import('@/lib/host-api');
    await expect(resolveHostApiBase()).resolves.toBe('http://127.0.0.1:45678');
    expect(invokeIpcMock).toHaveBeenCalledWith('hostapi:base-url');
  });

  it('throws message from unified non-ok envelope', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Invalid Authentication' },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('Invalid Authentication');
  });

  it('preserves safe proxy error code from unified non-ok envelope', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'TIMEOUT' },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('throws when host api returns http error status in proxy envelope', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 500,
        ok: false,
        json: { success: false, error: 'Runtime Host HTTP request failed: GET /api/cron/jobs (fetch failed)' },
      },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/cron/jobs')).rejects.toThrow(
      'Runtime Host HTTP request failed: GET /api/cron/jobs (fetch failed)',
    );
  });

  it('rejects malformed success envelope when status is missing', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: false,
        json: { message: 'logical failed' },
      },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/cron/jobs')).rejects.toThrow('missing numeric status');
  });

  it('rejects legacy envelope schema', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      success: true,
      status: 200,
      json: { value: 1 },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('missing boolean ok');
  });

  it('requires SessionIdentity on session-specific host API payloads', async () => {
    const source = await readFile(join(process.cwd(), 'src/lib/host-api.ts'), 'utf8');
    const sessionFunctions = [...source.matchAll(/export async function (hostSession\w+)\([\s\S]*?\r?\n}\s*\r?\n/g)];
    expect(sessionFunctions.length).toBeGreaterThan(0);
    for (const match of sessionFunctions) {
      const functionSource = match[0];
      if (functionSource.includes('hostSessionPost') && !functionSource.includes('payload: { scope: RuntimeScope }')) {
        expect(functionSource, match[1]).toContain('sessionIdentity: SessionIdentity');
        expect(functionSource, match[1]).not.toContain('sessionIdentity?: SessionIdentity');
      }
    }
  });

  it('does not fall back to browser fetch when IPC channel is unavailable', async () => {
    invokeIpcMock.mockRejectedValueOnce(new Error('Invalid IPC channel: hostapi:fetch'));

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('Invalid IPC channel: hostapi:fetch');
  });

  it('hostFileReadText sends only the session-relative read contract', async () => {
    mockWorkspaceCapabilityExecute({ name: 'docs/demo.txt', content: 'demo', size: 4 });

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'docs/demo.txt',
    });

    expect(result).toEqual({ ok: true, content: 'demo', size: 4 });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/read-text',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readText',
          scope: {
            kind: 'session',
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
          },
          target: { kind: 'workspace-file' },
          input: {
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
            relativePath: 'docs/demo.txt',
          },
        }),
      }),
    );
    expect(JSON.stringify(invokeIpcMock.mock.calls)).not.toContain('/workspace');
  });

  it('hostWorkspaceMediaThumbnail uses the sealed thumbnail DTO without exposing native details', async () => {
    mockWorkspaceCapabilityExecute({
      preview: 'data:image/png;base64,YWJj',
      fileSize: 3,
    });

    const { hostWorkspaceMediaThumbnail } = await import('@/lib/host-api');
    const result = await hostWorkspaceMediaThumbnail({
      relativePath: 'artifacts/demo.png',
      mimeType: 'image/png',
      sessionIdentity: testSessionIdentity,
    });

    expect(result).toEqual({ preview: 'data:image/png;base64,YWJj', fileSize: 3 });
    expect(invokeIpcMock).not.toHaveBeenCalledWith('dialog:stageRendererBufferAttachment', expect.anything());
    const capabilityCall = invokeIpcMock.mock.calls.find(([channel]) => channel === 'hostapi:fetch');
    expect(JSON.stringify(capabilityCall)).not.toContain('reference');
    expect(JSON.stringify(capabilityCall)).not.toContain('stagedAttachmentId');
  });

  it('hostWorkspaceMediaThumbnail projects sealed media failures', async () => {
    mockWorkspaceCapabilityExecute({ success: false, error: 'Workspace media path is invalid' }, 422);
    const { hostWorkspaceMediaThumbnail } = await import('@/lib/host-api');

    await expect(hostWorkspaceMediaThumbnail({
      relativePath: 'artifacts/demo.png',
      mimeType: 'image/png',
      sessionIdentity: testSessionIdentity,
    })).resolves.toEqual({ preview: null, fileSize: 0, error: 'invalidPath' });
  });

  it('hostWorkspaceMediaThumbnail keeps raw size when preview is unavailable', async () => {
    mockWorkspaceCapabilityExecute({
      preview: null,
      fileSize: 42,
    });

    const { hostWorkspaceMediaThumbnail } = await import('@/lib/host-api');
    await expect(hostWorkspaceMediaThumbnail({
      relativePath: 'artifacts/demo.png',
      mimeType: 'image/png',
      sessionIdentity: testSessionIdentity,
    })).resolves.toEqual({ preview: null, fileSize: 42 });
    expect(invokeIpcMock).not.toHaveBeenCalledWith('dialog:stageRendererBufferAttachment', expect.anything());
  });

  it('hostWorkspaceMediaThumbnail rejects absolute paths without delivery', async () => {
    const { hostWorkspaceMediaThumbnail } = await import('@/lib/host-api');
    await expect(hostWorkspaceMediaThumbnail({
      relativePath: '/workspace/demo.png',
      mimeType: 'image/png',
      sessionIdentity: testSessionIdentity,
    })).resolves.toEqual({ preview: null, fileSize: 0, error: 'invalidPath' });
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('hostWorkspaceMediaThumbnail accepts only outgoing Gateway media URLs', async () => {
    mockWorkspaceCapabilityExecute({ preview: 'data:image/svg+xml;base64,PHN2Zw==', fileSize: 6 });

    const { hostWorkspaceMediaThumbnail } = await import('@/lib/host-api');
    await expect(hostWorkspaceMediaThumbnail({
      gatewayUrl: 'https://gateway.local/api/chat/media/outgoing/agent%3Adefault%3Amain/attachment-1/full',
      mimeType: 'image/svg+xml',
      agentId: 'default',
      sessionIdentity: testSessionIdentity,
    })).resolves.toEqual({ preview: 'data:image/svg+xml;base64,PHN2Zw==', fileSize: 6 });
    await expect(hostWorkspaceMediaThumbnail({
      gatewayUrl: 'https://gateway.local/media/attachment-1.svg',
      mimeType: 'image/svg+xml',
      agentId: 'default',
      sessionIdentity: testSessionIdentity,
    })).resolves.toEqual({ preview: null, fileSize: 0, error: 'invalidPath' });
    expect(invokeIpcMock).toHaveBeenCalledTimes(1);
  });

  it('hostFileThumbnail converts an in-workspace absolute path without transporting it', async () => {
    mockWorkspaceCapabilityExecute({
      preview: 'data:image/png;base64,YWJj',
      fileSize: 3,
    });

    const { hostFileThumbnail } = await import('@/lib/host-api');
    await expect(hostFileThumbnail({
      path: 'C:/workspace/demo.png',
      workspaceRoot: 'C:/workspace',
      mimeType: 'image/png',
      sessionIdentity: testSessionIdentity,
    })).resolves.toEqual({ preview: 'data:image/png;base64,YWJj', fileSize: 3 });

    const capabilityCall = invokeIpcMock.mock.calls.find(([channel]) => channel === 'hostapi:fetch');
    expect(JSON.stringify(capabilityCall)).toContain('demo.png');
    expect(JSON.stringify(capabilityCall)).not.toContain('C:/workspace');
    expect(JSON.stringify(capabilityCall)).toContain('media.thumbnail');
  });

  it('hostUvInstallAll uses the platform runtime install capability', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true }));

    const { hostUvInstallAll } = await import('@/lib/host-api');
    await hostUvInstallAll(testRuntimeEndpoint);

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: 120000,
        body: JSON.stringify({
          id: 'platform.runtime',
          operationId: 'toolchain.installUv',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          target: { kind: 'platform-runtime' },
          input: {},
        }),
      }),
    );
  });

  it('hostSessionList uses endpoint scoped capability execute', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ sessions: [] }));

    const { hostSessionList } = await import('@/lib/host-api');
    const result = await hostSessionList({ endpoint: testRuntimeEndpoint });

    expect(result).toEqual({ sessions: [] });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.management',
          operationId: 'sessions.list',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          target: { kind: 'runtime-endpoint' },
          input: { endpoint: testRuntimeEndpoint },
        }),
      }),
    );
  });

  it('hostFileReadText exposes only sealed workspace text failures', async () => {
    mockWorkspaceCapabilityExecute({
      success: false,
      error: 'Workspace text target exceeds the limit',
    }, 422);

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'docs/demo.md',
    });

    expect(result).toEqual({ ok: false, error: 'tooLarge' });
  });

  it('hostFileReadText redacts malformed and unavailable proxy responses', async () => {
    mockWorkspaceCapabilityExecute({
      success: false,
      error: 'private native failure at C:/workspace/root',
    }, 422);

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'docs/demo.md',
    });

    expect(result).toEqual({ ok: false, error: 'unavailable' });
  });

  it('hostFileReadBinary uses the fixed session-relative binary delivery route', async () => {
    mockWorkspaceCapabilityExecute({ name: 'docs/demo.pdf', data: 'UEsDBA==', size: 4 });

    const { hostFileReadBinary } = await import('@/lib/host-api');
    const result = await hostFileReadBinary({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'docs/demo.pdf',
      maxBytes: 1024,
    });

    expect(result).toEqual({ ok: true, name: 'docs/demo.pdf', data: 'UEsDBA==', size: 4 });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/binary',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readBinary',
          scope: {
            kind: 'session',
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
          },
          target: { kind: 'workspace-file' },
          input: {
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
            relativePath: 'docs/demo.pdf',
            maxBytes: 1024,
          },
        }),
      }),
    );
    expect(JSON.stringify(invokeIpcMock.mock.calls)).not.toContain('/tmp/demo.pdf');
  });

  it('hostFileStat projects the Rust mtime without metadata leakage', async () => {
    mockWorkspaceCapabilityExecute({
      name: 'docs/demo.md',
      isDirectory: false,
      size: 5,
      mtimeMs: 1_700_000_000_000,
    });

    const { hostFileStat } = await import('@/lib/host-api');
    await expect(hostFileStat({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'docs/demo.md',
    })).resolves.toEqual({
      ok: true,
      name: 'docs/demo.md',
      isDirectory: false,
      size: 5,
      mtimeMs: 1_700_000_000_000,
    });
  });

  it('hostFileListDir uses the fixed session-relative delivery route', async () => {
    mockWorkspaceCapabilityExecute({
      entries: [{ relativePath: 'src', display: 'src', isDirectory: true, size: 0 }],
    });

    const { hostFileListDir } = await import('@/lib/host-api');
    const result = await hostFileListDir({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: '',
      includeHidden: true,
    });

    expect(result).toEqual({
      ok: true,
      entries: [{
        relativePath: 'src',
        display: 'src',
        isDirectory: true,
        size: 0,
      }],
    });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/list-dir',
        method: 'POST',
        timeoutMs: 60000,
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.listDir',
          scope: {
            kind: 'session',
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
          },
          target: { kind: 'workspace-file' },
          input: {
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
            relativePath: '',
            includeHidden: true,
          },
        }),
      }),
    );
  });

  it('hostFileWriteText uses the fixed session-relative delivery route', async () => {
    mockWorkspaceCapabilityExecute({ name: 'notes.txt', size: 5 });

    const { hostFileWriteText } = await import('@/lib/host-api');
    const result = await hostFileWriteText({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'docs/notes.txt',
      content: 'notes',
    });

    expect(result).toEqual({ ok: true, name: 'notes.txt', size: 5 });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/write-text',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.writeText',
          scope: {
            kind: 'session',
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
          },
          target: { kind: 'workspace-file' },
          input: {
            endpoint: testRuntimeEndpoint,
            sessionKey: testSessionIdentity.sessionKey,
            relativePath: 'docs/notes.txt',
            content: 'notes',
          },
        }),
      }),
    );
  });

  it('redacts malformed workspace directory and write responses', async () => {
    mockWorkspaceCapabilityExecute({ entries: [{ relativePath: 'private', display: 'private', isDirectory: true, size: -1 }] });
    const { hostFileListDir, hostFileWriteText } = await import('@/lib/host-api');

    await expect(hostFileListDir({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: '',
    })).resolves.toEqual({ ok: false, error: 'unavailable' });

    mockWorkspaceCapabilityExecute({ success: false, error: 'native root /private secret' }, 422);
    await expect(hostFileWriteText({
      endpoint: testRuntimeEndpoint,
      sessionKey: testSessionIdentity.sessionKey,
      relativePath: 'notes.txt',
      content: 'notes',
    })).resolves.toEqual({ ok: false, error: 'unavailable' });
  });

  it('resolveSingleCapabilityScope rejects missing or ambiguous capability scopes', async () => {
    invokeIpcMock
      .mockResolvedValueOnce(proxyEnvelope({ capabilities: [] }))
      .mockResolvedValueOnce(proxyEnvelope({
        capabilities: [{
          id: 'platform.runtime',
          kind: 'platform-runtime',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          scopeKind: 'runtime-instance',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          targetAgentIds: ['default'],
          supportLevel: 'native',
          availability: 'available',
          operations: [],
          policyScope: 'platform.runtime',
        }, {
          id: 'platform.runtime',
          kind: 'platform-runtime',
          scope: { kind: 'runtime-instance', endpoint: { ...testRuntimeEndpoint, runtimeInstanceId: 'workspace-b' } },
          scopeKind: 'runtime-instance',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'workspace-b',
          targetAgentIds: ['default'],
          supportLevel: 'native',
          availability: 'available',
          operations: [],
          policyScope: 'platform.runtime',
        }],
      }));

    const { resolveSingleCapabilityScope } = await import('@/lib/host-api');

    await expect(resolveSingleCapabilityScope('platform.runtime')).rejects.toThrow('available scopes: none');
    await expect(resolveSingleCapabilityScope('platform.runtime')).rejects.toThrow('got 2; available scopes:');
  });

  it('resolveSingleCapabilityScope shares inflight capability list requests', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({
      capabilities: [{
        id: 'platform.runtime',
        kind: 'platform-runtime',
        scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
        scopeKind: 'runtime-instance',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        targetAgentIds: ['default'],
        supportLevel: 'native',
        availability: 'available',
        operations: [],
        policyScope: 'platform.runtime',
      }],
    }));

    const { resolveSingleCapabilityScope } = await import('@/lib/host-api');
    const [first, second] = await Promise.all([
      resolveSingleCapabilityScope('platform.runtime'),
      resolveSingleCapabilityScope('platform.runtime'),
    ]);

    expect(first).toEqual({ kind: 'runtime-instance', endpoint: testRuntimeEndpoint });
    expect(second).toEqual(first);
    expect(invokeIpcMock).toHaveBeenCalledTimes(1);
  });

  it('hostCapabilityExecute 保持内部化且不暴露旧 runtime host active 出口', async () => {
    const source = await readFile(join(process.cwd(), 'src/lib/host-api.ts'), 'utf8');

    expect(source).toContain('async function hostCapabilityExecute');
    expect(source).not.toContain('export async function hostCapabilityExecute');
    expect(source).not.toContain('hostNamedCapabilityExecute');
    expect(source).not.toContain('runtimeHostCapabilityExecute');
    expect(source).not.toContain('hostRuntimePrepareGatewayLaunch');
    expect(source).not.toContain('hostRuntimeGatewayLifecycle');
    expect(source).not.toContain('hostRuntimeGatewayReady');
    expect(source).not.toContain('hostRuntimeGatewayControlUiAutoApprove');
  });

  it('hostSessionLoad executes the session load capability and preserves timeoutMs', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ snapshot: { sessionKey: testSessionIdentity.sessionKey } }));

    const { hostSessionLoad } = await import('@/lib/host-api');
    await hostSessionLoad({
      sessionIdentity: testSessionIdentity,
    }, { timeoutMs: 35000 });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: 35000,
        body: JSON.stringify({
          id: 'session.prompt',
          operationId: 'sessions.load',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: {
            sessionIdentity: testSessionIdentity,
            sessionKey: testSessionIdentity.sessionKey,
          },
        }),
      }),
    );
  });

  it('hostSessionNew executes the OpenClaw create capability with an endpoint session id', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ outcome: 'succeeded', sessionKey: 'agent:main:session-1' }));

    const { hostSessionNew } = await import('@/lib/host-api');
    await hostSessionNew({
      endpoint: testRuntimeEndpoint,
      agentId: 'main',
      endpointSessionId: 'session-1',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.prompt',
          operationId: 'sessions.create',
          scope: { kind: 'agent', endpoint: testRuntimeEndpoint, agentId: 'main' },
          target: { kind: 'agent', agentId: 'main' },
          input: {
            endpoint: testRuntimeEndpoint,
            agentId: 'main',
            endpointSessionId: 'session-1',
          },
        }),
      }),
    );
  });

  it('hostSessionWindowFetch executes the session window capability with the caller SessionIdentity', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({
      outcome: 'complete',
      sessionIdentity: testSessionIdentity,
      messages: [],
      window: {
        totalItemCount: 0,
        windowStartOffset: 0,
        windowEndOffset: 0,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
    }));

    const { hostSessionWindowFetch } = await import('@/lib/host-api');
    await hostSessionWindowFetch({
      sessionIdentity: testSessionIdentity,
      mode: 'latest',
      limit: 50,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.management',
          operationId: 'sessions.window',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: {
            sessionIdentity: testSessionIdentity,
            mode: 'latest',
            limit: 50,
            sessionKey: testSessionIdentity.sessionKey,
          },
        }),
      }),
    );
  });

  it('hostSessionDelete executes the session delete capability with only the caller SessionIdentity', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ outcome: 'succeeded' }));

    const { hostSessionDelete } = await import('@/lib/host-api');
    await hostSessionDelete({
      sessionIdentity: testSessionIdentity,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.management',
          operationId: 'sessions.delete',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: {
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostSessionRename executes the identity-bound rename capability', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ outcome: 'succeeded' }));

    const { hostSessionRename } = await import('@/lib/host-api');
    await hostSessionRename({
      sessionIdentity: testSessionIdentity,
      label: 'Renamed',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.management',
          operationId: 'sessions.rename',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: {
            sessionIdentity: testSessionIdentity,
            label: 'Renamed',
          },
        }),
      }),
    );
  });

  it('hostSessionPrompt uses the media prompt capability for staged attachments', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({
      success: true,
      sessionKey: testSessionIdentity.sessionKey,
      runId: 'run-media-1',
      item: null,
      snapshot: {},
    }));

    const { hostSessionPrompt } = await import('@/lib/host-api');
    await expect(hostSessionPrompt({
      sessionIdentity: testSessionIdentity,
      message: 'Review the image',
      idempotencyKey: 'user-local-media-1',
      deliver: false,
      attachments: [{
        stagedAttachmentId: 'attachment-image',
        mimeType: 'image/png',
        fileName: 'image.png',
        fileSize: 5,
      }],
    })).resolves.toEqual({
      success: true,
      sessionKey: testSessionIdentity.sessionKey,
      runId: 'run-media-1',
      item: null,
      snapshot: {},
    });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: expect.any(Number),
        body: JSON.stringify({
          id: 'session.prompt',
          operationId: 'sessions.sendWithMedia',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: {
            sessionIdentity: testSessionIdentity,
            message: 'Review the image',
            idempotencyKey: 'user-local-media-1',
            deliver: false,
            attachments: [{
              stagedAttachmentId: 'attachment-image',
              mimeType: 'image/png',
              fileName: 'image.png',
              fileSize: 5,
            }],
            sessionKey: testSessionIdentity.sessionKey,
          },
        }),
      }),
    );
  });

  it('hostSessionPatch executes the session model selection capability', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true, snapshot: { sessionKey: testSessionIdentity.sessionKey } }));

    const { hostSessionPatch } = await import('@/lib/host-api');
    await hostSessionPatch({
      endpointSessionId: 'main',
      sessionIdentity: testSessionIdentity,
      modelSelectionId: 'anthropic:claude-sonnet-4-6',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: 30000,
        body: JSON.stringify({
          id: 'session.modelSelection',
          operationId: 'sessions.patchModel',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'model-selection', identity: testSessionIdentity, modelSelectionId: 'anthropic:claude-sonnet-4-6' },
          input: {
            endpointSessionId: 'main',
            sessionIdentity: testSessionIdentity,
            modelSelectionId: 'anthropic:claude-sonnet-4-6',
            sessionKey: testSessionIdentity.sessionKey,
          },
        }),
      }),
    );
  });

  it('sends the session approval resolution contract', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true }));

    const { hostSessionResolveApproval } = await import('@/lib/host-api');
    await hostSessionResolveApproval({
      id: 'approval-1',
      endpointSessionId: 'main',
      sessionIdentity: testSessionIdentity,
      decision: 'allow-once',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.approval',
          operationId: 'approvals.resolve',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'approval', identity: testSessionIdentity, approvalId: 'approval-1' },
          input: {
            id: 'approval-1',
            endpointSessionId: 'main',
            sessionIdentity: testSessionIdentity,
            decision: 'allow-once',
            sessionKey: testSessionIdentity.sessionKey,
          },
        }),
      }),
    );
  });

  it('sends the session approval list contract', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ approvals: [] }));

    const { hostSessionApprovals } = await import('@/lib/host-api');
    await hostSessionApprovals({ sessionIdentity: testSessionIdentity, endpointSessionId: 'main' });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.approval',
          operationId: 'approvals.list',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: { sessionIdentity: testSessionIdentity, endpointSessionId: 'main' },
        }),
      }),
    );
  });

});

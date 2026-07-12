import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionPromptResult, SessionRenderUserMessageItem } from '../../runtime-host/shared/session-adapter-types';
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

const workspaceScope = {
  kind: 'workspace' as const,
  endpoint: testRuntimeEndpoint,
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

  it('throws message from unified non-ok envelope', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Invalid Authentication' },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('Invalid Authentication');
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
    const sessionFunctions = [...source.matchAll(/export async function (hostSession\w+)\([\s\S]*?\n}\n/g)];
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

  it('hostFileStagePaths uses workspace capability execute', async () => {
    const workspaceStagingTarget = { kind: 'workspace-staging' as const, identity: testSessionIdentity };
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: [{ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null }],
      },
    });

    const { hostFileStagePaths } = await import('@/lib/host-api');
    const result = await hostFileStagePaths({
      filePaths: ['/tmp/demo.txt'],
      sessionIdentity: testSessionIdentity,
    });

    expect(result).toEqual([{ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null }]);
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.stagePaths',
          scope: workspaceScope,
          target: workspaceStagingTarget,
          input: {
            filePaths: ['/tmp/demo.txt'],
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostFileReadText ignores UI workspace metadata for authoritative workspace scope and target', async () => {
    mockWorkspaceCapabilityExecute({ ok: true, path: '/workspace/demo.txt', content: 'demo', mimeType: 'text/plain' });

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({
      path: '/workspace/demo.txt',
      sessionIdentity: testSessionIdentity,
      workspaceId: 'workspace-1',
      sourceId: 'source-1',
    });

    expect(result).toEqual({ ok: true, path: '/workspace/demo.txt', content: 'demo', mimeType: 'text/plain' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readText',
          scope: workspaceScope,
          target: {
            kind: 'workspace-file',
            path: '/workspace/demo.txt',
            identity: testSessionIdentity,
          },
          input: {
            path: '/workspace/demo.txt',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostFileStagePaths ignores UI workspace metadata in capability payload', async () => {
    mockWorkspaceCapabilityExecute([{ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null }]);

    const { hostFileStagePaths } = await import('@/lib/host-api');
    await hostFileStagePaths({
      filePaths: ['/workspace/demo.txt'],
      sessionIdentity: testSessionIdentity,
      workspaceId: 'workspace-1',
      sourceId: 'source-1',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.stagePaths',
          scope: workspaceScope,
          target: { kind: 'workspace-staging', identity: testSessionIdentity },
          input: {
            filePaths: ['/workspace/demo.txt'],
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostFileStageBuffer uses workspace capability execute', async () => {
    mockWorkspaceCapabilityExecute({ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null });

    const { hostFileStageBuffer } = await import('@/lib/host-api');
    const result = await hostFileStageBuffer({
      base64: 'ZGVtbw==',
      fileName: 'demo.txt',
      mimeType: 'text/plain',
      sessionIdentity: testSessionIdentity,
    });

    expect(result).toEqual({ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.stageBuffer',
          scope: workspaceScope,
          target: { kind: 'workspace-staging', identity: testSessionIdentity },
          input: {
            base64: 'ZGVtbw==',
            fileName: 'demo.txt',
            mimeType: 'text/plain',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostFileThumbnail uses workspace file capability execute with matching target path', async () => {
    mockWorkspaceCapabilityExecute({ preview: 'data:image/png;base64,abc', fileSize: 3 });

    const { hostFileThumbnail } = await import('@/lib/host-api');
    const result = await hostFileThumbnail({
      path: '/workspace/artifact.png',
      mimeType: 'image/png',
      sessionIdentity: testSessionIdentity,
      workspaceId: 'workspace-1',
      sourceId: 'source-1',
    });

    expect(result).toEqual({ preview: 'data:image/png;base64,abc', fileSize: 3 });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.thumbnail',
          scope: workspaceScope,
          target: {
            kind: 'workspace-file',
            path: '/workspace/artifact.png',
            identity: testSessionIdentity,
          },
          input: {
            path: '/workspace/artifact.png',
            mimeType: 'image/png',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostUvInstallAll uses runtime-job target', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true, job: { id: 'job-uv', type: 'toolchain.installUv' } }, 202));

    const { hostUvInstallAll } = await import('@/lib/host-api');
    const result = await hostUvInstallAll(testRuntimeEndpoint);

    expect(result).toEqual({ success: true, job: { id: 'job-uv', type: 'toolchain.installUv' } });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'platform.runtime',
          operationId: 'toolchain.installUv',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          target: { kind: 'runtime-job' },
          input: {},
        }),
      }),
    );
  });

  it('hostRuntimePrepareGatewayLaunch uses gateway-control target', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true, job: { id: 'job-gateway', type: 'runtimeHost.prepareGatewayLaunch' } }, 202));

    const { hostRuntimePrepareGatewayLaunch } = await import('@/lib/host-api');
    await hostRuntimePrepareGatewayLaunch({ gatewayToken: 'token-1' }, testRuntimeEndpoint);

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'runtime.host',
          operationId: 'runtimeHost.prepareGatewayLaunch',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          target: { kind: 'gateway-control' },
          input: { gatewayToken: 'token-1' },
        }),
      }),
    );
  });

  it('hostDiagnosticsCollect executes against the caller supplied runtime endpoint', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true, job: { id: 'job-1', type: 'diagnostics.collect' } }, 202));

    const { hostDiagnosticsCollect } = await import('@/lib/host-api');
    const result = await hostDiagnosticsCollect(testRuntimeEndpoint);

    expect(result).toEqual({ success: true, job: { id: 'job-1', type: 'diagnostics.collect' } });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'runtime.host',
          operationId: 'diagnostics.collect',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          target: { kind: 'runtime-endpoint' },
          input: {},
        }),
      }),
    );
  });

  it('hostSessionList uses endpoint scoped capability execute', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({
      sessions: [],
      ready: true,
      refreshing: false,
      updatedAt: null,
      error: null,
    }));

    const { hostSessionList } = await import('@/lib/host-api');
    const result = await hostSessionList({ endpoint: testRuntimeEndpoint });

    expect(result).toEqual({ sessions: [], ready: true, refreshing: false, updatedAt: null, error: null });
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

  it('hostFileReadText uses workspace file capability execute', async () => {
    const workspaceFileTarget = { kind: 'workspace-file' as const, path: '/tmp/demo.md', identity: testSessionIdentity };
    mockWorkspaceCapabilityExecute({ ok: true, content: '# Hello' });

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({ path: '/tmp/demo.md', sessionIdentity: testSessionIdentity });

    expect(result).toEqual({ ok: true, content: '# Hello' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readText',
          scope: workspaceScope,
          target: workspaceFileTarget,
          input: {
            path: '/tmp/demo.md',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostFileReadBinary uses workspace file capability execute', async () => {
    const workspaceFileTarget = { kind: 'workspace-file' as const, path: '/tmp/demo.pdf', identity: testSessionIdentity };
    mockWorkspaceCapabilityExecute({ ok: true, data: 'UEsDBA==' });

    const { hostFileReadBinary } = await import('@/lib/host-api');
    const result = await hostFileReadBinary({ path: '/tmp/demo.pdf', sessionIdentity: testSessionIdentity });

    expect(result).toEqual({ ok: true, data: 'UEsDBA==' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readBinary',
          scope: workspaceScope,
          target: workspaceFileTarget,
          input: {
            path: '/tmp/demo.pdf',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostFileListDir uses workspace file capability execute', async () => {
    const workspaceFileTarget = { kind: 'workspace-file' as const, path: '/tmp/workspace', identity: testSessionIdentity };
    mockWorkspaceCapabilityExecute({ ok: true, entries: [{ name: 'src', path: '/tmp/workspace/src', isDir: true, size: 0, mtimeMs: 0, hasChildren: true }] });

    const { hostFileListDir } = await import('@/lib/host-api');
    const result = await hostFileListDir({ path: '/tmp/workspace', sessionIdentity: testSessionIdentity });

    expect(result).toEqual({
      ok: true,
      entries: [{ name: 'src', path: '/tmp/workspace/src', isDir: true, size: 0, mtimeMs: 0, hasChildren: true }],
    });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: 60000,
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.listDir',
          scope: workspaceScope,
          target: workspaceFileTarget,
          input: {
            path: '/tmp/workspace',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('waitForRuntimeJobResult 在 done 事件缺失时轮询到终态', async () => {
    vi.useFakeTimers();
    try {
      invokeIpcMock
        .mockResolvedValueOnce({
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-1',
                type: 'sessions.hydrateTimeline',
                status: 'queued',
                queuedAt: 1,
                attempts: 0,
                maxAttempts: 1,
              },
            },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-1',
                type: 'sessions.hydrateTimeline',
                status: 'running',
                queuedAt: 1,
                startedAt: 2,
                attempts: 1,
                maxAttempts: 1,
              },
            },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-1',
                type: 'sessions.hydrateTimeline',
                status: 'succeeded',
                queuedAt: 1,
                startedAt: 2,
                finishedAt: 3,
                attempts: 1,
                maxAttempts: 1,
              },
            },
          },
        });

      const { waitForRuntimeJobResult } = await import('@/lib/host-api');
      const result = waitForRuntimeJobResult('job-1', { intervalMs: 50, timeoutMs: 1000, endpoint: testRuntimeEndpoint });

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toBeUndefined();
      expect(invokeIpcMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForRuntimeJobResult 对缺失 job 使用宽限期后失败，避免无限轮询', async () => {
    vi.useFakeTimers();
    try {
      invokeIpcMock.mockImplementation(async (_channel: string, request?: { body?: string }) => {
        if (request?.body) {
          const body = JSON.parse(request.body) as { operationId?: string };
          if (body.operationId === 'runtimeHost.jobGet') {
            return proxyEnvelope({ success: true, job: null });
          }
        }
        return proxyEnvelope({
          capabilities: [{
            id: 'runtime.host',
            availability: 'available',
            scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          }],
        });
      });

      const { waitForRuntimeJobResult } = await import('@/lib/host-api');
      const assertion = expect(
        waitForRuntimeJobResult('missing-job', { intervalMs: 500, timeoutMs: 5000, endpoint: testRuntimeEndpoint }),
      ).rejects.toThrow('runtime job not found: missing-job');

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);

      await assertion;
      expect(invokeIpcMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hostCapabilitiesList 读取 runtime capability 列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { capabilities: [] },
      },
    });

    const { hostCapabilitiesList } = await import('@/lib/host-api');
    await expect(hostCapabilitiesList()).resolves.toEqual({ capabilities: [] });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/list',
        method: 'GET',
      }),
    );
  });

  it('resolveSingleCapabilityScope rejects missing or ambiguous capability scopes', async () => {
    invokeIpcMock
      .mockResolvedValueOnce(proxyEnvelope({ capabilities: [] }))
      .mockResolvedValueOnce(proxyEnvelope({
        capabilities: [{
          id: 'runtime.host',
          kind: 'runtime-host',
          scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
          scopeKind: 'runtime-instance',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          targetAgentIds: ['default'],
          supportLevel: 'native',
          availability: 'available',
          operations: [],
          policyScope: 'runtime.host',
        }, {
          id: 'runtime.host',
          kind: 'runtime-host',
          scope: { kind: 'runtime-instance', endpoint: { ...testRuntimeEndpoint, runtimeInstanceId: 'workspace-b' } },
          scopeKind: 'runtime-instance',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'workspace-b',
          targetAgentIds: ['default'],
          supportLevel: 'native',
          availability: 'available',
          operations: [],
          policyScope: 'runtime.host',
        }],
      }));

    const { resolveSingleCapabilityScope } = await import('@/lib/host-api');

    await expect(resolveSingleCapabilityScope('runtime.host')).rejects.toThrow('available scopes: none');
    await expect(resolveSingleCapabilityScope('runtime.host')).rejects.toThrow('got 2; available scopes:');
  });

  it('resolveSingleCapabilityScope shares inflight capability list requests', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({
      capabilities: [{
        id: 'runtime.host',
        kind: 'runtime-host',
        scope: { kind: 'runtime-instance', endpoint: testRuntimeEndpoint },
        scopeKind: 'runtime-instance',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        targetAgentIds: ['default'],
        supportLevel: 'native',
        availability: 'available',
        operations: [],
        policyScope: 'runtime.host',
      }],
    }));

    const { resolveSingleCapabilityScope } = await import('@/lib/host-api');
    const [first, second] = await Promise.all([
      resolveSingleCapabilityScope('runtime.host'),
      resolveSingleCapabilityScope('runtime.host'),
    ]);

    expect(first).toEqual({ kind: 'runtime-instance', endpoint: testRuntimeEndpoint });
    expect(second).toEqual(first);
    expect(invokeIpcMock).toHaveBeenCalledTimes(1);
  });

  it('hostRuntimeAdaptersList 读取 runtime adapter 列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { adapters: [] },
      },
    });

    const { hostRuntimeAdaptersList } = await import('@/lib/host-api');
    await expect(hostRuntimeAdaptersList()).resolves.toEqual({ adapters: [] });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/runtime-adapters/list',
        method: 'GET',
      }),
    );
  });

  it('hostRuntimeAdapterInstancesList 读取 runtime adapter instance 列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { instances: [] },
      },
    });

    const { hostRuntimeAdapterInstancesList } = await import('@/lib/host-api');
    await expect(hostRuntimeAdapterInstancesList()).resolves.toEqual({ instances: [] });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/runtime-adapters/instances/list',
        method: 'GET',
      }),
    );
  });

  it('hostRuntimeConnectorsList 读取 runtime connector 列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { connectors: [] },
      },
    });

    const { hostRuntimeConnectorsList } = await import('@/lib/host-api');
    await expect(hostRuntimeConnectorsList()).resolves.toEqual({ connectors: [] });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/runtime-connectors/list',
        method: 'GET',
      }),
    );
  });

  it('hostRuntimeConnectorConnect 连接 runtime connector endpoint', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true, readiness: { ready: true, phase: 'connected' } },
      },
    });

    const { hostRuntimeConnectorConnect } = await import('@/lib/host-api');
    const payload = { protocolId: 'acp', connectorId: 'acp', endpointId: 'claude-code' };
    await expect(hostRuntimeConnectorConnect(payload)).resolves.toEqual({ success: true, readiness: { ready: true, phase: 'connected' } });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/runtime-connectors/connect',
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
  });

  it('hostRuntimeConnectorDisconnect 断开 runtime connector endpoint', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true, readiness: { ready: false, phase: 'disconnected' } },
      },
    });

    const { hostRuntimeConnectorDisconnect } = await import('@/lib/host-api');
    const payload = { protocolId: 'acp', connectorId: 'acp', endpointId: 'claude-code' };
    await expect(hostRuntimeConnectorDisconnect(payload)).resolves.toEqual({ success: true, readiness: { ready: false, phase: 'disconnected' } });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/runtime-connectors/disconnect',
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
  });

  it('hostRuntimeEndpointsList 读取 runtime endpoint 列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { endpoints: [] },
      },
    });

    const { hostRuntimeEndpointsList } = await import('@/lib/host-api');
    await expect(hostRuntimeEndpointsList()).resolves.toEqual({ endpoints: [] });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/runtime-endpoints/list',
        method: 'GET',
      }),
    );
  });

  it('hostCapabilityDescribe 按 scope 查询 capability', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { capability: { id: 'session.prompt' } },
      },
    });

    const { hostCapabilityDescribe } = await import('@/lib/host-api');
    const scope = { kind: 'session' as const, identity: testSessionIdentity };
    await hostCapabilityDescribe({
      id: 'session.prompt',
      scope,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/describe',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.prompt',
          scope,
        }),
      }),
    );
  });

  it('hostCapabilityExecute 保持内部化且不暴露命名过渡出口', async () => {
    const source = await readFile(join(process.cwd(), 'src/lib/host-api.ts'), 'utf8');

    expect(source).toContain('async function hostCapabilityExecute');
    expect(source).not.toContain('export async function hostCapabilityExecute');
    expect(source).not.toContain('hostNamedCapabilityExecute');
  });

  it('hostSessionLoad executes the session load capability and preserves timeoutMs', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ snapshot: { sessionKey: 'agent:main:main' } }));

    const { hostSessionLoad } = await import('@/lib/host-api');
    await hostSessionLoad({
      sessionKey: 'agent:main:main',
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
            sessionKey: 'agent:main:main',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostSessionWindowFetch executes the session window capability with the caller SessionIdentity', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ snapshot: { sessionKey: 'agent:main:main' } }));

    const { hostSessionWindowFetch } = await import('@/lib/host-api');
    await hostSessionWindowFetch({
      sessionKey: 'agent:main:main',
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
            sessionKey: 'agent:main:main',
            sessionIdentity: testSessionIdentity,
            mode: 'latest',
            limit: 50,
          },
        }),
      }),
    );
  });

  it('hostSessionDelete executes the session delete capability with the caller SessionIdentity', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true }));

    const { hostSessionDelete } = await import('@/lib/host-api');
    await hostSessionDelete({
      sessionKey: 'agent:main:main',
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
            sessionKey: 'agent:main:main',
            sessionIdentity: testSessionIdentity,
          },
        }),
      }),
    );
  });

  it('hostSessionPrompt preserves the complete media SessionPromptResult', async () => {
    const media = [{
      filePath: '/workspace/report.pdf',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      preview: 'data:application/pdf;base64,cmVwb3J0',
    }];
    const item: SessionRenderUserMessageItem = {
      key: 'item-user-1',
      kind: 'user-message',
      role: 'user',
      sessionKey: 'agent:main:main',
      runId: 'run-media-1',
      text: 'Review the attached report',
      images: [],
      attachedFiles: [{
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        fileSize: 2048,
        preview: 'data:application/pdf;base64,cmVwb3J0',
        filePath: '/workspace/report.pdf',
        source: 'user-upload',
      }],
    };
    const mediaPromptResult: SessionPromptResult = {
      success: true,
      sessionKey: 'agent:main:main',
      runId: 'run-media-1',
      item,
      snapshot: {
        sessionKey: 'agent:main:main',
        catalog: {
          key: 'agent:main:main',
          agentId: 'default',
          protocolId: 'openclaw',
          runtimeEndpointId: 'openclaw:local',
          sessionIdentity: testSessionIdentity,
          kind: 'main',
          preferred: true,
        },
        items: [item],
        approvals: [],
        usage: [],
        artifacts: [],
        replayComplete: true,
        runtime: {
          activeRunId: 'run-media-1',
          runPhase: 'submitted',
          activeTurnItemKey: null,
          pendingTurnKey: 'item-user-1',
          pendingTurnLaneKey: null,
          runtimeActivity: null,
          lastUserMessageAt: 1,
          lastError: null,
          lastIssue: null,
          updatedAt: 1,
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
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope(mediaPromptResult));

    const { hostSessionPrompt } = await import('@/lib/host-api');
    const result = await hostSessionPrompt({
      sessionKey: 'agent:main:main',
      sessionIdentity: testSessionIdentity,
      message: 'Review the attached report',
      media,
    });

    expect(result).toBe(mediaPromptResult);
    expect(result).toMatchObject({
      success: true,
      sessionKey: 'agent:main:main',
      runId: 'run-media-1',
      item: {
        kind: 'user-message',
        attachedFiles: [{
          fileName: 'report.pdf',
          filePath: '/workspace/report.pdf',
          mimeType: 'application/pdf',
          fileSize: 2048,
          preview: 'data:application/pdf;base64,cmVwb3J0',
        }],
      },
      snapshot: {
        runtime: { runPhase: 'submitted', activeRunId: 'run-media-1' },
        items: [{
          kind: 'user-message',
          attachedFiles: [{
            fileName: 'report.pdf',
            filePath: '/workspace/report.pdf',
            mimeType: 'application/pdf',
            fileSize: 2048,
            preview: 'data:application/pdf;base64,cmVwb3J0',
          }],
        }],
      },
    });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          id: 'session.prompt',
          operationId: 'sessions.prompt',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'session', identity: testSessionIdentity },
          input: {
            sessionKey: 'agent:main:main',
            sessionIdentity: testSessionIdentity,
            message: 'hello',
            idempotencyKey: 'user-local-1',
            deliver: false,
          },
        }),
      }),
    );
  });

  it('hostSessionPatch executes the session model selection capability', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true, snapshot: { sessionKey: 'agent:main:main' } }));

    const { hostSessionPatch } = await import('@/lib/host-api');
    await hostSessionPatch({
      sessionKey: 'agent:main:main',
      sessionIdentity: testSessionIdentity,
      runtimeModelRef: 'anthropic:claude-sonnet-4-6',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          id: 'session.modelSelection',
          operationId: 'sessions.patchModel',
          scope: { kind: 'session', identity: testSessionIdentity },
          target: { kind: 'model-selection', identity: testSessionIdentity, runtimeModelRef: 'anthropic:claude-sonnet-4-6' },
          input: {
            sessionKey: 'agent:main:main',
            sessionIdentity: testSessionIdentity,
            runtimeModelRef: 'anthropic:claude-sonnet-4-6',
          },
        }),
      }),
    );
  });

  it('hostSessionResolveApproval executes the session approval resolve capability', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true }));

    const { hostSessionResolveApproval } = await import('@/lib/host-api');
    await hostSessionResolveApproval({
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      sessionIdentity: testSessionIdentity,
      decision: 'approved',
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
            sessionKey: 'agent:main:main',
            sessionIdentity: testSessionIdentity,
            decision: 'approved',
          },
        }),
      }),
    );
  });

  it('hostSessionApprovals executes the session approvals list capability', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ approvals: [] }));

    const { hostSessionApprovals } = await import('@/lib/host-api');
    const sessionIdentity = { ...testSessionIdentity, agentId: 'test', sessionKey: 'agent:test:main' };
    await hostSessionApprovals({ sessionIdentity });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.approval',
          operationId: 'approvals.list',
          scope: { kind: 'session', identity: sessionIdentity },
          target: { kind: 'session', identity: sessionIdentity },
          input: { sessionIdentity },
        }),
      }),
    );
  });

  it('createHostEventSource 会附带 token 且复用缓存 token', async () => {
    const eventSourceCtor = vi.fn(function EventSourceCtor(this: unknown) {});
    vi.stubGlobal('EventSource', eventSourceCtor as unknown as typeof EventSource);
    invokeIpcMock.mockResolvedValueOnce('token-123');

    const { createHostEventSource } = await import('@/lib/host-api');
    await createHostEventSource('/api/events');
    await createHostEventSource('/api/events?foo=1');

    expect(invokeIpcMock).toHaveBeenCalledTimes(1);
    expect(invokeIpcMock).toHaveBeenCalledWith('hostapi:token');
    expect(eventSourceCtor).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:13210/api/events?token=token-123',
    );
    expect(eventSourceCtor).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:13210/api/events?foo=1&token=token-123',
    );
  });
});

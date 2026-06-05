import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();

const testRuntimeAddress = {
  kind: 'native-runtime' as const,
  capabilityId: 'session.prompt',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
};

function capabilityAddress(capabilityId: string) {
  return {
    ...testRuntimeAddress,
    capabilityId,
  };
}

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

function capabilitiesEnvelope(addresses: unknown[]) {
  return proxyEnvelope({
    capabilities: addresses.map((address) => ({
      id: 'workspace.file',
      availability: 'available',
      address,
    })),
  });
}

function mockWorkspaceCapabilityExecute(json: unknown, status = 200) {
  invokeIpcMock
    .mockResolvedValueOnce(capabilitiesEnvelope([capabilityAddress('workspace.file')]))
    .mockResolvedValueOnce(proxyEnvelope(json, status));
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

  it('requires RuntimeAddress on every session host API payload', async () => {
    const source = await readFile(join(process.cwd(), 'src/lib/host-api.ts'), 'utf8');
    const sessionFunctions = [...source.matchAll(/export async function (hostSession\w+)\([\s\S]*?\n}\n/g)];
    expect(sessionFunctions.length).toBeGreaterThan(0);
    for (const match of sessionFunctions) {
      const functionSource = match[0];
      if (functionSource.includes('hostSessionPost')) {
        expect(functionSource, match[1]).toContain('runtimeAddress: RuntimeAddress');
        expect(functionSource, match[1]).not.toContain('runtimeAddress?: RuntimeAddress');
      }
    }
  });

  it('does not fall back to browser fetch when IPC channel is unavailable', async () => {
    invokeIpcMock.mockRejectedValueOnce(new Error('Invalid IPC channel: hostapi:fetch'));

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('Invalid IPC channel: hostapi:fetch');
  });

  it('hostFileStagePaths uses workspace capability execute', async () => {
    const workspaceAddress = capabilityAddress('workspace.file');
    const otherWorkspaceAddress = {
      ...workspaceAddress,
      agentId: 'other-agent',
    };
    invokeIpcMock
      .mockResolvedValueOnce(capabilitiesEnvelope([otherWorkspaceAddress, workspaceAddress]))
      .mockResolvedValueOnce({
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
      runtimeAddress: testRuntimeAddress,
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
          runtimeAddress: workspaceAddress,
          input: {
            filePaths: ['/tmp/demo.txt'],
            runtimeAddress: workspaceAddress,
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
      runtimeAddress: testRuntimeAddress,
    });

    expect(result).toEqual({ id: 'file-1', fileName: 'demo.txt', mimeType: 'text/plain', fileSize: 4, stagedPath: '/tmp/demo.txt', preview: null });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: expect.stringContaining('files.stageBuffer'),
      }),
    );
  });

  it('hostDiagnosticsCollect executes against the caller supplied runtime-host RuntimeAddress', async () => {
    invokeIpcMock.mockResolvedValueOnce(proxyEnvelope({ success: true, job: { id: 'job-1', type: 'diagnostics.collect' } }, 202));

    const { hostDiagnosticsCollect } = await import('@/lib/host-api');
    const runtimeAddress = capabilityAddress('runtime.host');
    const result = await hostDiagnosticsCollect(runtimeAddress);

    expect(result).toEqual({ success: true, job: { id: 'job-1', type: 'diagnostics.collect' } });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'runtime.host',
          operationId: 'diagnostics.collect',
          runtimeAddress,
          input: {
            runtimeAddress,
          },
        }),
      }),
    );
  });

  it('hostFileReadText uses workspace file capability execute', async () => {
    const workspaceAddress = capabilityAddress('workspace.file');
    mockWorkspaceCapabilityExecute({ ok: true, content: '# Hello' });

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({ path: '/tmp/demo.md', runtimeAddress: testRuntimeAddress });

    expect(result).toEqual({ ok: true, content: '# Hello' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readText',
          runtimeAddress: workspaceAddress,
          input: {
            path: '/tmp/demo.md',
            runtimeAddress: workspaceAddress,
          },
        }),
      }),
    );
  });

  it('hostFileReadBinary uses workspace file capability execute', async () => {
    const workspaceAddress = capabilityAddress('workspace.file');
    mockWorkspaceCapabilityExecute({ ok: true, data: 'UEsDBA==' });

    const { hostFileReadBinary } = await import('@/lib/host-api');
    const result = await hostFileReadBinary({ path: '/tmp/demo.pdf', runtimeAddress: testRuntimeAddress });

    expect(result).toEqual({ ok: true, data: 'UEsDBA==' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'workspace.file',
          operationId: 'files.readBinary',
          runtimeAddress: workspaceAddress,
          input: {
            path: '/tmp/demo.pdf',
            runtimeAddress: workspaceAddress,
          },
        }),
      }),
    );
  });

  it('hostFileListDir uses workspace file capability execute', async () => {
    const workspaceAddress = capabilityAddress('workspace.file');
    mockWorkspaceCapabilityExecute({ ok: true, entries: [{ name: 'src', path: '/tmp/workspace/src', isDir: true, size: 0, mtimeMs: 0, hasChildren: true }] });

    const { hostFileListDir } = await import('@/lib/host-api');
    const result = await hostFileListDir({ path: '/tmp/workspace', runtimeAddress: testRuntimeAddress });

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
          runtimeAddress: workspaceAddress,
          input: {
            path: '/tmp/workspace',
            runtimeAddress: workspaceAddress,
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
      const result = waitForRuntimeJobResult('job-1', { intervalMs: 50, timeoutMs: 1000 });

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
      invokeIpcMock.mockResolvedValue({
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: {
            success: true,
            job: null,
          },
        },
      });

      const { waitForRuntimeJobResult } = await import('@/lib/host-api');
      const assertion = expect(
        waitForRuntimeJobResult('missing-job', { intervalMs: 500, timeoutMs: 5000 }),
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

  it('resolveSingleCapabilityRuntimeAddress rejects missing or ambiguous capability addresses', async () => {
    invokeIpcMock
      .mockResolvedValueOnce(proxyEnvelope({ capabilities: [] }))
      .mockResolvedValueOnce(proxyEnvelope({
        capabilities: [{
          id: 'runtime.host',
          kind: 'runtime-host',
          address: capabilityAddress('runtime.host'),
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
          address: {
            ...capabilityAddress('runtime.host'),
            runtimeInstanceId: 'workspace-b',
          },
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'workspace-b',
          targetAgentIds: ['default'],
          supportLevel: 'native',
          availability: 'available',
          operations: [],
          policyScope: 'runtime.host',
        }],
      }));

    const { resolveSingleCapabilityRuntimeAddress } = await import('@/lib/host-api');

    await expect(resolveSingleCapabilityRuntimeAddress('runtime.host')).rejects.toThrow('Expected exactly one RuntimeAddress for capability: runtime.host');
    await expect(resolveSingleCapabilityRuntimeAddress('runtime.host')).rejects.toThrow('Expected exactly one RuntimeAddress for capability: runtime.host');
  });

  it('runtimeAddressForAgentCapability derives native agent addresses from explicit base RuntimeAddress', async () => {
    const { runtimeAddressForAgentCapability } = await import('@/lib/host-api');

    expect(runtimeAddressForAgentCapability({
      runtimeAddress: capabilityAddress('session.prompt'),
      capabilityId: 'session.approval',
      agentId: 'writer',
      sessionKey: 'agent:writer:subagent-draft',
    })).toEqual({
      ...capabilityAddress('session.approval'),
      agentId: 'writer',
      sessionKey: 'agent:writer:subagent-draft',
    });
    expect(invokeIpcMock).not.toHaveBeenCalled();
  });

  it('runtimeAddressForAgentCapability preserves connector runtime identity while deriving agent capability address', async () => {
    const connectorAddress = {
      kind: 'protocol-connector' as const,
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
    };

    const { runtimeAddressForAgentCapability } = await import('@/lib/host-api');

    expect(runtimeAddressForAgentCapability({
      runtimeAddress: connectorAddress,
      capabilityId: 'session.prompt',
      agentId: 'reviewer',
      sessionKey: 'acp:claude-code:reviewer:session-1',
    })).toEqual({
      ...connectorAddress,
      capabilityId: 'session.prompt',
      agentId: 'reviewer',
      sessionKey: 'acp:claude-code:reviewer:session-1',
    });
    expect(invokeIpcMock).not.toHaveBeenCalled();
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

  it('hostCapabilityDescribe 按完整 RuntimeAddress 查询 capability', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { capability: { id: 'session.prompt' } },
      },
    });

    const { hostCapabilityDescribe } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostCapabilityDescribe({
      id: 'session.prompt',
      runtimeAddress,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/describe',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.prompt',
          runtimeAddress,
        }),
      }),
    );
  });

  it('hostCapabilityExecute 按完整 RuntimeAddress 执行 capability operation', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true },
      },
    });

    const { hostCapabilityExecute } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostCapabilityExecute({
      id: 'session.prompt',
      operationId: 'sessions.prompt',
      runtimeAddress,
      input: { sessionKey: 'agent:main:main', message: 'hello' },
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/capabilities/execute',
        method: 'POST',
        body: JSON.stringify({
          id: 'session.prompt',
          operationId: 'sessions.prompt',
          runtimeAddress,
          input: { sessionKey: 'agent:main:main', message: 'hello' },
        }),
      }),
    );
  });

  it('hostSessionLoad posts to the session load route and preserves timeoutMs', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { snapshot: { sessionKey: 'agent:main:main' } },
      },
    });

    const { hostSessionLoad } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostSessionLoad({
      sessionKey: 'agent:main:main',
      runtimeAddress,
    }, { timeoutMs: 35000 });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/load',
        method: 'POST',
        timeoutMs: 35000,
        body: JSON.stringify({
          sessionKey: 'agent:main:main',
          runtimeAddress,
        }),
      }),
    );
  });

  it('hostSessionWindowFetch posts to the session window route with the caller RuntimeAddress', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { snapshot: { sessionKey: 'agent:main:main' } },
      },
    });

    const { hostSessionWindowFetch } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostSessionWindowFetch({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      mode: 'latest',
      limit: 50,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/window',
        method: 'POST',
        body: JSON.stringify({
          sessionKey: 'agent:main:main',
          runtimeAddress,
          mode: 'latest',
          limit: 50,
        }),
      }),
    );
  });

  it('hostSessionDelete posts to the session delete route with the caller RuntimeAddress', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true },
      },
    });

    const { hostSessionDelete } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostSessionDelete({
      sessionKey: 'agent:main:main',
      runtimeAddress,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/delete',
        method: 'POST',
        body: JSON.stringify({
          sessionKey: 'agent:main:main',
          runtimeAddress,
        }),
      }),
    );
  });

  it('hostSessionPrompt posts to the session prompt route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true, snapshot: { sessionKey: 'agent:main:main' } },
      },
    });

    const { hostSessionPrompt } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostSessionPrompt({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      message: 'hello',
      idempotencyKey: 'user-local-1',
      deliver: false,
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/prompt',
        method: 'POST',
        timeoutMs: 10000,
        body: JSON.stringify({
          sessionKey: 'agent:main:main',
          runtimeAddress,
          message: 'hello',
          idempotencyKey: 'user-local-1',
          deliver: false,
        }),
      }),
    );
  });

  it('hostSessionPatch posts to the session patch route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true, snapshot: { sessionKey: 'agent:main:main' } },
      },
    });

    const { hostSessionPatch } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostSessionPatch({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      runtimeModelRef: 'anthropic:claude-sonnet-4-6',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/patch',
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          sessionKey: 'agent:main:main',
          runtimeAddress,
          runtimeModelRef: 'anthropic:claude-sonnet-4-6',
        }),
      }),
    );
  });

  it('hostSessionResolveApproval posts to the session approval route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true },
      },
    });

    const { hostSessionResolveApproval } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
    await hostSessionResolveApproval({
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      runtimeAddress,
      decision: 'approved',
    });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/approval/resolve',
        method: 'POST',
        body: JSON.stringify({
          id: 'approval-1',
          sessionKey: 'agent:main:main',
          runtimeAddress,
          decision: 'approved',
        }),
      }),
    );
  });

  it('hostSessionApprovals posts to the session approvals route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { approvals: [] },
      },
    });

    const { hostSessionApprovals } = await import('@/lib/host-api');
    const { createOpenClawTestRuntimeAddress } = await import('./helpers/runtime-address-fixtures');
    const runtimeAddress = createOpenClawTestRuntimeAddress('agent:test:main', 'test');
    await hostSessionApprovals({ runtimeAddress });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/sessions/approvals',
        method: 'POST',
        body: JSON.stringify({ runtimeAddress }),
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

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handleAgentsRoutes } from '../../electron/api/routes/agents';

function incoming(body: unknown, method = 'POST') {
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

describe('agents host API route', () => {
  it('forwards the fixed configuration display DTO and safe projection', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        success: true,
        defaults: { model: null, skills: [] },
        agents: [{ id: 'writer', description: 'Writes copy', model: null, skills: [] }],
      },
    });
    const result = response();
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.displayConfig.get',
      scope: {
        kind: 'agent',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'main',
      },
      target: { kind: 'agent', agentId: 'main' },
      input: {
        kind: 'displayConfiguration',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      },
    };

    await expect(handleAgentsRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/agents'),
      { execute },
    )).resolves.toBe(true);

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        defaults: { model: null, skills: [] },
        agents: [{ id: 'writer', description: 'Writes copy', model: null, skills: [] }],
      },
    });
    expect(JSON.stringify(result.state)).not.toContain('workspace');
  });

  it('forwards the fixed draft wait receipt without native diagnostics', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, status: 'timeout', startedAt: 1, endedAt: null },
    });
    const result = response();
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.draft.wait',
      scope: { kind: 'agent', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: {
        kind: 'draftWait',
        endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'writer',
        runId: 'run-123',
        waitSliceMs: 30_000,
        rpcTimeoutBufferMs: 10_000,
      },
    };

    await handleAgentsRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/agents'),
      { execute },
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, status: 'timeout', startedAt: 1, endedAt: null },
    });
    expect(JSON.stringify(result.state)).not.toContain('error');
  });

  it('preserves the unknown mutation outcome without retrying', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 409,
      body: { success: false, error: 'Subagent mutation outcome is unknown' },
    });
    const result = response();

    await handleAgentsRoutes(
      incoming({ operation: 'mutation' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/agents'),
      { execute },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.state).toEqual({
      statusCode: 409,
      body: { success: false, error: 'Subagent mutation outcome is unknown' },
    });
  });

  it('hides sealed package export package path from public response', async () => {
    const receipt = { callId: 'a'.repeat(32), accepted: true };
    const execute = vi.fn().mockResolvedValue({ status: 202, body: receipt });
    const result = response();
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.package.export',
      scope: { kind: 'agent', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main' },
      target: { kind: 'subagent', subagentId: 'writer' },
      input: { kind: 'packageExport', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'writer' },
    };

    await handleAgentsRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/agents'),
      { execute },
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 202, body: receipt });
    const completed = {
      callId: receipt.callId, operationId: request.operationId, status: 200,
      body: { success: true, package: { agentId: 'writer', fileName: 'writer.matcha-agentpkg', size: 1, exportedAtMs: 2 } },
    };
    const readResult = vi.fn().mockResolvedValue({ status: 200, body: completed });
    const resultRequest = { callId: receipt.callId, operationId: request.operationId, endpoint: request.input.endpoint, agentId: 'writer' };
    await handleAgentsRoutes(
      incoming(resultRequest) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/results'),
      { execute, result: readResult } as never,
    );
    expect(readResult).toHaveBeenCalledWith(resultRequest);
    expect(result.state).toEqual({ statusCode: 200, body: completed });
    expect(JSON.stringify(result.state.body)).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
  });

  it('hides sealed package install private fields from public response', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        success: true,
        package: { agentId: 'writer', authorizationKey: 'authorization-key', deviceEnvelope: 'device-envelope', contentKey: 'content-key', rawPayload: 'raw', token: 'token' },
      },
    });
    const result = response();
    const request = {
      id: 'subagent.management',
      operationId: 'subagents.package.install',
      scope: { kind: 'agent', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, agentId: 'main' },
      target: { kind: 'subagent' },
      input: { kind: 'packageInstall', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }, packagePath: 'C:/sealed/writer.matcha-agentpkg' },
    };

    await handleAgentsRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/agents'),
      { execute },
    );

    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, package: { agentId: 'writer' } },
    });
  });

  it('redacts route-local failures as unavailable', async () => {
    const result = response();

    await handleAgentsRoutes(
      incoming({ operation: 'mutation' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/subagents/agents'),
      { execute: vi.fn().mockRejectedValue(new Error('private loopback detail')) },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Subagent management is unavailable' },
    });
  });
});

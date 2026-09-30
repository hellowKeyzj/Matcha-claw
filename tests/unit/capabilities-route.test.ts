import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

function incoming(body?: unknown, method = 'POST', headers: Record<string, string> = {}) {
  return Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
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

const providerRequest = {
  id: 'provider.routing',
  operationId: 'providerRouting.list',
  scope: { kind: 'provider-routing' },
  target: { kind: 'provider-routing' },
  input: { kind: 'list' },
};

const identity = {
  endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  agentId: 'main',
  sessionKey: 'session-1',
};

const taskRequest = {
  id: 'task.management',
  operationId: 'tasks.list',
  scope: { kind: 'session', identity },
  target: { kind: 'task-manager', identity },
  input: { sessionIdentity: identity },
};

const schedulerScope = {
  kind: 'runtime-instance',
  endpoint: identity.endpoint,
} as const;

const teamRuntimeRequest = {
  id: 'team.runtime',
  operationId: 'team.runList',
  scope: schedulerScope,
  target: { kind: 'team', teamId: 'team-1' },
  input: { teamId: 'team-1' },
} as const;

const workspaceMediaRequest = {
  id: 'workspace.media',
  operationId: 'media.thumbnail',
  scope: { kind: 'session', endpoint: identity.endpoint, sessionKey: identity.sessionKey },
  target: { kind: 'workspace-media' },
  input: {
    endpoint: identity.endpoint,
    sessionKey: identity.sessionKey,
    relativePath: 'images/asset.png',
    mimeType: 'image/png',
  },
} as const;

const cronTriggerRequest = {
  id: 'scheduler.cron',
  operationId: 'cron.trigger',
  scope: schedulerScope,
  target: { kind: 'cron-job', jobId: 'cron-job-1' },
  input: { id: 'cron-job-1' },
} as const;

const schedulerDescriptor = {
  id: 'scheduler.cron',
  kind: 'scheduler-cron',
  scopeKind: 'runtime-instance',
  scope: schedulerScope,
  targetKinds: ['cron-job'],
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'cron.create', title: 'Create cron job', targetKind: 'cron-job', targetRequired: true },
    { id: 'cron.update', title: 'Update cron job', targetKind: 'cron-job', targetRequired: true },
    { id: 'cron.delete', title: 'Delete cron job', targetKind: 'cron-job', targetRequired: true },
    { id: 'cron.toggle', title: 'Toggle cron job', targetKind: 'cron-job', targetRequired: true },
    { id: 'cron.trigger', title: 'Trigger cron job', targetKind: 'cron-job', targetRequired: true },
  ],
  policyScope: 'scheduler.cron',
  ownerModuleId: 'scheduler',
  routeOwnerId: 'operations',
} as const;

const providerRoutingDescriptor = {
  id: 'provider.routing',
  kind: 'provider-routing',
  scopeKind: 'provider-routing',
  scope: { kind: 'provider-routing' },
  targetKinds: ['provider-routing'],
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'providerRouting.list', title: 'List provider routing', targetKind: 'provider-routing', targetRequired: true },
    { id: 'providerRouting.replace', title: 'Replace provider routing', targetKind: 'provider-routing', targetRequired: true },
  ],
  policyScope: 'provider.routing',
  ownerModuleId: 'environment',
  routeOwnerId: 'provider-routing',
} as const;

const subagentScope = {
  kind: 'agent',
  endpoint: identity.endpoint,
  agentId: 'main',
} as const;

const subagentDescriptor = {
  id: 'subagent.management',
  kind: 'subagent-management',
  scopeKind: 'agent',
  scope: subagentScope,
  targetKinds: ['subagent'],
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  targetAgentIds: ['main'],
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'subagents.list', title: 'List subagents', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.create', title: 'Create subagent', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.update', title: 'Update subagent', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.delete', title: 'Delete subagent', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.files.get', title: 'Get subagent file', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.files.set', title: 'Set subagent file', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.files.list', title: 'List subagent files', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.displayConfig.get', title: 'Get subagent display configuration', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.description.set', title: 'Set subagent description', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.model.set', title: 'Set subagent model', targetKind: 'subagent', targetRequired: true },
    { id: 'subagents.skills.set', title: 'Set subagent skills', targetKind: 'subagent', targetRequired: true },
  ],
  policyScope: 'subagent.management',
  ownerModuleId: 'agent',
  routeOwnerId: 'openclaw',
} as const;

const agentSkillConfigDescriptor = {
  id: 'subagent.skills',
  kind: 'subagent-skills',
  scopeKind: 'agent',
  scope: subagentScope,
  targetKinds: ['subagent'],
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  targetAgentIds: ['main'],
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'subagentSkills.get', title: 'Get subagent skills', targetKind: 'subagent', targetRequired: true },
    { id: 'subagentSkills.set', title: 'Set subagent skills', targetKind: 'subagent', targetRequired: true },
  ],
  policyScope: 'subagent.skills',
  ownerModuleId: 'agent',
  routeOwnerId: 'openclaw',
} as const;

const agentToolConfigDescriptor = {
  id: 'subagent.tools',
  kind: 'subagent-tools',
  scopeKind: 'agent',
  scope: subagentScope,
  targetKinds: ['subagent'],
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  targetAgentIds: ['main'],
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'subagentTools.get', title: 'Get subagent tools', targetKind: 'subagent', targetRequired: true },
    { id: 'subagentTools.set', title: 'Set subagent tools', targetKind: 'subagent', targetRequired: true },
  ],
  policyScope: 'subagent.tools',
  ownerModuleId: 'agent',
  routeOwnerId: 'openclaw',
} as const;

function malformedIncoming(raw: string) {
  return Object.assign(Readable.from([raw]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

describe('capability route sealed projection', () => {
  it('rejects malformed Team runtime requests before dispatch', async () => {
    const execute = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({ ...teamRuntimeRequest, input: { teamId: '' } }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Team runtime request is invalid' },
    });
  });

  it('dispatches Team runtime requests and preserves succeeded results', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { success: true, teamId: 'team-1' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(teamRuntimeRequest, undefined);
    expect(result.state).toEqual({ statusCode: 200, body: { success: true, teamId: 'team-1' } });
  });

  it('accepts the public graphSummary Team graph context view', async () => {
    const request = {
      id: 'team.runtime',
      operationId: 'team.graphContext',
      scope: schedulerScope,
      target: { kind: 'team-run', teamId: 'team-1', runId: 'run-1' },
      input: { teamId: 'team-1', runId: 'run-1', view: 'graphSummary' },
    } as const;
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { success: true } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(request, undefined);
    expect(result.state).toEqual({ statusCode: 200, body: { success: true } });
  });

  it('forwards Team runtime trace id only as private transport metadata', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { success: true, teamId: 'team-1' } });
    const result = response();
    const traceId = 'session-trace:team-runtime:team.runList:trace-1';

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest, 'POST', { 'x-matchaclaw-session-trace': traceId }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(teamRuntimeRequest, traceId);
    expect(result.state).toEqual({ statusCode: 200, body: { success: true, teamId: 'team-1' } });
  });

  it('dispatches workspace media through the Rust transport', async () => {
    const workspaceMediaTransport = {
      execute: vi.fn().mockResolvedValue({ status: 200, body: { preview: null, fileSize: 12 } }),
    };
    const result = response();

    await handleCapabilityRoutes(
      incoming(workspaceMediaRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { workspaceMediaTransport } } as never,
    );

    expect(workspaceMediaTransport.execute).toHaveBeenCalledWith(workspaceMediaRequest);
    expect(result.state).toEqual({ statusCode: 200, body: { preview: null, fileSize: 12 } });
  });

  it('redacts workspace media transport failures', async () => {
    const workspaceMediaTransport = {
      execute: vi.fn().mockRejectedValue(new Error('C:/private/workspace/asset.png')),
    };
    const result = response();

    await handleCapabilityRoutes(
      incoming(workspaceMediaRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { workspaceMediaTransport } } as never,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { success: false, error: 'Workspace media is unavailable' } });
    expect(JSON.stringify(result.state)).not.toContain('C:/private');
  });

  it('rejects unknown Team runtime results without faking success', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
  });

  it('does not project Team resume outcome unknown as success', async () => {
    const request = {
      id: 'team.runtime',
      operationId: 'team.resume',
      scope: schedulerScope,
      target: { kind: 'team', teamId: 'team-1' },
      input: { teamId: 'team-1', idempotencyKey: 'resume:team-1' },
    } as const;
    const execute = vi.fn().mockResolvedValue({ status: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
  });

  it('projects Team runtime transport failures as unavailable', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('private transport failure'));
    const result = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { teamRuntimeTransport: { execute } } } as never,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
  });

  it('does not expose UV preparation through generic capability execute', async () => {
    const command = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({
        id: 'platform.runtime',
        operationId: 'toolchain.installUv',
        scope: schedulerScope,
        target: { kind: 'platform-runtime' },
        input: {},
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('fails closed for legacy runtime.host execution without dispatching host.runtime.execute', async () => {
    const command = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({
        id: 'runtime.host',
        operationId: 'runtimeHost.gatewayReady',
        scope: schedulerScope,
        target: { kind: 'gateway-control' },
        input: {},
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('does not publish a partial capability directory or descriptor', async () => {
    const list = response();
    const describeResult = response();

    await handleCapabilityRoutes(
      incoming(undefined, 'GET') as never,
      list.raw as never,
      new URL('http://localhost/api/capabilities/list'),
      {} as never,
    );
    await handleCapabilityRoutes(
      incoming({ id: 'provider.routing', scope: { kind: 'provider-routing' } }) as never,
      describeResult.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      {} as never,
    );

    expect(list.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
    expect(describeResult.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('projects Cron trigger outcomes through the cron transport', async () => {
    const trigger = vi.fn().mockResolvedValue({ status: 200, body: { success: true, result: { outcome: 'accepted' } } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(cronTriggerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { cronTransport: { trigger } } } as never,
    );

    expect(trigger).toHaveBeenCalledWith(cronTriggerRequest);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, result: { outcome: 'accepted' } },
    });
  });

  it.each(['accepted', 'skipped'] as const)(
    'preserves safe Cron outcome %s', async (outcome) => {
      const result = response();
      await handleCapabilityRoutes(
        incoming(cronTriggerRequest) as never,
        result.raw as never,
        new URL('http://localhost/api/capabilities/execute'),
        { runtimeHostTransports: { cronTransport: { trigger: vi.fn().mockResolvedValue({ status: 200, body: { success: true, result: { outcome } } }) } } } as never,
      );
      expect(result.state).toEqual({ statusCode: 200, body: { success: true, result: { outcome } } });
    },
  );

  it.each(['already-running', 'not-due', 'invalid-spec', 'disabled', 'stopped'] as const)(
    'preserves safe Cron skip reason %s', async (reason) => {
      const result = response();
      await handleCapabilityRoutes(
        incoming(cronTriggerRequest) as never,
        result.raw as never,
        new URL('http://localhost/api/capabilities/execute'),
        { runtimeHostTransports: { cronTransport: { trigger: vi.fn().mockResolvedValue({ status: 200, body: { success: true, result: { outcome: 'skipped', reason } } }) } } } as never,
      );
      expect(result.state).toEqual({ statusCode: 200, body: { success: true, result: { outcome: 'skipped', reason } } });
    },
  );

  it('projects Cron transport outcome-unknown as a safe trigger result', async () => {
    const result = response();

    await handleCapabilityRoutes(
      incoming(cronTriggerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { cronTransport: { trigger: vi.fn().mockResolvedValue({ status: 409, body: { success: false, error: 'Cron operation outcome is unknown' } }) } } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, result: { outcome: 'outcome-unknown' } },
    });
  });

  it.each([
    { ...cronTriggerRequest, target: { kind: 'cron-job', jobId: 'other-job' } },
    { ...cronTriggerRequest, input: { id: 'other-job' } },
    { ...cronTriggerRequest, input: { id: cronTriggerRequest.input.id, extra: true } },
    { ...cronTriggerRequest, scope: { ...schedulerScope, endpoint: { ...schedulerScope.endpoint, runtimeInstanceId: 'other' } } },
  ])('rejects malformed Cron trigger envelopes before dispatch: %p', async (body) => {
    const trigger = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { cronTransport: { trigger } } } as never,
    );

    expect(trigger).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Cron trigger request is invalid' },
    });
  });

  it.each([
    { status: 503, body: { success: false, error: 'private native detail' } },
    { status: 502, body: { success: false, error: 'private native detail' } },
    { status: 200, body: { success: false, error: 'private native detail' } },
  ])('hides unavailable Cron transport outcomes: %p', async (transportResponse) => {
    const result = response();

    await handleCapabilityRoutes(
      incoming(cronTriggerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { cronTransport: { trigger: vi.fn().mockResolvedValue(transportResponse) } } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private native detail');
  });

  it('delivers the full capability directory from the typed list transport', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        capabilities: [agentSkillConfigDescriptor, agentToolConfigDescriptor, subagentDescriptor, providerRoutingDescriptor, schedulerDescriptor],
      },
    });
    const result = response();

    await handleCapabilityRoutes(
      incoming(undefined, 'GET') as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/list'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { list } } } as never,
    );

    expect(list).toHaveBeenCalledWith();
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        capabilities: [agentSkillConfigDescriptor, agentToolConfigDescriptor, subagentDescriptor, providerRoutingDescriptor, schedulerDescriptor],
      },
    });
  });

  it('does not describe a deleted Electron-owned License capability', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 404, body: { success: false, error: 'Capability is not available' } });
    const result = response();
    const body = { id: 'license.runtime', scope: { kind: 'app' } };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('delivers a capability description with the exact typed request', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 200, body: { capability: schedulerDescriptor } });
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({ statusCode: 200, body: { capability: schedulerDescriptor } });
  });

  it('delivers the complete subagent descriptor without rebuilding it in Main', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 200, body: { capability: subagentDescriptor } });
    const result = response();
    const body = { id: subagentDescriptor.id, scope: subagentScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({ statusCode: 200, body: { capability: subagentDescriptor } });
  });

  it.each([
    ['returned id drift', { ...schedulerDescriptor, id: 'other.capability' }],
    ['returned scope drift', {
      ...schedulerDescriptor,
      scope: {
        ...schedulerScope,
        endpoint: { ...schedulerScope.endpoint, runtimeInstanceId: 'other' },
      },
    }],
  ])('fails closed when %s is returned', async (_caseName, capability) => {
    const describe = vi.fn().mockResolvedValue({ status: 503, body: { success: false, error: 'Capability directory is unavailable' } });
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).toHaveBeenCalledWith(body);
    expect(JSON.stringify(result.state)).not.toContain(String(capability.id));
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('forwards sealed descriptor validation failures from the directory transport', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 503, body: { success: false, error: 'Capability directory is unavailable' } });
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('maps a valid request with an unavailable scope to the generic not-available response', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 404, body: { success: false, error: 'Capability is not available' } });
    const result = response();
    const body = {
      id: schedulerDescriptor.id,
      scope: { ...schedulerScope, endpoint: { ...schedulerScope.endpoint, runtimeInstanceId: 'other' } },
    };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('fails closed for directory transport exceptions', async () => {
    const list = vi.fn().mockRejectedValue(new Error('private native error'));
    const result = response();

    await handleCapabilityRoutes(
      incoming(undefined, 'GET') as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/list'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { list } } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('maps invalid capability transport response to a generic not-available response', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 404, body: { success: false, error: 'Capability is not available' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming({ id: 'unknown.capability', scope: schedulerScope }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('maps unavailable describe transport responses to a generic response', async () => {
    const describe = vi.fn().mockResolvedValue({ status: 503, body: { success: false, error: 'Capability directory is unavailable' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming({ id: schedulerDescriptor.id, scope: schedulerScope }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('fails closed for describe transport exceptions', async () => {
    const describe = vi.fn().mockRejectedValue(new Error('private native error'));
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it.each([
    {},
    { id: '', scope: schedulerScope },
    { id: 'scheduler.cron\0private', scope: schedulerScope },
    { id: schedulerDescriptor.id, scope: { ...schedulerScope, private: true } },
  ])('rejects malformed describe requests before dispatch: %p', async (body) => {
    const describe = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('maps malformed describe JSON to the request-failed response', async () => {
    const describe = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      malformedIncoming('{not-json') as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHostTransports: { capabilityDirectoryTransport: { describe } } } as never,
    );

    expect(describe).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
  });

  it('fails closed when the public prompt lacks a source-backed run id', async () => {
    const send = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({
        id: 'session.prompt',
        operationId: 'sessions.prompt',
        scope: { kind: 'session', identity },
        target: { kind: 'session', identity },
        input: {
          sessionIdentity: identity,
          sessionKey: identity.sessionKey,
          message: 'hello',
        },
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionSendTransport: { send } } } as never,
    );

    expect(send).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
  });

  it('parses execute input once before named capability dispatch', async () => {
    const nextBody = vi.fn(async function* () {
      yield JSON.stringify(providerRequest);
    });
    const result = response();
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { routing: null } });

    await handleCapabilityRoutes(
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        [Symbol.asyncIterator]: nextBody,
      } as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { providerRoutingTransport: { execute } } } as never,
    );

    expect(nextBody).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(providerRequest);
    expect(result.state).toEqual({ statusCode: 200, body: { routing: null } });
  });

  it('maps public load and window operations to exact lower timeline DTOs', async () => {
    const load = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'incomplete' } });
    const window = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'incomplete' } });
    const loadResult = response();
    const windowResult = response();
    const loadBody = {
      id: 'session.prompt',
      operationId: 'sessions.load',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: identity,
        endpointSessionId: 'native-handle',
        limit: 25,
      },
    };
    const windowBody = {
      id: 'session.management',
      operationId: 'sessions.window',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: identity,
        mode: 'older',
        limit: 10,
        offset: 5,
        includeCanonical: false,
      },
    };

    await handleCapabilityRoutes(
      incoming(loadBody) as never,
      loadResult.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionTimelineTransport: { load, window } } } as never,
    );
    await handleCapabilityRoutes(
      incoming(windowBody) as never,
      windowResult.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { sessionTimelineTransport: { load, window } } } as never,
    );

    expect(load).toHaveBeenCalledWith({
      id: 'session.management',
      operationId: 'sessions.load',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: identity,
        endpointSessionId: 'native-handle',
        limit: 25,
      },
    }, null);
    expect(window).toHaveBeenCalledWith({
      id: 'session.management',
      operationId: 'sessions.window',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        sessionKey: identity.sessionKey,
        sessionIdentity: identity,
        mode: 'older',
        limit: 10,
        offset: 5,
        includeCanonical: false,
      },
    }, null);
    expect(loadResult.state).toEqual({ statusCode: 200, body: { outcome: 'incomplete' } });
    expect(windowResult.state).toEqual({ statusCode: 200, body: { outcome: 'incomplete' } });
  });

  it('redacts unknown provider and task transport responses', async () => {
    const provider = response();
    const task = response();
    const privateCanary = 'Authorization: Bearer private-token /private/native/path';

    await handleCapabilityRoutes(
      incoming(providerRequest) as never,
      provider.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { providerRoutingTransport: { execute: vi.fn().mockResolvedValue({ status: 200, body: { privateCanary } }) } } } as never,
    );
    await handleCapabilityRoutes(
      incoming(taskRequest) as never,
      task.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { taskManagerTransport: { list: vi.fn().mockResolvedValue({ status: 200, body: { privateCanary } }) } } } as never,
    );

    expect(provider.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Provider routing is unavailable' },
    });
    expect(task.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Task manager is unavailable' },
    });
    expect(JSON.stringify([provider.state, task.state])).not.toContain(privateCanary);
  });

  it('forwards OpenClaw browser request envelope fields to the gateway transport', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { ok: true, count: 2 } });
    const result = response();
    const request = {
      id: 'openclaw.browser',
      operationId: 'browser.request',
      scope: schedulerScope,
      target: null,
      input: {
        method: 'GET',
        path: '/browser/request',
        query: { tabId: 'tab-1', includeHidden: false },
        body: { action: 'status' },
        timeoutMs: 2500,
        target: 'node',
        node: 'browser-node-1',
      },
    } as const;

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { openClawGatewayTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 200, body: { ok: true, count: 2 } });
  });

  it('forwards OpenClaw MCP app requests without writing SessionView', async () => {
    const payload = { lease: { viewId: 'view-1', expiresAtMs: 1 }, url: 'https://mcp.local/view' };
    const execute = vi.fn().mockResolvedValue({ status: 200, body: payload });
    const result = response();
    const request = {
      id: 'openclaw.mcpApp',
      operationId: 'mcp.app.lease',
      scope: schedulerScope,
      target: null,
      input: { sessionKey: 'session-1', viewId: 'view-1', standalone: true },
    } as const;

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { openClawGatewayTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 200, body: payload });
  });

  it.each([
    [{ id: 'openclaw.browser', operationId: 'browser.open', scope: schedulerScope, target: null, input: { method: 'GET', path: '/browser/request' } }, 'OpenClaw browser request is invalid'],
    [{ id: 'openclaw.browser', operationId: 'browser.request', scope: schedulerScope, target: null, input: { method: 'GET', path: '/browser/request', html: '<secret>' } }, 'OpenClaw browser request is invalid'],
    [{ id: 'openclaw.browser', operationId: 'browser.request', scope: schedulerScope, target: null, input: { method: 'GET', path: '/browser/request', query: 'secret' } }, 'OpenClaw browser request is invalid'],
    [{ id: 'openclaw.browser', operationId: 'browser.request', scope: schedulerScope, target: null, input: { method: 'GET', path: '/browser/request', target: 'secret' } }, 'OpenClaw browser request is invalid'],
    [{ id: 'openclaw.browser', operationId: 'browser.request', scope: schedulerScope, target: null, input: { method: 'GET', path: '/browser/request', target: 'host', node: 'secret' } }, 'OpenClaw browser request is invalid'],
    [{ id: 'openclaw.mcpApp', operationId: 'mcp.lease', scope: schedulerScope, target: null, input: { sessionKey: 'session-1', viewId: 'view-1' } }, 'OpenClaw MCP app request is invalid'],
    [{ id: 'openclaw.mcpApp', operationId: 'mcp.app.lease', scope: schedulerScope, target: null, input: { sessionKey: 'session-1', viewId: 'view-1', toolResult: 'secret' } }, 'OpenClaw MCP app request is invalid'],
  ])('rejects malformed OpenClaw browser/MCP envelopes before dispatch: %p', async (request, error) => {
    const execute = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { openClawGatewayTransport: { execute } } } as never,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 400, body: { success: false, error } });
    expect(JSON.stringify(result.state)).not.toContain('secret');
  });

  it('redacts OpenClaw browser and MCP transport errors', async () => {
    const browser = response();
    const mcp = response();
    const privateCanary = 'raw private payload: html/toolInput/toolResult';
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 503, body: { success: false, error: privateCanary } })
      .mockRejectedValueOnce(new Error(privateCanary));

    await handleCapabilityRoutes(
      incoming({
        id: 'openclaw.browser',
        operationId: 'browser.request',
        scope: schedulerScope,
        target: null,
        input: { method: 'GET', path: '/browser/request' },
      }) as never,
      browser.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { openClawGatewayTransport: { execute } } } as never,
    );
    await handleCapabilityRoutes(
      incoming({
        id: 'openclaw.mcpApp',
        operationId: 'mcp.app.lease',
        scope: schedulerScope,
        target: null,
        input: { sessionKey: 'session-1', viewId: 'view-1' },
      }) as never,
      mcp.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { openClawGatewayTransport: { execute } } } as never,
    );

    expect(browser.state).toEqual({ statusCode: 503, body: { success: false, error: 'OpenClaw browser request is unavailable' } });
    expect(mcp.state).toEqual({ statusCode: 503, body: { success: false, error: 'OpenClaw MCP app request is unavailable' } });
    expect(JSON.stringify([browser.state, mcp.state])).not.toContain(privateCanary);
  });

  it('does not execute a deleted License capability', async () => {
    const result = response();
    const command = vi.fn();
    const key = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';

    await handleCapabilityRoutes(
      incoming({
        id: 'license.runtime',
        operationId: 'license.validate',
        scope: { kind: 'app' },
        target: { kind: 'license', subject: 'key' },
        input: { key },
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
    expect(JSON.stringify(result.state)).not.toContain(key);
  });

  it('requires matching task session identities before dispatch', async () => {
    const list = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({
        ...taskRequest,
        input: {
          sessionIdentity: { ...identity, sessionKey: 'other-session' },
        },
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { taskManagerTransport: { list } } } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Task manager request is invalid' },
    });
  });

  it('dispatches skill openReadme with raw key and locator fields', async () => {
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        success: true,
        content: '# Excel XLSX',
        filePath: 'C:\\skills\\Excel XLSX\\SKILL.md',
      },
    });
    const result = response();
    const request = {
      id: 'skill.management',
      operationId: 'clawhub.openReadme',
      scope: schedulerScope,
      target: { kind: 'skill', skillId: 'Excel XLSX', slug: 'excel-xlsx' },
      input: {
        skillKey: 'Excel XLSX',
        slug: 'excel-xlsx',
        filePath: 'C:\\skills\\Excel XLSX\\SKILL.md',
        baseDir: 'C:\\skills\\Excel XLSX',
      },
    } as const;

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { skillsManagementTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, content: '# Excel XLSX', filePath: 'C:\\skills\\Excel XLSX\\SKILL.md' },
    });
  });

  it('dispatches skill operations when the marketplace slug is absent', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { success: true } });
    const result = response();
    const request = {
      id: 'skill.management',
      operationId: 'clawhub.openPath',
      scope: schedulerScope,
      target: { kind: 'skill', skillId: 'vendor/foo' },
      input: { skillKey: 'vendor/foo' },
    } as const;

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { skillsManagementTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 200, body: { success: true } });
  });

  it('dispatches plugin.runtime setEnabled through pluginsTransport configuration', async () => {
    const command = vi.fn();
    const configuration = vi.fn().mockResolvedValue({ outcome: 'configured' });
    const result = response();
    const request = {
      id: 'plugin.runtime',
      operationId: 'plugins.setEnabled',
      scope: schedulerScope,
      target: { kind: 'plugin', pluginId: 'openclaw-browser' },
      input: { enabled: true, pluginIds: ['openclaw-browser'] },
    } as const;

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command }, runtimeHostTransports: { pluginsTransport: { configuration } } } as never,
    );

    expect(configuration).toHaveBeenCalledWith({
      runtime: 'openclaw',
      pluginId: 'openclaw-browser',
      enabled: true,
    });
    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'configured' } });
  });

  it('rejects malformed plugin.runtime setEnabled before dispatch', async () => {
    const command = vi.fn();
    const configuration = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({
        id: 'plugin.runtime',
        operationId: 'plugins.setEnabled',
        scope: schedulerScope,
        target: { kind: 'plugin', pluginId: 'openclaw-browser' },
        input: { enabled: true, pluginIds: ['other-plugin'] },
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command }, runtimeHostTransports: { pluginsTransport: { configuration } } } as never,
    );

    expect(configuration).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 400, body: { outcome: 'rejected' } });
  });

  it('projects skill openPath as success only after RuntimeHost resolution', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { success: true } });
    const result = response();
    const request = {
      id: 'skill.management',
      operationId: 'clawhub.openPath',
      scope: schedulerScope,
      target: { kind: 'skill', skillId: 'Excel XLSX', slug: 'excel-xlsx' },
      input: {
        skillKey: 'Excel XLSX',
        slug: 'excel-xlsx',
        filePath: 'C:\\skills\\Excel XLSX\\SKILL.md',
        baseDir: 'C:\\skills\\Excel XLSX',
      },
    } as const;

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHostTransports: { skillsManagementTransport: { execute } } } as never,
    );

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 200, body: { success: true } });
  });
});

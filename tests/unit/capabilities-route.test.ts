import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';
import { RuntimeHostControlError } from '../../electron/main/runtime-host-delivery/control';

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

const toolchainScope = {
  kind: 'runtime-instance',
  endpoint: identity.endpoint,
} as const;

const toolchainInstallRequest = {
  id: 'platform.runtime',
  operationId: 'toolchain.installUv',
  scope: toolchainScope,
  target: { kind: 'platform-runtime' },
  input: {},
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

const licenseDescriptor = {
  id: 'license.runtime',
  kind: 'license-runtime',
  scopeKind: 'app',
  scope: { kind: 'app' },
  targetKinds: ['license'],
  supportLevel: 'native',
  availability: 'available',
  operations: [
    { id: 'license.validate', title: 'Validate license', targetKind: 'license', targetRequired: true },
    { id: 'license.revalidate', title: 'Revalidate stored license', targetKind: 'license', targetRequired: true },
    { id: 'license.clear', title: 'Clear stored license', targetKind: 'license', targetRequired: true },
  ],
  policyScope: 'license.runtime',
  ownerModuleId: 'license',
  routeOwnerId: 'license',
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
    { id: 'subagents.draft.wait', title: 'Wait for subagent draft', targetKind: 'subagent', targetRequired: true },
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

function succeeded(result: unknown) {
  return { kind: 'succeeded' as const, result };
}

function rejected(code: 'INVALID_INPUT' | 'UNAVAILABLE' | 'CAPACITY_EXHAUSTED' | 'FAILED', message = 'private capability failure') {
  return { kind: 'rejected' as const, error: { code, message } };
}

function malformedIncoming(raw: string) {
  return Object.assign(Readable.from([raw]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
}

describe('capability route sealed projection', () => {
  it('rejects malformed Team runtime requests before dispatch', async () => {
    const command = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming({ ...teamRuntimeRequest, input: { teamId: '' } }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Team runtime request is invalid' },
    });
  });

  it('dispatches Team runtime requests and preserves succeeded results', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({ success: true, teamId: 'team-1' }));
    const result = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({ name: 'team.runtime.execute', input: teamRuntimeRequest });
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
    const command = vi.fn().mockResolvedValue(succeeded({ success: true }));
    const result = response();

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({ name: 'team.runtime.execute', input: request });
    expect(result.state).toEqual({ statusCode: 200, body: { success: true } });
  });

  it('forwards Team runtime trace id only as private control metadata', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({ success: true, teamId: 'team-1' }));
    const result = response();
    const traceId = 'session-trace:team-runtime:team.runList:trace-1';

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest, 'POST', { 'x-matchaclaw-session-trace': traceId }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({
      name: 'team.runtime.execute',
      input: { ...teamRuntimeRequest, traceId },
    });
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
      { workspaceMediaTransport } as never,
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
      { workspaceMediaTransport } as never,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { success: false, error: 'Workspace media is unavailable' } });
    expect(JSON.stringify(result.state)).not.toContain('C:/private');
  });

  it('rejects unknown Team runtime results without faking success', async () => {
    const command = vi.fn().mockResolvedValue({ kind: 'unknown', result: { outcome: 'unknown' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
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
    const command = vi.fn().mockResolvedValue({ kind: 'unknown', result: { teamId: 'team-1', state: 'outcome_unknown' } });
    const result = response();

    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
  });

  it.each([
    ['INVALID_INPUT', 400, 'Team runtime request is invalid'],
    ['CAPACITY_EXHAUSTED', 409, 'Team runtime operation is unavailable'],
    ['UNAVAILABLE', 503, 'Team runtime operation is unavailable'],
    ['FAILED', 500, 'Team runtime operation is unavailable'],
  ] as const)('projects Team runtime rejection %s', async (code, statusCode, error) => {
    const command = vi.fn().mockResolvedValue(rejected(code, 'private failure details'));
    const result = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(result.state).toEqual({ statusCode, body: { success: false, error } });
    expect(JSON.stringify(result.state)).not.toContain('private failure details');
  });

  it('projects Team runtime timeouts and transport failures as unavailable', async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({ kind: 'timed-out' })
      .mockRejectedValueOnce(new Error('private transport failure'));
    const timedOut = response();
    const failed = response();

    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      timedOut.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );
    await handleCapabilityRoutes(
      incoming(teamRuntimeRequest) as never,
      failed.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(timedOut.state).toEqual({ statusCode: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
    expect(failed.state).toEqual({ statusCode: 503, body: { success: false, error: 'Team runtime operation is unavailable' } });
  });

  it('installs the Toolchain through the native control command', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({ result: { outcome: 'installed' } }));
    const result = response();

    await handleCapabilityRoutes(
      incoming(toolchainInstallRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith(
      { name: 'openclaw.toolchain.install-uv' },
      { timeoutMs: 120000 },
    );
    expect(result.state).toEqual({ statusCode: 200, body: { success: true } });
  });

  it.each([
    ['rejected', 500, { success: false, error: 'Toolchain installation was rejected' }],
    ['unknown', 503, { success: false, error: 'Toolchain installation outcome is unknown' }],
  ] as const)('projects a Toolchain %s outcome', async (outcome, statusCode, body) => {
    const result = response();

    await handleCapabilityRoutes(
      incoming(toolchainInstallRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command: vi.fn().mockResolvedValue(succeeded({ result: { outcome } })) } } as never,
    );

    expect(result.state).toEqual({ statusCode, body });
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

  it('projects Cron trigger outcomes through the native control command', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({ result: { outcome: 'accepted' } }));
    const result = response();

    await handleCapabilityRoutes(
      incoming(cronTriggerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({
      name: 'openclaw.cron.manual-trigger',
      input: { jobId: 'cron-job-1' },
    });
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, result: { outcome: 'accepted' } },
    });
  });

  it.each(['accepted', 'skipped', 'outcome-unknown'] as const)(
    'preserves safe Cron outcome %s', async (outcome) => {
      const result = response();
      await handleCapabilityRoutes(
        incoming(cronTriggerRequest) as never,
        result.raw as never,
        new URL('http://localhost/api/capabilities/execute'),
        { runtimeHost: { command: vi.fn().mockResolvedValue(succeeded({ result: { outcome } })) } } as never,
      );
      expect(result.state).toEqual({ statusCode: 200, body: { success: true, result: { outcome } } });
    },
  );

  it('projects an unknown-delivery Cron command as outcome-unknown', async () => {
    const result = response();
    const command = vi.fn().mockRejectedValue(new RuntimeHostControlError('timeout-exceeded', 'unknown-delivery'));

    await handleCapabilityRoutes(
      incoming(cronTriggerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
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
    const command = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Cron trigger request is invalid' },
    });
  });

  it.each([
    rejected('UNAVAILABLE', 'private native detail'),
    rejected('FAILED', 'private native detail'),
    { kind: 'timed-out' as const },
  ])('hides unavailable Cron control outcomes: %p', async (outcome) => {
    const result = response();

    await handleCapabilityRoutes(
      incoming(cronTriggerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { runtimeHost: { command: vi.fn().mockResolvedValue(outcome) } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Cron service is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private native detail');
  });

  it('delivers the full capability directory from the typed list command', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({
      capabilities: [agentSkillConfigDescriptor, agentToolConfigDescriptor, subagentDescriptor, providerRoutingDescriptor, schedulerDescriptor],
    }));
    const result = response();

    await handleCapabilityRoutes(
      incoming(undefined, 'GET') as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/list'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({ name: 'host.capabilities.list' });
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        capabilities: [agentSkillConfigDescriptor, agentToolConfigDescriptor, subagentDescriptor, providerRoutingDescriptor, schedulerDescriptor, licenseDescriptor],
      },
    });
  });

  it('describes the Electron-owned License capability without querying Runtime Host', async () => {
    const command = vi.fn();
    const result = response();
    const body = { id: licenseDescriptor.id, scope: licenseDescriptor.scope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: { capability: licenseDescriptor } });
  });

  it('delivers a capability description with the exact typed request', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({ capability: schedulerDescriptor }));
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({
      name: 'host.capabilities.describe',
      input: body,
    });
    expect(result.state).toEqual({ statusCode: 200, body: { capability: schedulerDescriptor } });
  });

  it('delivers the complete subagent descriptor without rebuilding it in Main', async () => {
    const command = vi.fn().mockResolvedValue(succeeded({ capability: subagentDescriptor }));
    const result = response();
    const body = { id: subagentDescriptor.id, scope: subagentScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({
      name: 'host.capabilities.describe',
      input: body,
    });
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
    const command = vi.fn().mockResolvedValue(succeeded({ capability }));
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('fails closed for missing or invalid returned descriptor fields', async () => {
    const missingOperations = { ...schedulerDescriptor } as Record<string, unknown>;
    delete missingOperations.operations;
    const invalidScope = {
      ...schedulerDescriptor,
      scope: { ...schedulerScope, unexpected: true },
    };
    const command = vi.fn()
      .mockResolvedValueOnce(succeeded({ capability: missingOperations }))
      .mockResolvedValueOnce(succeeded({ capability: invalidScope }));
    const missing = response();
    const invalid = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      missing.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );
    await handleCapabilityRoutes(
      incoming(body) as never,
      invalid.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(missing.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
    expect(invalid.state).toEqual(missing.state);
  });

  it('fails closed for an outer succeeded outcome with private extra fields', async () => {
    const command = vi.fn().mockResolvedValue({
      ...succeeded({ capability: schedulerDescriptor }),
      privateField: 'native-secret',
    });
    const result = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('native-secret');
  });

  it('maps a valid request with an unavailable scope to the generic not-available response', async () => {
    const command = vi.fn().mockResolvedValue(rejected('INVALID_INPUT', 'private scope details'));
    const result = response();
    const body = {
      id: schedulerDescriptor.id,
      scope: { ...schedulerScope, endpoint: { ...schedulerScope.endpoint, runtimeInstanceId: 'other' } },
    };

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(command).toHaveBeenCalledWith({ name: 'host.capabilities.describe', input: body });
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private scope details');
  });

  it('fails closed for malformed directory results and command exceptions', async () => {
    const command = vi.fn()
      .mockResolvedValueOnce(succeeded({ capabilities: [{ ...schedulerDescriptor, privateField: true }] }))
      .mockRejectedValueOnce(new Error('private native error'));
    const malformed = response();
    const thrown = response();

    await handleCapabilityRoutes(
      incoming(undefined, 'GET') as never,
      malformed.raw as never,
      new URL('http://localhost/api/capabilities/list'),
      { runtimeHost: { command } } as never,
    );
    await handleCapabilityRoutes(
      incoming(undefined, 'GET') as never,
      thrown.raw as never,
      new URL('http://localhost/api/capabilities/list'),
      { runtimeHost: { command } } as never,
    );

    expect(malformed.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
    expect(thrown.state).toEqual(malformed.state);
  });

  it('maps invalid capability rejection to a generic not-available response', async () => {
    const command = vi.fn().mockResolvedValue(rejected('INVALID_INPUT', 'private scope details'));
    const result = response();

    await handleCapabilityRoutes(
      incoming({ id: 'unknown.capability', scope: schedulerScope }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private scope details');
  });

  it.each([
    rejected('UNAVAILABLE'),
    rejected('CAPACITY_EXHAUSTED'),
    rejected('FAILED'),
    { kind: 'timed-out' as const },
  ])('maps unavailable describe outcomes to a generic response: %p', async (outcome) => {
    const command = vi.fn().mockResolvedValue(outcome);
    const result = response();

    await handleCapabilityRoutes(
      incoming({ id: schedulerDescriptor.id, scope: schedulerScope }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
  });

  it('fails closed for malformed describe results and command exceptions', async () => {
    const command = vi.fn()
      .mockResolvedValueOnce(succeeded({ capability: { ...schedulerDescriptor, privateField: 'leak' } }))
      .mockRejectedValueOnce(new Error('private native error'));
    const malformed = response();
    const thrown = response();
    const body = { id: schedulerDescriptor.id, scope: schedulerScope };

    await handleCapabilityRoutes(
      incoming(body) as never,
      malformed.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );
    await handleCapabilityRoutes(
      incoming(body) as never,
      thrown.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(malformed.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Capability directory is unavailable' },
    });
    expect(thrown.state).toEqual(malformed.state);
  });

  it.each([
    {},
    { id: '', scope: schedulerScope },
    { id: 'scheduler.cron\0private', scope: schedulerScope },
    { id: schedulerDescriptor.id, scope: { ...schedulerScope, private: true } },
  ])('rejects malformed describe requests before dispatch: %p', async (body) => {
    const command = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      incoming(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('maps malformed describe JSON to the request-failed response', async () => {
    const command = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      malformedIncoming('{not-json') as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/describe'),
      { runtimeHost: { command } } as never,
    );

    expect(command).not.toHaveBeenCalled();
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
      { sessionSendTransport: { send } } as never,
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
      { providerRoutingTransport: { execute } } as never,
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
      { sessionTimelineTransport: { load, window } } as never,
    );
    await handleCapabilityRoutes(
      incoming(windowBody) as never,
      windowResult.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { sessionTimelineTransport: { load, window } } as never,
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
      { providerRoutingTransport: { execute: vi.fn().mockResolvedValue({ status: 200, body: { privateCanary } }) } } as never,
    );
    await handleCapabilityRoutes(
      incoming(taskRequest) as never,
      task.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      { taskManagerTransport: { list: vi.fn().mockResolvedValue({ status: 200, body: { privateCanary } }) } } as never,
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

  it('projects only known LicenseService fields', async () => {
    const result = response();
    const key = 'MATCHACLAW-AAAA-BBBB-CCCC-DDDD';
    const privateCanary = '/private/license/path private-token';

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
      {
        licenseService: {
          validate: vi.fn().mockResolvedValue({
            valid: true,
            code: 'valid',
            mode: 'checksum',
            masked: 'MATCHACLAW-****-****-****-DDDD',
            privateCanary,
          }),
        },
      } as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'License service is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain(key);
    expect(JSON.stringify(result.state)).not.toContain(privateCanary);
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
      { taskManagerTransport: { list } } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Task manager request is invalid' },
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertRuntimeEndpointRef,
  buildCapabilityScopeKey,
  buildCapabilityTargetKey,
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  targetBelongsToScope,
  validateCapabilityTarget,
  validateRuntimeEndpointRef,
  validateRuntimeScope,
  validateSessionIdentity,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import {
  readCreateSessionRequest,
  readPromptSessionRequest,
  readSessionIdentityRequest,
} from '../../runtime-host/application/sessions/session-runtime-requests';

const nativeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'openclaw-local-1',
};

const connectorEndpoint: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const sessionIdentity: SessionIdentity = {
  endpoint: nativeEndpoint,
  agentId: 'default',
  sessionKey: 'agent:default:main',
};

describe('runtime endpoint, scope, identity, and target contract', () => {
  it('builds structured keys for runtime endpoints without delimiter collisions', () => {
    expect(JSON.parse(buildRuntimeEndpointKey(nativeEndpoint))).toEqual({
      type: 'runtime-endpoint',
      kind: 'native-runtime',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'openclaw-local-1',
    });
    expect(JSON.parse(buildRuntimeEndpointKey(connectorEndpoint))).toEqual({
      type: 'runtime-endpoint',
      kind: 'protocol-connector',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });
    expect(buildRuntimeEndpointKey({
      kind: 'native-runtime',
      runtimeAdapterId: 'a:b',
      runtimeInstanceId: 'c',
    })).not.toBe(buildRuntimeEndpointKey({
      kind: 'native-runtime',
      runtimeAdapterId: 'a',
      runtimeInstanceId: 'b:c',
    }));
  });

  it('builds structured keys for capability scopes without delimiter collisions', () => {
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'app' }))).toEqual({ type: 'runtime-scope', kind: 'app' });
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'bootstrap' }))).toEqual({ type: 'runtime-scope', kind: 'bootstrap' });
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'runtime-instance', endpoint: nativeEndpoint }))).toMatchObject({ type: 'runtime-scope', kind: 'runtime-instance' });
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'agent', endpoint: nativeEndpoint, agentId: 'researcher' }))).toMatchObject({ type: 'runtime-scope', kind: 'agent', agentId: 'researcher' });
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'session', identity: sessionIdentity }))).toMatchObject({ type: 'runtime-scope', kind: 'session' });
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'workspace', endpoint: nativeEndpoint, workspaceId: 'workspace-a', sourceId: 'src' }))).toMatchObject({ type: 'runtime-scope', kind: 'workspace', workspaceId: 'workspace-a', sourceId: 'src' });
    expect(JSON.parse(buildCapabilityScopeKey({ kind: 'team-run', endpoint: nativeEndpoint, teamId: 'team-a', runId: 'run-1' }))).toMatchObject({ type: 'runtime-scope', kind: 'team-run', teamId: 'team-a', runId: 'run-1' });
    expect(buildCapabilityScopeKey({ kind: 'agent', endpoint: nativeEndpoint, agentId: 'a:b' })).not.toBe(buildCapabilityScopeKey({
      kind: 'agent',
      endpoint: { ...nativeEndpoint, runtimeInstanceId: 'openclaw-local-1:a' },
      agentId: 'b',
    }));
  });

  it('builds structured keys for session identities and business targets without delimiter collisions', () => {
    expect(JSON.parse(buildSessionIdentityKey(sessionIdentity))).toMatchObject({
      type: 'session-identity',
      agentId: 'default',
      sessionKey: 'agent:default:main',
    });
    expect(JSON.parse(buildCapabilityTargetKey({ kind: 'session', identity: sessionIdentity }))).toMatchObject({ type: 'capability-target', kind: 'session' });
    expect(JSON.parse(buildCapabilityTargetKey({ kind: 'provider-credential', accountId: 'openai-main' }))).toEqual({ type: 'capability-target', kind: 'provider-credential', accountId: 'openai-main' });
    expect(JSON.parse(buildCapabilityTargetKey({ kind: 'workspace-file', workspaceId: 'workspace-a', sourceId: 'src', path: '/tmp/demo.txt', identity: sessionIdentity }))).toMatchObject({ type: 'capability-target', kind: 'workspace-file', workspaceId: 'workspace-a', sourceId: 'src', path: '/tmp/demo.txt' });
    expect(JSON.parse(buildCapabilityTargetKey({ kind: 'team-run', teamId: 'team-a', runId: 'run-1' }))).toEqual({ type: 'capability-target', kind: 'team-run', teamId: 'team-a', runId: 'run-1' });
    expect(buildSessionIdentityKey({ ...sessionIdentity, agentId: 'a:b', sessionKey: 'c' })).not.toBe(buildSessionIdentityKey({ ...sessionIdentity, agentId: 'a', sessionKey: 'b:c' }));
    expect(buildCapabilityTargetKey({ kind: 'workspace-file', workspaceId: 'a:b', path: 'c', identity: sessionIdentity })).not.toBe(buildCapabilityTargetKey({ kind: 'workspace-file', workspaceId: 'a', sourceId: 'b', path: 'c', identity: sessionIdentity }));
  });

  it('rejects missing required endpoint and identity fields', () => {
    expect(validateRuntimeEndpointRef({
      kind: 'native-runtime',
      runtimeAdapterId: 'openclaw',
    })).toBe('runtimeInstanceId is required');

    expect(() => assertRuntimeEndpointRef({
      kind: 'protocol-connector',
      protocolId: 'acp',
      endpointId: 'claude-code',
    })).toThrow('connectorId is required');

    expect(validateSessionIdentity({
      endpoint: nativeEndpoint,
      sessionKey: 'agent:default:main',
    })).toBe('agentId is required');
  });

  it('keeps runtime endpoints, scopes and identities mutually exclusive', () => {
    expect(validateRuntimeEndpointRef({
      ...nativeEndpoint,
      connectorId: 'acp',
    })).toBe('connectorId is not allowed for native-runtime');

    expect(validateRuntimeEndpointRef({
      ...connectorEndpoint,
      runtimeAdapterId: 'openclaw',
    })).toBe('runtimeAdapterId is not allowed for protocol-connector');

    expect(validateRuntimeScope({
      kind: 'agent',
      endpoint: nativeEndpoint,
    })).toBe('agentId is required');

    expect(validateRuntimeScope({
      kind: 'session',
      identity: {
        endpoint: nativeEndpoint,
        agentId: 'default',
      },
    })).toBe('sessionKey is required');
  });

  it('rejects extra fields on runtime scopes', () => {
    expect(validateRuntimeScope({
      kind: 'app',
      endpoint: nativeEndpoint,
    })).toBe('endpoint is not allowed for app');

    expect(validateRuntimeScope({
      kind: 'bootstrap',
      agentId: 'default',
    })).toBe('agentId is not allowed for bootstrap');

    expect(validateRuntimeScope({
      kind: 'runtime-instance',
      endpoint: nativeEndpoint,
      identity: sessionIdentity,
    })).toBe('identity is not allowed for runtime-instance');

    expect(validateRuntimeScope({
      kind: 'workspace',
      endpoint: nativeEndpoint,
      workspaceId: 'workspace-a',
      agentId: 'default',
    })).toBe('agentId is not allowed for workspace');
  });

  it('validates target fields by target kind', () => {
    expect(validateCapabilityTarget({ kind: 'provider-credential' })).toBe('accountId is required');
    expect(validateCapabilityTarget({ kind: 'capability-route' })).toBe('capabilityId is required');
    expect(validateCapabilityTarget({ kind: 'task', owner: { kind: 'agent', agentId: 'default' } })).toBe('taskId is required');
    expect(validateCapabilityTarget({ kind: 'task', taskId: 'task-1', owner: { kind: 'agent', agentId: 'default' } })).toBe('owner target kind is invalid');
    expect(validateCapabilityTarget({ kind: 'workspace-file', path: '/tmp/a.txt', workspaceId: '' })).toBe('workspaceId must be a string');
    expect(validateCapabilityTarget({ kind: 'workspace-file', path: '/tmp/a.txt' })).toBe('SessionIdentity must be an object');
    expect(validateCapabilityTarget({ kind: 'workspace-file', path: '/tmp/a.txt', workspaceId: 'workspace-a', identity: sessionIdentity })).toBeNull();
    expect(validateCapabilityTarget({ kind: 'provider-credential', accountId: 'openai-main', vendorId: 'openai' })).toBeNull();
  });

  it('rejects extra fields on capability targets', () => {
    expect(validateCapabilityTarget({
      kind: 'runtime-endpoint',
      agentId: 'default',
    })).toBe('agentId is not allowed for runtime-endpoint');

    expect(validateCapabilityTarget({
      kind: 'provider-credential',
      accountId: 'openai-main',
      taskId: 'task-1',
    })).toBe('taskId is not allowed for provider-credential');

    expect(validateCapabilityTarget({
      kind: 'session',
      identity: sessionIdentity,
      taskId: 'task-1',
    })).toBe('taskId is not allowed for session');

    expect(validateCapabilityTarget({
      kind: 'workspace-file',
      path: '/tmp/a.txt',
      owner: { kind: 'session', identity: sessionIdentity },
    })).toBe('owner is not allowed for workspace-file');
  });

  it('keeps workspace file targets inside workspace scope identity and source boundaries', () => {
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt', workspaceId: 'workspace-a', sourceId: 'src', identity: sessionIdentity },
      { kind: 'workspace', endpoint: nativeEndpoint, workspaceId: 'workspace-a', sourceId: 'src' },
    )).toBe(true);
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt', workspaceId: 'workspace-b', sourceId: 'src', identity: sessionIdentity },
      { kind: 'workspace', endpoint: nativeEndpoint, workspaceId: 'workspace-a', sourceId: 'src' },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt', workspaceId: 'workspace-a', identity: sessionIdentity },
      { kind: 'workspace', endpoint: nativeEndpoint },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt', sourceId: 'src', identity: sessionIdentity },
      { kind: 'workspace', endpoint: nativeEndpoint, workspaceId: 'workspace-a' },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt', identity: sessionIdentity },
      { kind: 'workspace', endpoint: connectorEndpoint, workspaceId: 'workspace-a' },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt' } as never,
      { kind: 'workspace', endpoint: nativeEndpoint },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'workspace-file', path: '/tmp/demo.txt' } as never,
      { kind: 'app' },
    )).toBe(false);
  });

  it('keeps target scope ownership rules explicit', () => {
    expect(targetBelongsToScope(
      { kind: 'task', taskId: 'task-1' },
      { kind: 'runtime-instance', endpoint: nativeEndpoint },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'task', taskId: 'task-1' },
      { kind: 'session', identity: sessionIdentity },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'agent', agentId: 'default' },
      { kind: 'runtime-instance', endpoint: nativeEndpoint },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'subagent', agentId: 'default', subagentId: 'worker' },
      { kind: 'runtime-instance', endpoint: nativeEndpoint },
    )).toBe(false);
    expect(targetBelongsToScope(
      { kind: 'team' },
      { kind: 'runtime-instance', endpoint: nativeEndpoint },
    )).toBe(true);
    expect(targetBelongsToScope(
      { kind: 'team', packagePath: '/pkg' },
      { kind: 'team-run', endpoint: nativeEndpoint, runId: 'run-1' },
    )).toBe(false);
  });

  it('requires RuntimeEndpointRef for session creation and SessionIdentity for existing session DTOs', () => {
    expect(readCreateSessionRequest({ sessionKey: 'agent:main:main' })).toMatchObject({
      endpoint: null,
      endpointError: 'RuntimeEndpointRef is required',
    });
    expect(readCreateSessionRequest({ sessionKey: 'agent:main:main', agentId: 'main', endpoint: nativeEndpoint })).toMatchObject({
      explicitSessionKey: 'agent:main:main',
      agentId: 'main',
      endpoint: nativeEndpoint,
      endpointError: null,
    });
    expect(readPromptSessionRequest({ sessionKey: 'agent:main:main', message: 'hello' })).toMatchObject({
      sessionIdentity: null,
      sessionIdentityError: 'SessionIdentity is required',
    });
    expect(readSessionIdentityRequest({ sessionKey: sessionIdentity.sessionKey, sessionIdentity })).toMatchObject({
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
      sessionIdentityError: null,
    });
  });
});

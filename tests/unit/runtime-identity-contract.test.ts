import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import {
  agentScope,
  buildCapabilityScopeKey,
  buildCapabilityTargetKey,
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  runtimeInstanceScope,
  sessionScope,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { buildSessionIdentityScopedMessageId } from '../../runtime-host/application/agent-runtime/contracts/runtime-identity-contract';
import { OpenClawRuntimeAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter';
import { createTestAcpClientConnector } from './helpers/acp-test-connector';

const openClawEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

const claudeCodeEndpoint: RuntimeEndpointRef = {
  kind: 'protocol-connector',
  protocolId: 'acp',
  connectorId: 'acp',
  endpointId: 'claude-code',
};

const openClawSessionIdentity: SessionIdentity = {
  endpoint: openClawEndpoint,
  agentId: 'main',
  sessionKey: 'agent:main:main',
};

const claudeCodeSessionIdentity: SessionIdentity = {
  endpoint: claudeCodeEndpoint,
  agentId: 'default',
  sessionKey: 'claude-code:session:1',
};

function createRegistry(): AgentRuntimeRegistry {
  const registry = new AgentRuntimeRegistry({
    gateway: () => ({
      chatSend: async () => ({ success: true }),
      gatewayRpc: async () => ({}),
    }),
  });
  registry.register({
    runtimeAdapters: [new OpenClawRuntimeAdapter()],
    protocolConnectors: [createTestAcpClientConnector({
      createTransport: () => ({
        sendPrompt: async () => ({ success: true }),
        abortSession: async () => {},
        resolveApproval: async () => ({}),
      }),
    })],
  });
  return registry;
}

async function createConnectedRegistry(): Promise<AgentRuntimeRegistry> {
  const registry = createRegistry();
  await registry.connectRuntimeEndpoint({
    protocolId: 'acp',
    connectorId: 'acp',
    endpointId: 'claude-code',
  });
  return registry;
}

describe('runtime identity contract', () => {
  it('builds endpoint, session, scope, and target keys from current contract fields', () => {
    expect(JSON.parse(buildRuntimeEndpointKey(openClawEndpoint))).toEqual({
      type: 'runtime-endpoint',
      kind: 'native-runtime',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    });
    expect(JSON.parse(buildRuntimeEndpointKey(claudeCodeEndpoint))).toEqual({
      type: 'runtime-endpoint',
      kind: 'protocol-connector',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    });
    expect(JSON.parse(buildSessionIdentityKey(openClawSessionIdentity))).toEqual({
      type: 'session-identity',
      endpoint: JSON.parse(buildRuntimeEndpointKey(openClawEndpoint)),
      agentId: 'main',
      sessionKey: 'agent:main:main',
    });
    expect(JSON.parse(buildCapabilityScopeKey(runtimeInstanceScope(openClawEndpoint)))).toEqual({
      type: 'runtime-scope',
      kind: 'runtime-instance',
      endpoint: JSON.parse(buildRuntimeEndpointKey(openClawEndpoint)),
    });
    expect(JSON.parse(buildCapabilityScopeKey(agentScope(openClawEndpoint, 'main')))).toEqual({
      type: 'runtime-scope',
      kind: 'agent',
      endpoint: JSON.parse(buildRuntimeEndpointKey(openClawEndpoint)),
      agentId: 'main',
    });
    expect(JSON.parse(buildCapabilityScopeKey(sessionScope(openClawSessionIdentity)))).toEqual({
      type: 'runtime-scope',
      kind: 'session',
      identity: JSON.parse(buildSessionIdentityKey(openClawSessionIdentity)),
    });
    expect(JSON.parse(buildCapabilityTargetKey({ kind: 'session', identity: openClawSessionIdentity }))).toEqual({
      type: 'capability-target',
      kind: 'session',
      identity: JSON.parse(buildSessionIdentityKey(openClawSessionIdentity)),
    });
  });

  it('remembers native session identity from explicit endpoint metadata', () => {
    expect(createRegistry().rememberSessionIdentity(openClawSessionIdentity)).toMatchObject({
      identity: openClawSessionIdentity,
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      endpointSessionId: 'agent:main:main',
      agentId: 'main',
      endpoint: {
        scopeKey: buildRuntimeEndpointKey(openClawEndpoint),
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      endpointRef: openClawEndpoint,
    });
  });

  it('resolves a remembered local identity by endpoint session id', () => {
    const registry = createRegistry();
    const localIdentity: SessionIdentity = {
      endpoint: openClawEndpoint,
      agentId: 'leader',
      sessionKey: 'team-role-session-1',
    };

    const rememberedContext = registry.rememberSessionIdentity(localIdentity, 'team-endpoint-session-1');
    const registryWithEndpointSessionLookup = registry as AgentRuntimeRegistry & {
      resolveSessionContextByEndpointSessionId: (
        endpointRef: RuntimeEndpointRef,
        endpointSessionId: string,
      ) => ReturnType<AgentRuntimeRegistry['rememberSessionIdentity']> | null;
    };

    expect(registryWithEndpointSessionLookup.resolveSessionContextByEndpointSessionId(openClawEndpoint, 'team-endpoint-session-1')).toBe(rememberedContext);
    expect(registryWithEndpointSessionLookup.resolveSessionContextByEndpointSessionId(openClawEndpoint, 'missing-endpoint-session')).toBeNull();
  });

  it('reuses cached endpoint session id for remembered local identities', () => {
    const registry = createRegistry();
    const localIdentity: SessionIdentity = {
      endpoint: openClawEndpoint,
      agentId: 'leader',
      sessionKey: 'team-role-session-1',
    };

    registry.rememberSessionIdentity(localIdentity, 'team-endpoint-session-1');

    expect(registry.rememberSessionIdentity(localIdentity)).toMatchObject({
      identity: localIdentity,
      localSessionId: 'team-role-session-1',
      endpointSessionId: 'team-endpoint-session-1',
    });
  });

  it('requires an explicit endpoint session id when the local key is outside the endpoint keying namespace', () => {
    const registry = createRegistry();
    const localIdentity: SessionIdentity = {
      endpoint: openClawEndpoint,
      agentId: 'leader',
      sessionKey: 'team-role-session-1',
    };

    expect(() => registry.rememberSessionIdentity(localIdentity)).toThrow(
      'Runtime session binding requires an explicit endpointSessionId when the local session id is outside the endpoint keying namespace.',
    );
  });

  it('requires registered endpoint metadata for native runtime endpoints', () => {
    const registry = new AgentRuntimeRegistry();
    expect(() => registry.rememberSessionIdentity(openClawSessionIdentity)).toThrow(
      'Native runtime endpoint not registered: openclaw:local',
    );
  });

  it('remembers connector identity from protocol and endpoint without using connector as provider', async () => {
    expect((await createConnectedRegistry()).rememberSessionIdentity(claudeCodeSessionIdentity)).toMatchObject({
      identity: claudeCodeSessionIdentity,
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpointSessionId: 'claude-code:session:1',
      endpoint: {
        scopeKey: buildRuntimeEndpointKey(claudeCodeEndpoint),
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
      },
      endpointRef: claudeCodeEndpoint,
    });
  });

  it('builds message identity from explicit session identity, run, and lane only', () => {
    expect(buildSessionIdentityScopedMessageId({
      identity: claudeCodeSessionIdentity,
      runId: 'run-1',
      laneKey: 'agent-a',
      role: 'assistant',
      messageIndex: 2,
    })).toBe(`${buildSessionIdentityKey(claudeCodeSessionIdentity)}:run-1:agent-a:assistant:2`);
  });

  it('rejects message identity without explicit run or lane', () => {
    expect(() => buildSessionIdentityScopedMessageId({
      identity: claudeCodeSessionIdentity,
      runId: '',
      laneKey: 'agent-a',
      role: 'assistant',
      messageIndex: 2,
    })).toThrow('Runtime message identity requires runId');
    expect(() => buildSessionIdentityScopedMessageId({
      identity: claudeCodeSessionIdentity,
      runId: 'run-1',
      laneKey: '',
      role: 'assistant',
      messageIndex: 2,
    })).toThrow('Runtime message identity requires laneKey');
  });
});

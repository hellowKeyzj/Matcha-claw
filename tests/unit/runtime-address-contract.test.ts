import { describe, expect, it } from 'vitest';
import {
  assertRuntimeAddress,
  buildRuntimeAddressKey,
  getRuntimeAddressKeyParts,
  validateRuntimeAddress,
  type RuntimeAddress,
} from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import {
  readCreateSessionRequest,
  readPromptSessionRequest,
  readRuntimeAddressRequest,
} from '../../runtime-host/application/sessions/session-runtime-requests';

describe('runtime address contract', () => {
  it('builds isolated keys for native runtime instances and agents', () => {
    const base: RuntimeAddress = {
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'openclaw-local-1',
      agentId: 'default',
    };

    expect(buildRuntimeAddressKey(base)).toBe('session.prompt:native-runtime:openclaw:openclaw-local-1:default:model-provider:');
    expect(buildRuntimeAddressKey({
      ...base,
      runtimeInstanceId: 'workspace-a',
    })).toBe('session.prompt:native-runtime:openclaw:workspace-a:default:model-provider:');
    expect(buildRuntimeAddressKey({
      ...base,
      agentId: 'researcher',
    })).toBe('session.prompt:native-runtime:openclaw:openclaw-local-1:researcher:model-provider:');
  });

  it('builds isolated keys for ACP connector endpoints and agents', () => {
    const claudeCode: RuntimeAddress = {
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
    };

    expect(buildRuntimeAddressKey(claudeCode)).toBe('session.prompt:protocol-connector:acp:acp:claude-code:default:model-provider:');
    expect(buildRuntimeAddressKey({
      ...claudeCode,
      endpointId: 'hermes',
    })).toBe('session.prompt:protocol-connector:acp:acp:hermes:default:model-provider:');
    expect(buildRuntimeAddressKey({
      ...claudeCode,
      agentId: 'browser-agent',
    })).toBe('session.prompt:protocol-connector:acp:acp:claude-code:browser-agent:model-provider:');
  });

  it('rejects missing fields instead of defaulting to OpenClaw', () => {
    expect(validateRuntimeAddress({
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'openclaw-local-1',
    })).toBe('RuntimeAddress agentId is required');

    expect(() => assertRuntimeAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    })).toThrow('RuntimeAddress agentId is required');
  });

  it('keeps native runtime and protocol connector addresses mutually exclusive', () => {
    expect(validateRuntimeAddress({
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'openclaw-local-1',
      agentId: 'default',
      connectorId: 'acp',
    })).toBe('RuntimeAddress connectorId is not allowed for native-runtime');

    expect(validateRuntimeAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
      runtimeAdapterId: 'openclaw',
    })).toBe('RuntimeAddress runtimeAdapterId is not allowed for protocol-connector');
  });

  it('does not allow model provider to stand in for runtime adapter or connector ownership', () => {
    expect(validateRuntimeAddress({
      kind: 'native-runtime',
      capabilityId: 'session.prompt',
      runtimeInstanceId: 'workspace-a',
      agentId: 'default',
      modelProviderId: 'anthropic',
    })).toBe('RuntimeAddress runtimeAdapterId is required');

    expect(validateRuntimeAddress({
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      endpointId: 'claude-code',
      agentId: 'default',
      modelProviderId: 'anthropic',
    })).toBe('RuntimeAddress connectorId is required');
  });

  it('requires explicit RuntimeAddress in session request DTOs', () => {
    expect(readCreateSessionRequest({ sessionKey: 'agent:main:main' })).toMatchObject({
      runtimeAddress: null,
      runtimeAddressError: 'RuntimeAddress is required',
    });
    expect(readPromptSessionRequest({ sessionKey: 'agent:main:main', message: 'hello' })).toMatchObject({
      runtimeAddress: null,
      runtimeAddressError: 'RuntimeAddress is required',
    });
    expect(readRuntimeAddressRequest({ sessionKey: 'agent:main:main' })).toMatchObject({
      runtimeAddress: null,
      runtimeAddressError: 'RuntimeAddress is required',
    });
  });

  it('includes model provider in full address keys without treating it as runtime ownership', () => {
    const address: RuntimeAddress = {
      kind: 'native-runtime',
      capabilityId: 'model.route',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'workspace-a',
      agentId: 'default',
      modelProviderId: 'anthropic',
    };

    expect(buildRuntimeAddressKey(address)).toBe('model.route:native-runtime:openclaw:workspace-a:default:model-provider:anthropic');
    expect(buildRuntimeAddressKey({
      ...address,
      modelProviderId: 'openai',
    })).toBe('model.route:native-runtime:openclaw:workspace-a:default:model-provider:openai');
    expect(getRuntimeAddressKeyParts(address)).toEqual({
      capabilityId: 'model.route',
      ownerId: 'openclaw',
      targetId: 'workspace-a',
      agentId: 'default',
    });
  });
});

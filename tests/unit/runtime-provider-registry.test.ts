import { describe, expect, it } from 'vitest';
import { RuntimeProviderRegistry } from '../../runtime-host/application/sessions/runtime-providers/runtime-provider-registry';
import { OpenClawV4ProtocolAdapter } from '../../runtime-host/application/sessions/runtime-providers/openclaw/openclaw-v4-protocol-adapter';
import { openClawRuntimeProviderProfile } from '../../runtime-host/application/sessions/runtime-providers/openclaw/openclaw-profile';
import { AcpProtocolAdapter } from '../../runtime-host/application/sessions/runtime-providers/acp/acp-protocol-adapter';
import { acpRuntimeProviderProfiles } from '../../runtime-host/application/sessions/runtime-providers/acp/acp-profiles';

function createRegistry(): RuntimeProviderRegistry {
  const registry = new RuntimeProviderRegistry();
  registry.register({
    protocol: new OpenClawV4ProtocolAdapter({
      chatSend: async () => ({ success: true }),
      gatewayRpc: async () => ({}),
    }),
    profiles: [openClawRuntimeProviderProfile],
  });
  registry.register({
    protocol: new AcpProtocolAdapter(),
    profiles: acpRuntimeProviderProfiles,
  });
  return registry;
}

describe('runtime provider registry', () => {
  it('registers one protocol adapter for multiple provider profiles', () => {
    const registry = createRegistry();

    expect(registry.getProfile('openclaw').protocolId).toBe('openclaw-v4');
    expect(registry.getProfile('claude-code').protocolId).toBe('acp');
    expect(registry.getProfile('hermes').protocolId).toBe('acp');
    expect(registry.getProtocol('acp')).toBe(registry.resolveProtocolForSession('claude-code:session:1', {
      protocolId: 'acp',
      runtimeProviderId: 'claude-code',
    }));
  });

  it('centralizes legacy OpenClaw session context fallback', () => {
    const registry = createRegistry();

    expect(registry.resolveSessionContext('agent:main:main')).toMatchObject({
      sessionKey: 'agent:main:main',
      protocolId: 'openclaw-v4',
      runtimeProviderId: 'openclaw',
      providerSessionId: 'agent:main:main',
      agentId: 'main',
    });
  });
});

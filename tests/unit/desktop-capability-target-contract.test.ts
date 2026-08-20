import { describe, expect, it } from 'vitest';
import {
  buildCapabilityScopeKey,
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  connectorRuntimeEndpoint,
  nativeRuntimeEndpoint,
  runtimeInstanceScope,
  teamRunScope,
  workspaceScope,
} from '../../electron/desktop-contract/runtime-address';
import {
  buildCapabilityTargetKey,
  targetBelongsToScope,
  validateCapabilityTarget,
} from '../../electron/desktop-contract/capability-target';

const endpoint = nativeRuntimeEndpoint({ runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' });
const identity = { endpoint, agentId: 'agent:primary', sessionKey: 'session:primary' };

describe('desktop runtime address contract', () => {
  it('matches Rust canonical golden vectors', () => {
    expect(buildRuntimeEndpointKey(endpoint)).toBe(
      '{"type":"runtime-endpoint","kind":"native-runtime","runtimeAdapterId":"openclaw","runtimeInstanceId":"local"}',
    );
    expect(buildSessionIdentityKey(identity)).toBe(
      '{"type":"session-identity","endpoint":{"type":"runtime-endpoint","kind":"native-runtime","runtimeAdapterId":"openclaw","runtimeInstanceId":"local"},"agentId":"agent:primary","sessionKey":"session:primary"}',
    );
    expect(buildCapabilityScopeKey(workspaceScope(endpoint, 'workspace:primary', 'source:primary'))).toBe(
      '{"type":"runtime-scope","kind":"workspace","endpoint":{"type":"runtime-endpoint","kind":"native-runtime","runtimeAdapterId":"openclaw","runtimeInstanceId":"local"},"workspaceId":"workspace:primary","sourceId":"source:primary"}',
    );
    expect(buildCapabilityTargetKey({ kind: 'license', subject: 'key' })).toBe(
      '{"type":"capability-target","kind":"license","subject":"key"}',
    );
  });

  it('keys connector endpoints and optional workspace/team-run scopes', () => {
    const connector = connectorRuntimeEndpoint({
      protocolId: 'openclaw',
      connectorId: 'connector:primary',
      endpointId: 'endpoint:primary',
    });
    expect(buildRuntimeEndpointKey(connector)).toBe(
      '{"type":"runtime-endpoint","kind":"protocol-connector","protocolId":"openclaw","connectorId":"connector:primary","endpointId":"endpoint:primary"}',
    );
    expect(buildCapabilityScopeKey(workspaceScope(connector))).toBe(
      '{"type":"runtime-scope","kind":"workspace","endpoint":{"type":"runtime-endpoint","kind":"protocol-connector","protocolId":"openclaw","connectorId":"connector:primary","endpointId":"endpoint:primary"}}',
    );
    expect(buildCapabilityScopeKey(teamRunScope(connector, 'run:primary'))).toBe(
      '{"type":"runtime-scope","kind":"team-run","endpoint":{"type":"runtime-endpoint","kind":"protocol-connector","protocolId":"openclaw","connectorId":"connector:primary","endpointId":"endpoint:primary"},"runId":"run:primary"}',
    );
  });

  it('rejects unsupported dynamic target grammars and malformed identities', () => {
    expect(validateCapabilityTarget({ kind: 'skill', skillId: 'skill-1' })).toBe('CapabilityTarget is invalid');
    expect(() => nativeRuntimeEndpoint({ runtimeAdapterId: 'secret\0adapter', runtimeInstanceId: 'local' })).toThrow(
      'RuntimeEndpointRef is invalid',
    );
    expect(buildRuntimeEndpointKey(nativeRuntimeEndpoint({ runtimeAdapterId: 'a:b', runtimeInstanceId: 'c' }))).not.toBe(
      buildRuntimeEndpointKey(nativeRuntimeEndpoint({ runtimeAdapterId: 'a', runtimeInstanceId: 'b:c' })),
    );
  });

  it('keeps the single shared target app-scoped', () => {
    expect(targetBelongsToScope({ kind: 'license', subject: 'key' }, { kind: 'app' })).toBe(true);
    expect(targetBelongsToScope({ kind: 'license', subject: 'key' }, runtimeInstanceScope(endpoint))).toBe(false);
  });
});

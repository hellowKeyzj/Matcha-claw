import { describe, expect, it } from 'vitest';
import {
  REMOTE_FLEET_SECRET_REF_NAMESPACE,
  REMOTE_FLEET_SECRET_REF_SCHEME,
  evaluateRemoteFleetSecretRefPolicy,
} from '../../runtime-host/application/remote-fleet/remote-fleet-secret-policy';

describe('remote fleet secret ref policy', () => {
  it('allows explicit Remote Fleet namespace references', () => {
    expect(evaluateRemoteFleetSecretRefPolicy('remote-fleet://node-1/api-key')).toEqual({
      decision: 'allowed',
      namespace: REMOTE_FLEET_SECRET_REF_NAMESPACE,
      secretPath: 'node-1/api-key',
    });
    expect(REMOTE_FLEET_SECRET_REF_SCHEME).toBe('remote-fleet://');
  });

  it('denies legacy refs without an explicit namespace', () => {
    expect(evaluateRemoteFleetSecretRefPolicy('remote-fleet/node-1/api-key')).toEqual({
      decision: 'accessDenied',
      reason: 'missingNamespace',
    });
  });

  it('denies provider and OpenClaw namespaces', () => {
    expect(evaluateRemoteFleetSecretRefPolicy('provider://anthropic/default')).toEqual({
      decision: 'accessDenied',
      reason: 'unsupportedNamespace',
    });
    expect(evaluateRemoteFleetSecretRefPolicy('openclaw://auth-profiles/main/anthropic')).toEqual({
      decision: 'accessDenied',
      reason: 'unsupportedNamespace',
    });
  });

  it('denies invalid Remote Fleet secret paths', () => {
    expect(evaluateRemoteFleetSecretRefPolicy('remote-fleet://../provider-profile')).toEqual({
      decision: 'accessDenied',
      reason: 'invalidSecretPath',
    });
    expect(evaluateRemoteFleetSecretRefPolicy('remote-fleet://node-1//api-key')).toEqual({
      decision: 'accessDenied',
      reason: 'invalidSecretPath',
    });
  });
});

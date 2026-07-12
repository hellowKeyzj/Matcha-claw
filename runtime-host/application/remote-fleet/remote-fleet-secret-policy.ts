export const REMOTE_FLEET_SECRET_REF_NAMESPACE = 'remote-fleet' as const;
export const REMOTE_FLEET_SECRET_REF_SCHEME = `${REMOTE_FLEET_SECRET_REF_NAMESPACE}://` as const;

export type RemoteFleetSecretRefPolicyDecision =
  | {
      readonly decision: 'allowed';
      readonly namespace: typeof REMOTE_FLEET_SECRET_REF_NAMESPACE;
      readonly secretPath: string;
    }
  | {
      readonly decision: 'accessDenied';
      readonly reason: 'missingNamespace' | 'unsupportedNamespace' | 'invalidSecretPath';
    };

export function evaluateRemoteFleetSecretRefPolicy(secretRef: string): RemoteFleetSecretRefPolicyDecision {
  const trimmedRef = secretRef.trim();
  if (!trimmedRef.includes('://')) {
    return { decision: 'accessDenied', reason: 'missingNamespace' };
  }

  if (!trimmedRef.startsWith(REMOTE_FLEET_SECRET_REF_SCHEME)) {
    return { decision: 'accessDenied', reason: 'unsupportedNamespace' };
  }

  const secretPath = trimmedRef.slice(REMOTE_FLEET_SECRET_REF_SCHEME.length);
  if (!isValidRemoteFleetSecretPath(secretPath)) {
    return { decision: 'accessDenied', reason: 'invalidSecretPath' };
  }

  return {
    decision: 'allowed',
    namespace: REMOTE_FLEET_SECRET_REF_NAMESPACE,
    secretPath,
  };
}

function isValidRemoteFleetSecretPath(secretPath: string): boolean {
  if (!secretPath || secretPath.length > 256) {
    return false;
  }
  if (secretPath.includes('..') || secretPath.includes('//')) {
    return false;
  }
  return secretPath
    .split('/')
    .every((segment) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(segment));
}

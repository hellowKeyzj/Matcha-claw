import type { RuntimeSystemEnvironmentPort } from '../common/runtime-ports';
import type { RemoteFleetSecretResolveHostRpcResult, RemoteFleetSecretResolverPort } from './remote-fleet-worker-client';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';

export const REMOTE_FLEET_SECRET_ENV_PREFIX = 'MATCHACLAW_REMOTE_FLEET_SECRET_';

export interface RemoteFleetEnvironmentSecretResolverDeps {
  readonly environment: Pick<RuntimeSystemEnvironmentPort, 'getEnv'>;
}

export function createRemoteFleetEnvironmentSecretResolver(
  deps: RemoteFleetEnvironmentSecretResolverDeps,
): RemoteFleetSecretResolverPort {
  return {
    resolveSecret(input) {
      const envName = buildRemoteFleetSecretEnvName(input.secretRef);
      if (!envName) {
        return { resultType: 'accessDenied', secretRef: input.secretRef };
      }

      const value = deps.environment.getEnv(envName);
      if (!value) {
        return { resultType: 'notFound', secretRef: input.secretRef };
      }

      return {
        resultType: 'resolved',
        secretRef: input.secretRef,
        plaintextSecretValue: value,
      } satisfies RemoteFleetSecretResolveHostRpcResult;
    },
  };
}

export function buildRemoteFleetSecretEnvName(secretRef: string): string | undefined {
  const policy = evaluateRemoteFleetSecretRefPolicy(secretRef);
  if (policy.decision !== 'allowed') {
    return undefined;
  }

  return `${REMOTE_FLEET_SECRET_ENV_PREFIX}${policy.secretPath
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()}`;
}

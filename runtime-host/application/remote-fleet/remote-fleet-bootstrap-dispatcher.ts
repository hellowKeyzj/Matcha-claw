import {
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
  type RemoteFleetSecretResolveHostRpcResponse,
} from './remote-fleet-secret-host-rpc';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapCommandResult,
  RemoteFleetBootstrapDispatcherDeps,
  RemoteFleetBootstrapDispatcherPort,
  RemoteFleetBootstrapSecretReadResult,
  RemoteFleetBootstrapSecretReader,
  RemoteFleetBootstrapSecretResolverPort,
  RemoteFleetConnectionProbeEnvelope,
  RemoteFleetConnectionProbeResult,
} from './remote-fleet-bootstrap';
import {
  createUnavailableBootstrapResult,
  createUnavailableConnectionProbeResult,
} from './remote-fleet-bootstrap';
import type { RemoteFleetSecretRef } from './remote-fleet-model';

export function createRemoteFleetBootstrapDispatcher(
  deps: RemoteFleetBootstrapDispatcherDeps,
): RemoteFleetBootstrapDispatcherPort {
  return {
    dispatchCommand: (envelope) => dispatchRemoteFleetBootstrapCommand(envelope, deps),
    probeConnection: (envelope) => dispatchRemoteFleetConnectionProbe(envelope, deps),
  };
}

async function dispatchRemoteFleetConnectionProbe(
  envelope: RemoteFleetConnectionProbeEnvelope,
  deps: RemoteFleetBootstrapDispatcherDeps,
): Promise<RemoteFleetConnectionProbeResult> {
  const provider = deps.providers?.find((candidate) => candidate.providerKind === envelope.providerKind);
  if (!provider || !('probeConnection' in provider)) {
    return createUnavailableConnectionProbeResult(envelope, 'unsupported');
  }

  const secrets = createRemoteFleetConnectionProbeSecretReader(envelope, deps.secretResolver);
  return await provider.probeConnection(envelope, {
    httpClient: deps.httpClient,
    commandExecutor: deps.commandExecutor,
    timer: deps.timer,
    logger: deps.logger,
    secrets,
  });
}

async function dispatchRemoteFleetBootstrapCommand(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  deps: RemoteFleetBootstrapDispatcherDeps,
): Promise<RemoteFleetBootstrapCommandResult> {
  const provider = deps.providers?.find((candidate) => candidate.providerKind === envelope.providerKind);
  if (!provider) {
    return createUnavailableBootstrapResult(
      envelope,
      `Remote Fleet bootstrap provider ${envelope.providerKind} is unavailable.`,
    );
  }

  const secrets = createRemoteFleetBootstrapSecretReader(envelope, deps.secretResolver);
  return await provider.dispatchCommand(envelope, {
    httpClient: deps.httpClient,
    commandExecutor: deps.commandExecutor,
    timer: deps.timer,
    logger: deps.logger,
    secrets,
  });
}

function createRemoteFleetConnectionProbeSecretReader(
  envelope: RemoteFleetConnectionProbeEnvelope,
  secretResolver: RemoteFleetBootstrapSecretResolverPort | undefined,
): RemoteFleetBootstrapSecretReader {
  return {
    readSecret: (secretRefName) => readConnectionProbeSecret(envelope, secretRefName, secretResolver),
    readSecretRef: (secretRef) => readExactBootstrapSecret(envelope.commandId, secretRef, secretResolver),
  };
}

function createRemoteFleetBootstrapSecretReader(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  secretResolver: RemoteFleetBootstrapSecretResolverPort | undefined,
): RemoteFleetBootstrapSecretReader {
  return {
    readSecret: (secretRefName) => readBootstrapSecret(envelope, secretRefName, secretResolver),
    readSecretRef: (secretRef) => readExactBootstrapSecret(envelope.commandId, secretRef, secretResolver),
  };
}

async function readConnectionProbeSecret(
  envelope: RemoteFleetConnectionProbeEnvelope,
  secretRefName: string,
  secretResolver: RemoteFleetBootstrapSecretResolverPort | undefined,
): Promise<RemoteFleetBootstrapSecretReadResult> {
  const secretRef = envelope.connection.secretRefs[secretRefName];
  if (!secretRef) {
    return { resultType: 'missing', secretRefName };
  }

  return await readExactBootstrapSecret(envelope.commandId, secretRef, secretResolver, secretRefName);
}

async function readBootstrapSecret(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  secretRefName: string,
  secretResolver: RemoteFleetBootstrapSecretResolverPort | undefined,
): Promise<RemoteFleetBootstrapSecretReadResult> {
  const secretRef = envelope.connection?.secretRefs[secretRefName]
    ?? envelope.node.secretRefs[secretRefName]
    ?? envelope.environment?.secretRefs[secretRefName];
  if (!secretRef) {
    return { resultType: 'missing', secretRefName };
  }

  return await readExactBootstrapSecret(envelope.commandId, secretRef, secretResolver, secretRefName);
}

async function readExactBootstrapSecret(
  commandId: string,
  secretRef: RemoteFleetSecretRef,
  secretResolver: RemoteFleetBootstrapSecretResolverPort | undefined,
  secretRefName = secretRef.ref,
): Promise<RemoteFleetBootstrapSecretReadResult> {
  const policy = evaluateRemoteFleetSecretRefPolicy(secretRef.ref);
  if (policy.decision !== 'allowed') {
    return { resultType: 'accessDenied', secretRefName, secretRef };
  }

  if (!secretResolver) {
    return { resultType: 'unavailable', secretRefName, secretRef };
  }

  const result = await secretResolver.resolveSecret({
    secretRef: secretRef.ref,
    purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
    commandExecutionId: commandId,
  });
  return bootstrapSecretReadResultFromResolveResult(secretRefName, secretRef, result);
}

function bootstrapSecretReadResultFromResolveResult(
  secretRefName: string,
  secretRef: RemoteFleetSecretRef,
  result: RemoteFleetSecretResolveHostRpcResponse | Omit<RemoteFleetSecretResolveHostRpcResponse, 'type' | 'requestId'>,
): RemoteFleetBootstrapSecretReadResult {
  switch (result.resultType) {
    case 'resolved':
      if (!('plaintextSecretValue' in result) || typeof result.plaintextSecretValue !== 'string') {
        return { resultType: 'unavailable', secretRefName, secretRef };
      }
      return {
        resultType: 'resolved',
        secretRefName,
        secretRef,
        plaintextSecretValue: result.plaintextSecretValue,
      };
    case 'notFound':
      return { resultType: 'missing', secretRefName };
    case 'accessDenied':
    case 'invalidRequest':
      return { resultType: 'accessDenied', secretRefName, secretRef };
    case 'unavailable':
      return { resultType: 'unavailable', secretRefName, secretRef };
  }
}

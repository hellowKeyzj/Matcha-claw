import type { RuntimeHostLogger } from '../../shared/logger';
import type {
  RuntimeCommandExecutorPort,
  RuntimeHttpClientPort,
  RuntimeTimerPort,
} from '../common/runtime-ports';
import type { RemoteFleetConnectorProviderKind } from './remote-fleet-connectors';
import type {
  RemoteFleetConnectionRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetManagedResourceCleanupPolicy,
  RemoteFleetManagedResourceOwnership,
  RemoteFleetManagedResourceProviderKind,
  RemoteFleetManagedResourceRef,
  RemoteFleetManagedResourceRecord,
  RemoteFleetManagedResourceKind,
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
  RuntimeAgentRecord,
} from './remote-fleet-model';
import type {
  RemoteFleetSecretResolveHostRpcResponse,
  RemoteFleetSecretResolveRequestInput,
} from './remote-fleet-secret-host-rpc';

export const REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION = 'remote-fleet-bootstrap-command/v1' as const;

export type RemoteFleetBootstrapProviderKind = Extract<RemoteFleetConnectorProviderKind, 'ssh' | 'docker' | 'k8s'>;
export type RemoteFleetConnectionProbeProviderKind = 'ssh' | 'docker' | 'k8s' | 'custom';
export type RemoteFleetBootstrapCommandName = 'probe-node' | 'install-agent' | 'deploy-environment' | 'delete-environment';
export type RemoteFleetBootstrapFailureReason =
  | 'unsupported-target'
  | 'invalid-config'
  | 'endpoint-protocol-mismatch'
  | 'missing-secret'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'remote-error'
  | 'unavailable';

export type RemoteFleetConnectionProbeFailureReason =
  | 'unsupported'
  | 'invalid-config'
  | 'endpoint-protocol-mismatch'
  | 'missing-secret'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'remote-error'
  | 'unavailable';

export interface RemoteFleetBootstrapEnrollmentContext {
  readonly agentId: string;
  readonly nodeId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly callbackUrl?: string;
}

export interface RemoteFleetBootstrapCommandEnvelope {
  readonly envelopeVersion: typeof REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandName: RemoteFleetBootstrapCommandName;
  readonly providerKind: RemoteFleetBootstrapProviderKind;
  readonly nodeId: string;
  readonly agentId: string;
  readonly node: RemoteFleetNodeRecord;
  readonly connection?: RemoteFleetConnectionRecord;
  readonly environment?: RemoteFleetEnvironmentRecord;
  readonly managedResource?: RemoteFleetManagedResourceRecord;
  readonly agent: RuntimeAgentRecord;
  /**
   * Ephemeral one-time enrollment token for install-agent only. This DTO may
   * cross the worker/main host bridge, but must never be persisted, logged, or
   * projected to renderer state.
   */
  readonly enrollment?: RemoteFleetBootstrapEnrollmentContext;
}

export const REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION = 'remote-fleet-connection-probe/v1' as const;

export interface RemoteFleetConnectionProbeEnvelope {
  readonly envelopeVersion: typeof REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly providerKind: RemoteFleetConnectionProbeProviderKind;
  readonly connection: RemoteFleetConnectionRecord;
}

export type RemoteFleetConnectionProbeResult =
  | {
      readonly resultType: 'completed';
      readonly commandId: string;
      readonly providerKind: RemoteFleetConnectionProbeProviderKind;
    }
  | {
      readonly resultType: 'failed';
      readonly commandId: string;
      readonly providerKind: RemoteFleetConnectionProbeProviderKind;
      readonly reason: RemoteFleetConnectionProbeFailureReason;
    };

export interface RemoteFleetBootstrapManagedResourceResult {
  readonly providerKind: RemoteFleetManagedResourceProviderKind;
  readonly resourceKind: RemoteFleetManagedResourceKind;
  readonly remoteResourceId: string;
  readonly remoteRefs: readonly RemoteFleetManagedResourceRef[];
  readonly ownership: RemoteFleetManagedResourceOwnership;
  readonly cleanupPolicy: RemoteFleetManagedResourceCleanupPolicy;
  readonly displayName: string;
  readonly labels?: readonly string[];
}

export type RemoteFleetBootstrapCommandResult =
  | {
      readonly resultType: 'completed';
      readonly commandId: string;
      readonly providerKind: RemoteFleetBootstrapProviderKind;
      readonly message?: string;
      readonly outputSummary?: string;
      readonly remoteResourceId?: string;
      readonly managedResources?: readonly RemoteFleetBootstrapManagedResourceResult[];
    }
  | {
      readonly resultType: 'failed';
      readonly commandId: string;
      readonly providerKind?: RemoteFleetBootstrapProviderKind;
      readonly reason: RemoteFleetBootstrapFailureReason;
      readonly message: string;
    };

export interface RemoteFleetBootstrapSecretResolverPort {
  resolveSecret(input: RemoteFleetSecretResolveRequestInput):
    | Promise<RemoteFleetSecretResolveHostRpcResponse | Omit<RemoteFleetSecretResolveHostRpcResponse, 'type' | 'requestId'>>
    | RemoteFleetSecretResolveHostRpcResponse
    | Omit<RemoteFleetSecretResolveHostRpcResponse, 'type' | 'requestId'>;
}

export interface RemoteFleetBootstrapSecretReader {
  readSecret(secretRefName: string): Promise<RemoteFleetBootstrapSecretReadResult>;
  readSecretRef?(secretRef: RemoteFleetSecretRef): Promise<RemoteFleetBootstrapSecretReadResult>;
}

export type RemoteFleetBootstrapSecretReadResult =
  | { readonly resultType: 'resolved'; readonly secretRefName: string; readonly secretRef: RemoteFleetSecretRef; readonly plaintextSecretValue: string }
  | { readonly resultType: 'missing'; readonly secretRefName: string }
  | { readonly resultType: 'accessDenied'; readonly secretRefName: string; readonly secretRef: RemoteFleetSecretRef }
  | { readonly resultType: 'unavailable'; readonly secretRefName: string; readonly secretRef?: RemoteFleetSecretRef };

export interface RemoteFleetBootstrapProviderDeps {
  readonly httpClient?: RuntimeHttpClientPort;
  readonly commandExecutor?: RuntimeCommandExecutorPort;
  readonly timer?: RuntimeTimerPort;
  readonly logger?: Pick<RuntimeHostLogger, 'debug' | 'warn'>;
}

export interface RemoteFleetBootstrapProviderContext extends RemoteFleetBootstrapProviderDeps {
  readonly secrets: RemoteFleetBootstrapSecretReader;
}

export interface RemoteFleetBootstrapProvider {
  readonly providerKind: RemoteFleetBootstrapProviderKind;
  dispatchCommand(
    envelope: RemoteFleetBootstrapCommandEnvelope,
    context: RemoteFleetBootstrapProviderContext,
  ): Promise<RemoteFleetBootstrapCommandResult>;
}

export interface RemoteFleetConnectionProbeProvider {
  readonly providerKind: RemoteFleetConnectionProbeProviderKind;
  probeConnection(
    envelope: RemoteFleetConnectionProbeEnvelope,
    context: RemoteFleetBootstrapProviderContext,
  ): Promise<RemoteFleetConnectionProbeResult>;
}

export interface RemoteFleetBootstrapDispatcherPort {
  dispatchCommand(envelope: RemoteFleetBootstrapCommandEnvelope):
    | Promise<RemoteFleetBootstrapCommandResult>
    | RemoteFleetBootstrapCommandResult;
  probeConnection(envelope: RemoteFleetConnectionProbeEnvelope):
    | Promise<RemoteFleetConnectionProbeResult>
    | RemoteFleetConnectionProbeResult;
}

export interface RemoteFleetBootstrapDispatcherDeps extends RemoteFleetBootstrapProviderDeps {
  readonly secretResolver?: RemoteFleetBootstrapSecretResolverPort;
  readonly providers?: readonly RemoteFleetBootstrapProvider[];
}

export function createRemoteFleetConnectionProbeEnvelope(input: {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly connection: RemoteFleetConnectionRecord;
}): RemoteFleetConnectionProbeEnvelope {
  return {
    envelopeVersion: REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    providerKind: connectionProbeProviderKindForConnectionKind(input.connection.connectionKind),
    connection: input.connection,
  };
}

export function connectionProbeProviderKindForConnectionKind(
  connectionKind: RemoteFleetConnectionRecord['connectionKind'],
): RemoteFleetConnectionProbeProviderKind {
  switch (connectionKind) {
    case 'ssh-host':
      return 'ssh';
    case 'container':
      return 'docker';
    case 'k8s-pod':
      return 'k8s';
    case 'vm':
      return 'ssh';
    case 'custom':
      return 'custom';
  }
}

export function createRemoteFleetBootstrapCommandEnvelope(input: {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly commandName: RemoteFleetBootstrapCommandName;
  readonly node: RemoteFleetNodeRecord;
  readonly connection?: RemoteFleetConnectionRecord;
  readonly environment?: RemoteFleetEnvironmentRecord;
  readonly managedResource?: RemoteFleetManagedResourceRecord;
  readonly agent: RuntimeAgentRecord;
  readonly enrollment?: RemoteFleetBootstrapEnrollmentContext;
}): RemoteFleetBootstrapCommandEnvelope | null {
  const providerKind = bootstrapProviderKindForTargetKind(input.node.targetKind);
  if (!providerKind) return null;

  return {
    envelopeVersion: REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    commandName: input.commandName,
    providerKind,
    nodeId: input.node.id,
    agentId: input.agent.id,
    node: input.node,
    ...(input.connection ? { connection: input.connection } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.managedResource ? { managedResource: input.managedResource } : {}),
    agent: input.agent,
    ...(input.enrollment ? { enrollment: input.enrollment } : {}),
  };
}

export function bootstrapProviderKindForTargetKind(targetKind: RemoteFleetNodeRecord['targetKind']): RemoteFleetBootstrapProviderKind | null {
  switch (targetKind) {
    case 'ssh-host':
    case 'vm':
      return 'ssh';
    case 'container':
      return 'docker';
    case 'k8s-pod':
      return 'k8s';
    case 'custom':
      return null;
  }
}

export function createUnavailableBootstrapResult(
  envelope: Pick<RemoteFleetBootstrapCommandEnvelope, 'commandId' | 'providerKind'>,
  message = 'Remote Fleet bootstrap provider is unavailable.',
): RemoteFleetBootstrapCommandResult {
  return {
    resultType: 'failed',
    commandId: envelope.commandId,
    providerKind: envelope.providerKind,
    reason: 'unavailable',
    message,
  };
}

export function createUnavailableConnectionProbeResult(
  envelope: Pick<RemoteFleetConnectionProbeEnvelope, 'commandId' | 'providerKind'>,
  reason: Extract<RemoteFleetConnectionProbeFailureReason, 'unsupported' | 'unavailable'> = 'unavailable',
): RemoteFleetConnectionProbeResult {
  return {
    resultType: 'failed',
    commandId: envelope.commandId,
    providerKind: envelope.providerKind,
    reason,
  };
}

export function isRemoteFleetConnectionProbeResult(value: unknown): value is RemoteFleetConnectionProbeResult {
  if (!isBootstrapResultRecord(value)) return false;
  if (value.resultType === 'completed') {
    return typeof value.commandId === 'string' && isConnectionProbeProviderKind(value.providerKind);
  }
  return value.resultType === 'failed'
    && typeof value.commandId === 'string'
    && isConnectionProbeProviderKind(value.providerKind)
    && isConnectionProbeFailureReason(value.reason);
}

export function isRemoteFleetBootstrapCommandResult(value: unknown): value is RemoteFleetBootstrapCommandResult {
  if (!isBootstrapResultRecord(value)) return false;
  if (value.resultType === 'completed') {
    return typeof value.commandId === 'string'
      && typeof value.providerKind === 'string'
      && isOptionalManagedResourceResults(value.managedResources);
  }
  return value.resultType === 'failed'
    && typeof value.commandId === 'string'
    && typeof value.reason === 'string'
    && typeof value.message === 'string';
}

function isConnectionProbeProviderKind(value: unknown): value is RemoteFleetConnectionProbeProviderKind {
  return value === 'ssh' || value === 'docker' || value === 'k8s' || value === 'custom';
}

function isConnectionProbeFailureReason(value: unknown): value is RemoteFleetConnectionProbeFailureReason {
  return value === 'unsupported'
    || value === 'invalid-config'
    || value === 'endpoint-protocol-mismatch'
    || value === 'missing-secret'
    || value === 'auth'
    || value === 'network'
    || value === 'timeout'
    || value === 'remote-error'
    || value === 'unavailable';
}

function isOptionalManagedResourceResults(value: unknown): value is readonly RemoteFleetBootstrapManagedResourceResult[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isManagedResourceResult));
}

function isManagedResourceResult(value: unknown): value is RemoteFleetBootstrapManagedResourceResult {
  if (!isBootstrapResultRecord(value) || hasRemoteFleetBootstrapSecretField(value)) return false;
  return typeof value.providerKind === 'string'
    && typeof value.resourceKind === 'string'
    && typeof value.remoteResourceId === 'string'
    && Array.isArray(value.remoteRefs)
    && value.remoteRefs.every(isManagedResourceRef)
    && isBootstrapResultRecord(value.ownership)
    && typeof value.ownership.reason === 'string'
    && isBootstrapResultRecord(value.cleanupPolicy)
    && typeof value.cleanupPolicy.mode === 'string'
    && typeof value.displayName === 'string'
    && (value.labels === undefined || (Array.isArray(value.labels) && value.labels.every((label) => typeof label === 'string')));
}

function isManagedResourceRef(value: unknown): value is RemoteFleetManagedResourceRef {
  if (!isBootstrapResultRecord(value) || hasRemoteFleetBootstrapSecretField(value)) return false;
  return typeof value.providerKind === 'string'
    && typeof value.resourceKind === 'string'
    && typeof value.remoteResourceId === 'string'
    && (value.namespace === undefined || typeof value.namespace === 'string')
    && (value.name === undefined || typeof value.name === 'string');
}

function hasRemoteFleetBootstrapSecretField(value: unknown): boolean {
  if (!isBootstrapResultRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (isRemoteFleetBootstrapSecretFieldName(key)) return true;
    if (Array.isArray(nested)) return nested.some(hasRemoteFleetBootstrapSecretField);
    return isBootstrapResultRecord(nested) && hasRemoteFleetBootstrapSecretField(nested);
  });
}

function isRemoteFleetBootstrapSecretFieldName(fieldName: string): boolean {
  return /plaintext|token|password|privatekey/i.test(fieldName);
}

function isBootstrapResultRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

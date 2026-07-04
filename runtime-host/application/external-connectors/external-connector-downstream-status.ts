import type { SessionIdentity } from '../../shared/runtime-address';
import type { ExternalConnectorSpec } from './external-connector-model';

export type ExternalConnectorDownstreamStatusResultType =
  | 'connected'
  | 'disconnected'
  | 'pending'
  | 'unsupported'
  | 'disabled'
  | 'unknown'
  | 'error';

export interface ExternalConnectorDownstreamStatusDetails {
  readonly serverId?: string;
  readonly sessionKey?: string;
  readonly toolCount?: number;
  readonly launchSummary?: string;
  readonly refreshJobId?: string;
}

export interface ExternalConnectorDownstreamStatus {
  readonly connectorId: string;
  readonly displayName?: string;
  readonly adapterId: string;
  readonly targetKind: 'session';
  readonly resultType: ExternalConnectorDownstreamStatusResultType;
  readonly checkedAt?: string;
  readonly reason?: string;
  readonly details?: ExternalConnectorDownstreamStatusDetails;
}

export interface ExternalConnectorDownstreamStatusContext {
  readonly sessionIdentity: SessionIdentity;
}

export interface ExternalConnectorDownstreamStatusProvider {
  readonly adapterId: string;
  listStatuses(
    connectors: readonly ExternalConnectorSpec[],
    context: ExternalConnectorDownstreamStatusContext,
  ): Promise<readonly ExternalConnectorDownstreamStatus[]>;
}

export function readSessionIdentityPayload(payload: unknown): SessionIdentity | null {
  const body = readRecord(payload);
  const value = readRecord(body.sessionIdentity ?? payload);
  const endpoint = readRecord(value.endpoint);
  const agentId = readTrimmedString(value.agentId);
  const sessionKey = readTrimmedString(value.sessionKey);
  if (!agentId || !sessionKey) {
    return null;
  }

  if (endpoint.kind === 'native-runtime') {
    const runtimeAdapterId = readTrimmedString(endpoint.runtimeAdapterId);
    const runtimeInstanceId = readTrimmedString(endpoint.runtimeInstanceId);
    if (!runtimeAdapterId || !runtimeInstanceId) {
      return null;
    }
    return {
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId,
        runtimeInstanceId,
      },
      agentId,
      sessionKey,
    };
  }

  if (endpoint.kind === 'protocol-connector') {
    const protocolId = readTrimmedString(endpoint.protocolId);
    const connectorId = readTrimmedString(endpoint.connectorId);
    const endpointId = readTrimmedString(endpoint.endpointId);
    if (!protocolId || !connectorId || !endpointId) {
      return null;
    }
    return {
      endpoint: {
        kind: 'protocol-connector',
        protocolId,
        connectorId,
        endpointId,
      },
      agentId,
      sessionKey,
    };
  }

  return null;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

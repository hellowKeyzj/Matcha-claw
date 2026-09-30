import { hostApiFetch } from './host-api';
import { waitForCall } from './call-log-await';
import type { CallReceipt } from '../types/call-log';
import { isCallId } from '../types/call-log/decode';
import { decodeConnectorsCallDetail, type ConnectorsCallDetail } from '../types/call-log/connectors';
import type {
  ExternalConnectorSpec,
  ExternalConnectorUpsertMutationReceipt,
  ExternalConnectorRemoveMutationReceipt,
  ExternalConnectorMutationApplied,
} from '../stores/external-connectors';
import { sessionIdentitiesEqual, type SessionIdentity } from '../types/desktop/runtime-address';
import { isConnectorObservationResult, type ConnectorObservationResult, type ExternalConnectorConnectionStatus, type SessionConnectorStatus } from '../types/connectors-observation';

async function mutate(path: string, body: object, command: string): Promise<ConnectorsCallDetail> {
  const receipt = await hostApiFetch<CallReceipt>(path, { method: 'POST', body: JSON.stringify(body) });
  validateReceipt(receipt);
  const call = await waitForCall(receipt, 'connectors');
  if (call.module !== 'connectors' || call.command !== command) throw new Error('Connector call identity is invalid');
  const detail = decodeConnectorsCallDetail(call.detail);
  if (detail.result === 'unknown') throw new Error('External connector mutation outcome is unknown; reopen before retrying');
  if (detail.result === 'missing') throw new Error('External connector is unknown');
  if (detail.result === 'rejected') throw new Error('External connector request was rejected');
  if (detail.result === 'unavailable') throw new Error('External connectors are unavailable');
  return detail;
}

function validateReceipt(receipt: CallReceipt): void {
  if (receipt === null || typeof receipt !== 'object' || Object.keys(receipt).length !== 2
    || receipt.accepted !== true || !isCallId(receipt.callId)) {
    throw new Error('Connector admission receipt is invalid');
  }
}

async function observe(request: { kind: 'status' } | { kind: 'probe'; connectorId: string } | { kind: 'sessionStatus'; sessionIdentity: SessionIdentity }): Promise<ConnectorObservationResult> {
  const { kind } = request;
  const receipt = await hostApiFetch<CallReceipt>(`/api/external-connectors/${kind === 'sessionStatus' ? 'session-status' : kind}`, kind === 'probe'
    ? { method: 'POST', body: JSON.stringify({ connectorId: request.connectorId }) }
    : kind === 'sessionStatus' ? { method: 'POST', body: JSON.stringify({ sessionIdentity: request.sessionIdentity }) } : undefined);
  validateReceipt(receipt);
  const call = await waitForCall(receipt, 'connectors');
  if (call.module !== 'connectors' || call.command !== `externalConnectors.${kind}`) throw new Error('Connector call identity is invalid');
  const detail = decodeConnectorsCallDetail(call.detail);
  if (request.kind === 'probe' && detail.connectorId !== request.connectorId) throw new Error('Connector probe identity is invalid');
  if (call.status === 'unknown') throw new Error('Connector observation outcome is unknown; do not retry automatically');
  if (detail.result === 'missing') throw new Error('External connector is unknown');
  if (call.status !== 'succeeded' || detail.result !== 'available') throw new Error('Connector observation is unavailable');
  const result = await hostApiFetch<unknown>('/api/external-connectors/observation-result', {
    method: 'POST', body: JSON.stringify({
      callId: receipt.callId,
      ...(request.kind === 'sessionStatus' ? { sessionIdentity: request.sessionIdentity } : {}),
    }),
  });
  if (!isConnectorObservationResult(result) || result.callId !== receipt.callId || result.kind !== kind
    || (result.kind === 'probe' && request.kind === 'probe' && result.status.connectorId !== request.connectorId)
    || (result.kind === 'sessionStatus' && request.kind === 'sessionStatus' && !sessionIdentitiesEqual(result.sessionIdentity, request.sessionIdentity))
    || (result.kind !== 'probe' && result.statuses.length !== detail.count)) {
    throw new Error('Connector observation result is invalid');
  }
  return result;
}

export async function readConnectorStatuses(): Promise<ExternalConnectorConnectionStatus[]> {
  const result = await observe({ kind: 'status' });
  if (result.kind !== 'status') throw new Error('Connector status result is invalid');
  return result.statuses;
}

export async function probeConnector(connectorId: string): Promise<ExternalConnectorConnectionStatus> {
  const result = await observe({ kind: 'probe', connectorId });
  if (result.kind !== 'probe') throw new Error('Connector probe result is invalid');
  return result.status;
}

export async function readSessionConnectorStatuses(sessionIdentity: SessionIdentity): Promise<SessionConnectorStatus[]> {
  const result = await observe({ kind: 'sessionStatus', sessionIdentity });
  if (result.kind !== 'sessionStatus') throw new Error('Connector session status result is invalid');
  return result.statuses;
}

function applied(detail: ConnectorsCallDetail): ExternalConnectorMutationApplied {
  if (detail.projection === 'written' && typeof detail.changed === 'boolean') {
    return { status: 'written', changed: detail.changed };
  }
  if (detail.projection === 'unknown' || detail.projection === 'unavailable') return { status: detail.projection };
  throw new Error('Connector projection receipt is invalid');
}

export async function upsertConnector(connector: ExternalConnectorSpec): Promise<ExternalConnectorUpsertMutationReceipt> {
  const detail = await mutate('/api/external-connectors/upsert', { connector }, 'externalConnectors.upsert');
  if (detail.result !== 'stored' || detail.connectorId !== connector.id || detail.revision === undefined || detail.created === undefined) {
    throw new Error('Connector store receipt is invalid');
  }
  const fact = await hostApiFetch<{ connector: ExternalConnectorSpec }>('/api/external-connectors/get', {
    method: 'POST', body: JSON.stringify({ connectorId: connector.id }),
  });
  return {
    success: true,
    connector: fact.connector,
    resultType: detail.created ? 'created' : 'updated',
    desired: { status: 'stored', revision: detail.revision },
    applied: applied(detail),
    observed: { status: 'not-observed' },
  };
}

export async function removeConnector(connectorId: string): Promise<ExternalConnectorRemoveMutationReceipt> {
  const detail = await mutate('/api/external-connectors/remove', { connectorId }, 'externalConnectors.remove');
  if (detail.result !== 'removed' || detail.connectorId !== connectorId || detail.revision === undefined || detail.tombstoned !== true) {
    throw new Error('Connector removal receipt is invalid');
  }
  return {
    success: true,
    desired: { status: 'removed', revision: detail.revision },
    applied: applied(detail),
    observed: { status: 'not-observed' },
  };
}

export async function setSessionMcpServerEnabled(sessionIdentity: SessionIdentity, serverId: string, enabled: boolean): Promise<void> {
  const detail = await mutate('/api/external-connectors/session-mcp-server-enabled', { sessionIdentity, serverId, enabled }, 'externalConnectors.sessionMcpServerEnabled');
  if (detail.result !== 'applied-next-run' || detail.serverId !== serverId || detail.enabled !== enabled) {
    throw new Error('Connector session enablement receipt is invalid');
  }
}

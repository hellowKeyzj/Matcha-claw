import { hostApiFetch } from '@/lib/host-api';
import { waitForCall } from '@/lib/call-log-await';
import type { CallReceipt } from '@/types/call-log';
import { isCallId } from '@/types/call-log/decode';
import { decodeConnectorsCallDetail, type ConnectorsCallDetail } from '@/types/call-log/connectors';
import type {
  ExternalConnectorSpec,
  ExternalConnectorSummary,
  ExternalConnectorPatch,
  ExternalConnectorUpsertMutationReceipt,
  ExternalConnectorRemoveMutationReceipt,
  ExternalConnectorMutationApplied,
} from '../types';
import { sessionIdentitiesEqual, runtimeScopeQuery, type RuntimeInstanceScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import { isConnectorObservationResult, type ConnectorObservationResult, type ExternalConnectorConnectionStatus, type SessionConnectorStatus } from '@/types/connectors-observation';
import { isConnectorOAuthInput, type ConnectorOAuthInput, type McpOAuthReceipt } from '@/types/connectors-oauth';

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

async function observe(request: { kind: 'status'; scope: RuntimeInstanceScope } | { kind: 'probe'; connectorId: string; scope: RuntimeInstanceScope } | { kind: 'sessionStatus'; sessionIdentity: SessionIdentity } | (ConnectorOAuthInput & { kind: 'oauth'; scope: RuntimeInstanceScope }), signal?: AbortSignal): Promise<ConnectorObservationResult> {
  const { kind } = request;
  const path = `/api/external-connectors/${kind === 'sessionStatus' ? 'session-status' : kind}${request.kind === 'status' ? `?${runtimeScopeQuery(request.scope)}` : ''}`;
  const body = request.kind === 'probe' ? { connectorId: request.connectorId, scope: request.scope }
    : request.kind === 'sessionStatus' ? { sessionIdentity: request.sessionIdentity }
    : request.kind === 'oauth' ? { connectorId: request.connectorId, scope: request.scope, action: request.action,
      ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
      ...(request.flowId === undefined ? {} : { flowId: request.flowId }) } : undefined;
  const receipt = await hostApiFetch<CallReceipt>(path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal });
  validateReceipt(receipt);
  const call = await waitForCall(receipt, 'connectors', { signal });
  if (call.module !== 'connectors' || call.command !== `externalConnectors.${kind}`) throw new Error('Connector call identity is invalid');
  const detail = decodeConnectorsCallDetail(call.detail);
  if ((request.kind === 'probe' || request.kind === 'oauth') && detail.connectorId !== request.connectorId) throw new Error('Connector observation identity is invalid');
  if (call.status === 'unknown') throw new Error('Connector observation outcome is unknown; do not retry automatically');
  if (detail.result === 'missing') throw new Error('External connector is unknown');
  if (call.status !== 'succeeded' || detail.result !== 'available') throw new Error('Connector observation is unavailable');
  const result = await hostApiFetch<unknown>('/api/external-connectors/observation-result', {
    method: 'POST', signal, body: JSON.stringify({
      callId: receipt.callId,
      ...(request.kind === 'sessionStatus' ? { sessionIdentity: request.sessionIdentity } : { scope: request.scope }),
      ...(request.kind === 'oauth' && request.agentId !== undefined ? { agentId: request.agentId } : {}),
    }),
  });
  if (!isConnectorObservationResult(result) || result.callId !== receipt.callId || result.kind !== kind
    || (result.kind === 'probe' && request.kind === 'probe' && result.status.connectorId !== request.connectorId)
    || (result.kind === 'oauth' && request.kind === 'oauth' && result.connectorId !== request.connectorId)
    || (result.kind === 'sessionStatus' && request.kind === 'sessionStatus' && !sessionIdentitiesEqual(result.sessionIdentity, request.sessionIdentity))
    || ((result.kind === 'status' || result.kind === 'sessionStatus') && result.statuses.length !== detail.count)) {
    throw new Error('Connector observation result is invalid');
  }
  return result;
}

export async function requestConnectorOAuth(scope: RuntimeInstanceScope, input: ConnectorOAuthInput, signal?: AbortSignal): Promise<McpOAuthReceipt> {
  if (!isConnectorOAuthInput(input) || scope.endpoint.kind !== 'native-runtime'
    || !['openclaw', 'matcha-agent'].includes(scope.endpoint.runtimeAdapterId)
    || (scope.endpoint.runtimeAdapterId === 'matcha-agent' ? !input.agentId : input.agentId !== undefined)) {
    throw new Error('Connector OAuth target is invalid');
  }
  const result = await observe({ ...input, kind: 'oauth', scope }, signal);
  if (result.kind !== 'oauth') throw new Error('Connector OAuth result is invalid');
  return result.oauth;
}

export async function readConnectorStatuses(scope: RuntimeInstanceScope): Promise<ExternalConnectorConnectionStatus[]> {
  const result = await observe({ kind: 'status', scope });
  if (result.kind !== 'status') throw new Error('Connector status result is invalid');
  return result.statuses;
}

export async function probeConnector(scope: RuntimeInstanceScope, connectorId: string): Promise<ExternalConnectorConnectionStatus> {
  const result = await observe({ kind: 'probe', connectorId, scope });
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
  return storedConnector(connector.id, detail);
}

export async function updateConnector(connectorId: string, patch: ExternalConnectorPatch): Promise<ExternalConnectorUpsertMutationReceipt> {
  const detail = await mutate('/api/external-connectors/update', { connectorId, patch }, 'externalConnectors.update');
  if (detail.created !== false) throw new Error('Connector update receipt is invalid');
  return storedConnector(connectorId, detail);
}

async function storedConnector(connectorId: string, detail: ConnectorsCallDetail): Promise<ExternalConnectorUpsertMutationReceipt> {
  if (detail.result !== 'stored' || detail.connectorId !== connectorId || detail.revision === undefined || detail.created === undefined) {
    throw new Error('Connector store receipt is invalid');
  }
  const fact = await hostApiFetch<{ connector: ExternalConnectorSummary }>('/api/external-connectors/get', {
    method: 'POST', body: JSON.stringify({ connectorId }),
  });
  if (fact.connector.id !== connectorId) throw new Error('Connector readback identity is invalid');
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

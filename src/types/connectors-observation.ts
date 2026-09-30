import { validateSessionIdentity, type SessionIdentity } from './desktop/runtime-address';

export type ExternalConnectorConnectionStatusResultType = 'connected' | 'disconnected' | 'unsupported' | 'disabled' | 'unknown';

export type SessionConnectorStatusResultType = ExternalConnectorConnectionStatusResultType | 'pending';

export interface SessionConnectorStatusDetails {
  readonly serverId?: string;
  readonly sessionKey?: string;
  readonly toolCount?: number;
  readonly launchSummary?: string;
  readonly enabledNextRun?: boolean;
  readonly enabledConfigurable?: boolean;
}

export interface SessionConnectorStatus {
  readonly connectorId: string;
  readonly displayName?: string;
  readonly adapterId: string;
  readonly targetKind: 'session';
  readonly resultType: SessionConnectorStatusResultType;
  readonly checkedAt?: string;
  readonly reason?: string;
  readonly details?: SessionConnectorStatusDetails;
}

export interface ExternalConnectorConnectionStatus {
  readonly connectorId: string;
  readonly resultType: ExternalConnectorConnectionStatusResultType;
  readonly checkedAt?: string;
  readonly latencyMs?: number;
  readonly reason?: string;
  readonly safeProbe: boolean;
}

export type ConnectorObservationResult =
  | { callId: string; kind: 'status'; statuses: ExternalConnectorConnectionStatus[] }
  | { callId: string; kind: 'probe'; status: ExternalConnectorConnectionStatus }
  | { callId: string; kind: 'sessionStatus'; sessionIdentity: SessionIdentity; statuses: SessionConnectorStatus[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isStatus(value: unknown): value is ExternalConnectorConnectionStatus {
  return record(value)
    && Object.keys(value).every((key) => ['connectorId', 'resultType', 'latencyMs', 'reason', 'safeProbe'].includes(key))
    && typeof value.connectorId === 'string' && value.connectorId.trim().length > 0 && value.connectorId.length <= 128
    && ['connected', 'disconnected', 'disabled', 'unsupported', 'unknown'].includes(value.resultType as string)
    && (value.latencyMs === undefined || (typeof value.latencyMs === 'number' && Number.isFinite(value.latencyMs) && value.latencyMs >= 0))
    && (value.reason === undefined || (typeof value.reason === 'string' && value.reason.trim().length > 0))
    && typeof value.safeProbe === 'boolean';
}

function isSessionStatus(value: unknown): value is SessionConnectorStatus {
  return record(value)
    && Object.keys(value).every((key) => ['connectorId', 'displayName', 'adapterId', 'targetKind', 'resultType', 'reason', 'details'].includes(key))
    && typeof value.connectorId === 'string' && value.connectorId.trim().length > 0 && value.connectorId.length <= 128
    && optionalText(value.displayName)
    && value.adapterId === 'openclaw'
    && value.targetKind === 'session'
    && ['connected', 'disconnected', 'pending', 'unsupported', 'disabled', 'unknown'].includes(value.resultType as string)
    && optionalText(value.reason)
    && (value.details === undefined || (record(value.details)
      && Object.keys(value.details).every((key) => ['serverId', 'toolCount', 'launchSummary', 'enabledNextRun', 'enabledConfigurable'].includes(key))
      && optionalText(value.details.serverId)
      && (value.details.toolCount === undefined || (typeof value.details.toolCount === 'number' && Number.isSafeInteger(value.details.toolCount) && value.details.toolCount >= 0))
      && optionalText(value.details.launchSummary)
      && (value.details.enabledNextRun === undefined || typeof value.details.enabledNextRun === 'boolean')
      && (value.details.enabledConfigurable === undefined || typeof value.details.enabledConfigurable === 'boolean')));
}

function optionalText(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0);
}

export function isConnectorObservationResult(value: unknown): value is ConnectorObservationResult {
  return record(value) && typeof value.callId === 'string' && /^[a-f0-9]{32}$/.test(value.callId)
    && ((value.kind === 'status' && keys(value, ['callId', 'kind', 'statuses'])
      && Array.isArray(value.statuses) && value.statuses.every(isStatus))
    || (value.kind === 'probe' && keys(value, ['callId', 'kind', 'status']) && isStatus(value.status))
    || (value.kind === 'sessionStatus' && keys(value, ['callId', 'kind', 'sessionIdentity', 'statuses'])
      && !validateSessionIdentity(value.sessionIdentity)
      && Array.isArray(value.statuses) && value.statuses.every(isSessionStatus)));
}

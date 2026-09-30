import type { CallDetailByModule } from '../call-log';

export type ConnectorCallResult = 'available' | 'found' | 'missing' | 'stored' | 'removed' | 'rejected' | 'unknown' | 'unavailable' | 'applied-next-run';
export type ConnectorObservationStatus = 'connected' | 'disconnected' | 'disabled' | 'unsupported' | 'unknown';
export type ConnectorSessionServerState =
  | 'disabled-by-configuration' | 'missing-from-native-status' | 'native-status-unavailable'
  | 'native-disabled' | 'native-not-connected' | 'native-listing-tools' | 'native-stale-config'
  | 'native-connected' | 'native-disconnected' | 'native-error' | 'native-enabled-false'
  | 'native-available' | 'native-pending';

export interface ConnectorsCallDetail {
  connectorId?: string;
  serverId?: string;
  enabled?: boolean;
  revision?: number;
  appliedRevision?: number;
  tombstoned?: boolean;
  created?: boolean;
  projection?: 'written' | 'unknown' | 'unavailable';
  changed?: boolean;
  result?: ConnectorCallResult;
  count?: number;
  observations?: { connectorId: string; resultType: ConnectorObservationStatus }[];
  servers?: {
    serverId: string;
    state: ConnectorSessionServerState;
    resultType: ConnectorObservationStatus | 'pending';
    toolCount: number | null;
    enabledNextRun: boolean;
    enabledConfigurable: boolean;
  }[];
  summariesTruncated: boolean;
}

declare module '../call-log' {
  interface CallDetailByModule {
    connectors: ConnectorsCallDetail;
  }
}

const results: readonly string[] = ['available', 'found', 'missing', 'stored', 'removed', 'rejected', 'unknown', 'unavailable', 'applied-next-run'];
const observations: readonly string[] = ['connected', 'disconnected', 'disabled', 'unsupported', 'unknown'];
const states: readonly string[] = ['disabled-by-configuration', 'missing-from-native-status', 'native-status-unavailable', 'native-disabled', 'native-not-connected', 'native-listing-tools', 'native-stale-config', 'native-connected', 'native-disconnected', 'native-error', 'native-enabled-false', 'native-available', 'native-pending'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value);
}

function integer(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function decodeConnectorsCallDetail(value: unknown): CallDetailByModule['connectors'] {
  if (!record(value)
    || !keys(value, ['connectorId', 'serverId', 'enabled', 'revision', 'appliedRevision', 'tombstoned', 'created', 'projection', 'changed', 'result', 'count', 'observations', 'servers', 'summariesTruncated'])
    || !['connectorId', 'serverId'].every((key) => value[key] === undefined || text(value[key]))
    || !['enabled', 'tombstoned', 'created', 'changed'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    || !['revision', 'appliedRevision', 'count'].every((key) => value[key] === undefined || integer(value[key]))
    || (value.projection !== undefined && !['written', 'unknown', 'unavailable'].includes(value.projection as string))
    || (value.result !== undefined && !results.includes(value.result as string))
    || typeof value.summariesTruncated !== 'boolean'
    || (value.observations !== undefined && (!Array.isArray(value.observations) || value.observations.length > 16 || !value.observations.every((item) => record(item)
      && keys(item, ['connectorId', 'resultType']) && text(item.connectorId) && observations.includes(item.resultType as string))))
    || (value.servers !== undefined && (!Array.isArray(value.servers) || value.servers.length > 8 || !value.servers.every((item) => record(item)
      && keys(item, ['serverId', 'state', 'resultType', 'toolCount', 'enabledNextRun', 'enabledConfigurable'])
      && text(item.serverId) && states.includes(item.state as string)
      && (observations.includes(item.resultType as string) || item.resultType === 'pending')
      && (item.toolCount === null || integer(item.toolCount))
      && typeof item.enabledNextRun === 'boolean' && typeof item.enabledConfigurable === 'boolean')))) {
    throw new Error('Connector call detail is invalid');
  }
  return value as unknown as ConnectorsCallDetail;
}

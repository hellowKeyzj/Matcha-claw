export type McpOAuthAction = 'start' | 'status' | 'logout';
export type McpOAuthState = 'authorization-required' | 'authorizing' | 'authorized' | 'unauthenticated' | 'connected' | 'failed' | 'unavailable' | 'unknown';

export interface McpOAuthReceipt {
  readonly state: McpOAuthState;
  readonly authorizationUrl?: string;
  readonly flowId?: string;
}

export interface ConnectorOAuthObservation {
  readonly callId: string;
  readonly kind: 'oauth';
  readonly connectorId: string;
  readonly oauth: McpOAuthReceipt;
}

export interface ConnectorOAuthInput {
  readonly connectorId: string;
  readonly action: McpOAuthAction;
  readonly agentId?: string;
  readonly flowId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}

function authorizationUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 16_384) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && ![...url.searchParams.keys()].some((key) => /^(?:access_token|refresh_token|id_token|client_secret|password|code)$/i.test(key));
  } catch { return false; }
}

export function isMcpOAuthReceipt(value: unknown): value is McpOAuthReceipt {
  return record(value) && Object.keys(value).every((key) => ['state', 'authorizationUrl', 'flowId'].includes(key))
    && ['authorization-required', 'authorizing', 'authorized', 'unauthenticated', 'connected', 'failed', 'unavailable', 'unknown'].includes(value.state as string)
    && (value.flowId === undefined || identity(value.flowId))
    && (value.authorizationUrl === undefined || (value.state === 'authorizing' && authorizationUrl(value.authorizationUrl)));
}

export function isConnectorOAuthInput(value: unknown): value is ConnectorOAuthInput {
  return record(value) && Object.keys(value).every((key) => ['kind', 'connectorId', 'action', 'agentId', 'flowId'].includes(key))
    && typeof value.connectorId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.connectorId)
    && ['start', 'status', 'logout'].includes(value.action as string)
    && (value.agentId === undefined || (typeof value.agentId === 'string' && value.agentId.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value.agentId)))
    && (value.flowId === undefined || (value.action !== 'start' && identity(value.flowId)));
}

export function isConnectorOAuthObservation(value: unknown): value is ConnectorOAuthObservation {
  return record(value) && Object.keys(value).length === 4
    && Object.keys(value).every((key) => ['callId', 'kind', 'connectorId', 'oauth'].includes(key))
    && typeof value.callId === 'string' && /^[a-f0-9]{32}$/.test(value.callId)
    && value.kind === 'oauth' && typeof value.connectorId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.connectorId)
    && isMcpOAuthReceipt(value.oauth);
}

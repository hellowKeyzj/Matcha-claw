import type {
  RemoteFleetConnectionRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetNodeRecord,
  RemoteFleetNodeTargetKind,
  RemoteFleetTerminalSessionSummary,
  RemoteRuntimeEndpointRecord,
  RuntimeInstanceRecord,
} from './remote-fleet-model';
import type { RemoteFleetConnectorProviderKind } from './remote-fleet-connectors';

export const REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_METHOD = 'host.remoteFleetTerminal.issueTicket' as const;
export const REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE = 'host.remoteFleetTerminal.issueTicket.result' as const;
export const REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_METHOD = 'host.remoteFleetTerminal.closeSession' as const;
export const REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE = 'host.remoteFleetTerminal.closeSession.result' as const;
export const REMOTE_FLEET_TERMINAL_STREAM_PATH = '/api/remote-fleet/terminal/stream' as const;
export const REMOTE_FLEET_TERMINAL_TICKET_TTL_MS = 30_000;
export const REMOTE_FLEET_TERMINAL_TICKET_RANDOM_BYTES = 32;

export type RemoteFleetTerminalIssueTicketReason = 'open' | 'reconnect';
export type RemoteFleetTerminalProviderKind = RemoteFleetConnectorProviderKind;

export interface RemoteFleetTerminalConnection {
  readonly sessionId: string;
  readonly ticket: string;
  readonly websocketPath: string;
  readonly expiresAt: string;
}

export interface RemoteFleetTerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface RemoteFleetTerminalSessionTarget {
  readonly session: RemoteFleetTerminalSessionSummary;
  readonly node?: RemoteFleetNodeRecord;
  readonly connection?: RemoteFleetConnectionRecord;
  readonly environment?: RemoteFleetEnvironmentRecord;
  readonly runtime?: RuntimeInstanceRecord;
  readonly endpoint?: RemoteRuntimeEndpointRecord;
  readonly providerKind?: RemoteFleetTerminalProviderKind;
  readonly size?: RemoteFleetTerminalSize;
}

export interface RemoteFleetTerminalIssueTicketRequestInput extends RemoteFleetTerminalSessionTarget {
  readonly reason: RemoteFleetTerminalIssueTicketReason;
  readonly nowIso: string;
}

export type RemoteFleetTerminalIssueTicketHostRpcRequest = {
  readonly type: typeof REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_METHOD;
  readonly requestId: string;
  readonly input: RemoteFleetTerminalIssueTicketRequestInput;
};

export type RemoteFleetTerminalIssueTicketHostRpcResponse =
  | {
      readonly type: typeof REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'issued';
      readonly terminalConnection: RemoteFleetTerminalConnection;
    }
  | {
      readonly type: typeof REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'unavailable';
      readonly message?: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'failed' | 'invalidRequest';
      readonly message: string;
    };

export interface RemoteFleetTerminalCloseSessionRequestInput {
  readonly session: RemoteFleetTerminalSessionSummary;
  readonly nowIso: string;
  readonly reason?: string;
}

export type RemoteFleetTerminalCloseSessionHostRpcRequest = {
  readonly type: typeof REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_METHOD;
  readonly requestId: string;
  readonly input: RemoteFleetTerminalCloseSessionRequestInput;
};

export type RemoteFleetTerminalCloseSessionHostRpcResponse =
  | {
      readonly type: typeof REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'closed';
    }
  | {
      readonly type: typeof REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'unavailable';
      readonly message?: string;
    }
  | {
      readonly type: typeof REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE;
      readonly requestId: string;
      readonly resultType: 'failed' | 'invalidRequest';
      readonly message: string;
    };

export type RemoteFleetTerminalControlFrame =
  | { readonly type: 'terminal.ready'; readonly sessionId: string }
  | { readonly type: 'terminal.resize'; readonly rows: number; readonly cols: number }
  | { readonly type: 'terminal.close'; readonly reason?: string }
  | { readonly type: 'terminal.exit'; readonly sessionId: string; readonly exitCode?: number; readonly signal?: string }
  | { readonly type: 'terminal.error'; readonly sessionId?: string; readonly message: string }
  | { readonly type: 'terminal.ping'; readonly nonce?: string }
  | { readonly type: 'terminal.pong'; readonly nonce?: string };

export type RemoteFleetTerminalSessionValidationResult =
  | { readonly resultType: 'valid' }
  | { readonly resultType: 'invalidRequest'; readonly message: string };

export function isRemoteFleetTerminalStreamPath(pathname: string): boolean {
  return pathname === REMOTE_FLEET_TERMINAL_STREAM_PATH;
}

export function buildRemoteFleetTerminalStreamPath(input: {
  readonly sessionId: string;
  readonly ticket: string;
}): string {
  const params = new URLSearchParams({ sessionId: input.sessionId, ticket: input.ticket });
  return `${REMOTE_FLEET_TERMINAL_STREAM_PATH}?${params.toString()}`;
}

export function defaultRemoteFleetTerminalProviderKindForTargetKind(
  targetKind: RemoteFleetNodeTargetKind,
): RemoteFleetTerminalProviderKind {
  switch (targetKind) {
    case 'ssh-host':
      return 'ssh';
    case 'container':
      return 'docker';
    case 'vm':
      return 'vm';
    case 'k8s-pod':
      return 'k8s';
    case 'custom':
      return 'custom';
  }
}

export function resolveRemoteFleetTerminalProviderKind(input: {
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly providerKind?: RemoteFleetTerminalProviderKind;
}): RemoteFleetTerminalProviderKind {
  return input.providerKind ?? defaultRemoteFleetTerminalProviderKindForTargetKind(input.targetKind);
}

export function validateRemoteFleetTerminalSessionTarget(
  input: RemoteFleetTerminalSessionTarget,
): RemoteFleetTerminalSessionValidationResult {
  if (!input || typeof input !== 'object') {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal session input is required.' };
  }
  if (!isNonEmptyString(input.session?.id)) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal session id is required.' };
  }
  if (!isNonEmptyString(input.session.nodeId) || !isRemoteFleetTerminalTargetKind(input.session.targetKind)) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal session target is required.' };
  }
  if (!input.node) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal node details are required.' };
  }
  if (input.node.id !== input.session.nodeId) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal node does not match the session.' };
  }
  if (input.runtime && input.session.runtimeId && input.runtime.id !== input.session.runtimeId) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal runtime does not match the session.' };
  }
  if (input.endpoint && input.session.endpointId && input.endpoint.id !== input.session.endpointId) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal endpoint does not match the session.' };
  }
  if (input.providerKind !== undefined && !isRemoteFleetTerminalProviderKind(input.providerKind)) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal providerKind is invalid.' };
  }
  if (input.size && !isValidTerminalSize(input.size)) {
    return { resultType: 'invalidRequest', message: 'Remote Fleet terminal size is invalid.' };
  }
  return { resultType: 'valid' };
}

export function isValidTerminalSize(input: RemoteFleetTerminalSize): boolean {
  return Number.isInteger(input.rows)
    && Number.isInteger(input.cols)
    && input.rows >= 1
    && input.rows <= 1000
    && input.cols >= 1
    && input.cols <= 1000;
}

export function normalizeTerminalSize(input: RemoteFleetTerminalSize | undefined): RemoteFleetTerminalSize {
  if (input && isValidTerminalSize(input)) {
    return input;
  }
  return { rows: 24, cols: 80 };
}

export function isRemoteFleetTerminalProviderKind(value: unknown): value is RemoteFleetTerminalProviderKind {
  return value === 'ssh'
    || value === 'docker'
    || value === 'vm'
    || value === 'k8s'
    || value === 'custom';
}

function isRemoteFleetTerminalTargetKind(value: unknown): value is RemoteFleetNodeTargetKind {
  return value === 'ssh-host'
    || value === 'container'
    || value === 'vm'
    || value === 'k8s-pod'
    || value === 'custom';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

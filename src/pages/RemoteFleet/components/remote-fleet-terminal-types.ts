import type {
  RemoteFleetEndpointSummary,
  RemoteFleetNodeSummary,
  RemoteFleetRuntimeSummary,
  RemoteFleetTerminalOpenTarget,
  RemoteFleetTerminalSessionSummary,
  RemoteFleetTerminalSize,
} from '@/stores/remote-fleet';

export type RemoteFleetTerminalTargetKind = 'node' | 'runtime' | 'endpoint';

export interface RemoteFleetTerminalDrawerTarget {
  readonly kind: RemoteFleetTerminalTargetKind;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly unavailableReason?: string;
  readonly openTarget: RemoteFleetTerminalOpenTarget;
}

export type RemoteFleetTerminalConnectionStatus =
  | 'idle'
  | 'opening'
  | 'connecting'
  | 'ready'
  | 'closed'
  | 'exited'
  | 'error';

export type RemoteFleetTerminalErrorKind =
  | 'open-failed'
  | 'connection-failed'
  | 'remote-error'
  | 'reconnect-failed';

export interface RemoteFleetTerminalStatusSnapshot {
  readonly status: RemoteFleetTerminalConnectionStatus;
  readonly errorKind?: RemoteFleetTerminalErrorKind;
  readonly session?: RemoteFleetTerminalSessionSummary;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface RemoteFleetTerminalControlFrame {
  readonly type: string;
  readonly sessionId?: string;
  readonly rows?: number;
  readonly cols?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly nonce?: string;
}

export interface RemoteFleetTerminalConnectionRequest {
  readonly target: RemoteFleetTerminalDrawerTarget;
  readonly size?: RemoteFleetTerminalSize;
}

export interface RemoteFleetTerminalInventory {
  readonly nodes: readonly RemoteFleetNodeSummary[];
  readonly runtimes: readonly RemoteFleetRuntimeSummary[];
  readonly endpoints: readonly RemoteFleetEndpointSummary[];
}

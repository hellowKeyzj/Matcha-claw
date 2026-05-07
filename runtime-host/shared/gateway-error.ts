export type GatewayIssueSource =
  | 'connect'
  | 'rpc'
  | 'socket-close'
  | 'heartbeat-timeout'
  | 'runtime';

export interface GatewayTransportIssue {
  readonly message: string;
  readonly source: GatewayIssueSource;
  readonly at: number;
  readonly code?: string;
  readonly details?: unknown;
}

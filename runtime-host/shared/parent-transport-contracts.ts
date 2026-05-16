export type ParentShellAction =
  | 'shell_open_path'
  | 'gateway_restart'
  | 'host_diagnostics_snapshot'
  | 'provider_oauth_start'
  | 'provider_oauth_cancel'
  | 'provider_oauth_submit';

export type ParentGatewayForwardEventName =
  | 'gateway:lifecycle'
  | 'gateway:notification'
  | 'session:update'
  | 'task:snapshot'
  | 'gateway:channel-status'
  | 'gateway:error';

export type ParentRuntimeJobForwardEventName =
  | 'runtime-job:done'
  | 'runtime-job:progress';

export interface ParentTransportErrorPayload {
  code: string;
  message: string;
}

export interface ParentTransportSuccessPayload {
  version: number;
  success: true;
  status: number;
  data: unknown;
}

export interface ParentTransportFailurePayload {
  version: number;
  success: false;
  status: number;
  error: ParentTransportErrorPayload;
}

export type ParentTransportUpstreamPayload =
  | ParentTransportSuccessPayload
  | ParentTransportFailurePayload;

import { DISPATCH_TIMEOUT_MS, TRANSPORT_VERSION } from '../common/constants';

interface ParentTransportClientOptions {
  parentApiBaseUrl: string;
  parentDispatchToken: string;
}

export type ParentExecutionSyncAction =
  | 'set_execution_enabled'
  | 'restart_runtime_host';

export type ParentShellAction =
  | 'shell_open_path'
  | 'gateway_restart'
  | 'provider_oauth_start'
  | 'provider_oauth_cancel'
  | 'provider_oauth_submit'
  | 'channel_whatsapp_start'
  | 'channel_whatsapp_cancel'
  | 'channel_openclaw_weixin_start'
  | 'channel_openclaw_weixin_cancel'
  | 'license_get_gate'
  | 'license_get_stored_key'
  | 'license_validate'
  | 'license_revalidate'
  | 'license_clear';

export type ParentGatewayForwardEventName =
  | 'gateway:notification'
  | 'gateway:conversation-event'
  | 'gateway:channel-status'
  | 'gateway:error'
  | 'gateway:connection';

interface ParentTransportErrorPayload {
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

interface ParentTransportResponse {
  status: number;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseParentTransportPayload(body: unknown, httpStatus: number): ParentTransportUpstreamPayload {
  if (!isRecord(body)) {
    throw new Error(`Invalid parent transport response: body must be object (HTTP ${String(httpStatus)})`);
  }

  if (body.version !== TRANSPORT_VERSION) {
    throw new Error(
      `Invalid parent transport response: version mismatch ${String(body.version)} (expected ${String(TRANSPORT_VERSION)})`,
    );
  }

  if (typeof body.status !== 'number' || !Number.isFinite(body.status)) {
    throw new Error('Invalid parent transport response: status must be number');
  }

  if (body.success === true) {
    return {
      version: TRANSPORT_VERSION,
      success: true,
      status: body.status,
      data: body.data,
    };
  }

  if (body.success === false) {
    if (!isRecord(body.error) || typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
      throw new Error('Invalid parent transport response: failure.error must contain code/message');
    }
    return {
      version: TRANSPORT_VERSION,
      success: false,
      status: body.status,
      error: {
        code: body.error.code,
        message: body.error.message,
      },
    };
  }

  throw new Error('Invalid parent transport response: success must be boolean');
}

export function createParentTransportClient(options: ParentTransportClientOptions) {
  const { parentApiBaseUrl, parentDispatchToken } = options;

  async function requestParentTransport(
    endpointPath: string,
    action: ParentShellAction | ParentExecutionSyncAction,
    payload?: unknown,
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${parentApiBaseUrl}${endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-runtime-host-dispatch-token': parentDispatchToken,
        },
        body: JSON.stringify({
          version: TRANSPORT_VERSION,
          action,
          ...(payload !== undefined ? { payload } : {}),
        }),
        signal: controller.signal,
      });
      const body = await response.json();
      return parseParentTransportPayload(body, response.status);
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestParentShellAction(action: ParentShellAction, payload?: unknown) {
    return await requestParentTransport('/internal/runtime-host/shell-actions', action, payload);
  }

  async function requestParentExecutionSync(action: ParentExecutionSyncAction, payload?: unknown) {
    return await requestParentTransport('/internal/runtime-host/execution-sync', action, payload);
  }

  async function emitParentGatewayEvent(
    eventName: ParentGatewayForwardEventName,
    payload: unknown,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(DISPATCH_TIMEOUT_MS, 3000));
    try {
      await fetch(`${parentApiBaseUrl}/internal/runtime-host/gateway-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-runtime-host-dispatch-token': parentDispatchToken,
        },
        body: JSON.stringify({
          version: TRANSPORT_VERSION,
          eventName,
          payload,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function mapParentTransportResponse(upstream: ParentTransportUpstreamPayload): ParentTransportResponse {
    if (upstream.success) {
      return {
        status: upstream.status,
        data: upstream.data,
      };
    }
    return {
      status: upstream.status,
      data: {
        success: false,
        error: upstream.error.message,
      },
    };
  }

  return {
    requestParentShellAction,
    requestParentExecutionSync,
    emitParentGatewayEvent,
    mapParentTransportResponse,
  };
}

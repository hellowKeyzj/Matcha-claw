import {
  DISPATCH_TIMEOUT_MS,
  TRANSPORT_VERSION,
} from '../shared/runtime-host-constants';
import type {
  ParentGatewayForwardEventName,
  ParentShellAction,
  ParentTransportUpstreamPayload,
} from '../shared/parent-transport-contracts';
import type { RuntimeHttpClientPort, RuntimeSchedulerPort } from '../application/common/runtime-ports';

interface ParentTransportClientOptions {
  parentApiBaseUrl: string;
  parentDispatchToken: string;
  httpClient: RuntimeHttpClientPort;
  scheduler: RuntimeSchedulerPort;
}

interface ParentTransportResponse {
  status: number;
  data: unknown;
}

export interface ParentTransportClient {
  requestParentShellAction(action: ParentShellAction, payload?: unknown): Promise<ParentTransportUpstreamPayload>;
  emitParentGatewayEvent(eventName: ParentGatewayForwardEventName, payload: unknown): Promise<void>;
  mapParentTransportResponse(upstream: ParentTransportUpstreamPayload): ParentTransportResponse;
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

export function createParentTransportClient(options: ParentTransportClientOptions): ParentTransportClient {
  const { parentApiBaseUrl, parentDispatchToken, httpClient, scheduler } = options;

  async function requestParentTransport(
    endpointPath: string,
    action: ParentShellAction,
    payload?: unknown,
  ) {
    const controller = new AbortController();
    const timeoutTask = scheduler.schedule(DISPATCH_TIMEOUT_MS, () => controller.abort());
    try {
      const response = await httpClient.request(`${parentApiBaseUrl}${endpointPath}`, {
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
      timeoutTask.cancel();
    }
  }

  async function requestParentShellAction(action: ParentShellAction, payload?: unknown) {
    return await requestParentTransport('/internal/runtime-host/shell-actions', action, payload);
  }

  async function emitParentGatewayEvent(
    eventName: ParentGatewayForwardEventName,
    payload: unknown,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutTask = scheduler.schedule(Math.min(DISPATCH_TIMEOUT_MS, 3000), () => controller.abort());
    try {
      await httpClient.request(`${parentApiBaseUrl}/internal/runtime-host/gateway-events`, {
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
      timeoutTask.cancel();
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
    emitParentGatewayEvent,
    mapParentTransportResponse,
  };
}

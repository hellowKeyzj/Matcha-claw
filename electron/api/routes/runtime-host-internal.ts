import type { IncomingMessage, ServerResponse } from 'http';
import {
  RUNTIME_HOST_TRANSPORT_VERSION,
} from '../../main/runtime-host-contract';
import type { RuntimeHostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const SHELL_ACTION_PATH = '/internal/runtime-host/shell-actions';
const GATEWAY_EVENT_PATH = '/internal/runtime-host/gateway-events';

type RuntimeHostShellAction =
  | 'shell_open_path'
  | 'gateway_restart'
  | 'host_diagnostics_snapshot'
  | 'provider_oauth_start'
  | 'provider_oauth_cancel'
  | 'provider_oauth_submit';

type RuntimeHostGatewayForwardEventName =
  | 'gateway:lifecycle'
  | 'gateway:notification'
  | 'session:update'
  | 'gateway:channel-status'
  | 'gateway:error';

function normalizeHeaderValue(headerValue: string | string[] | undefined): string | null {
  if (!headerValue) {
    return null;
  }
  if (Array.isArray(headerValue)) {
    return headerValue[0] ?? null;
  }
  return headerValue;
}

function sendTransportError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, {
    version: RUNTIME_HOST_TRANSPORT_VERSION,
    success: false,
    status,
    error: {
      code,
      message,
    },
  });
}

function ensureInternalToken(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RuntimeHostApiContext,
): boolean {
  const expectedToken = ctx.runtimeHost.getInternalDispatchToken();
  const providedToken = normalizeHeaderValue(req.headers['x-runtime-host-dispatch-token']);
  if (providedToken !== expectedToken) {
    sendTransportError(
      res,
      403,
      'FORBIDDEN',
      'Invalid runtime-host internal dispatch token',
    );
    return false;
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isShellAction(value: unknown): value is RuntimeHostShellAction {
  return value === 'shell_open_path'
    || value === 'gateway_restart'
    || value === 'host_diagnostics_snapshot'
    || value === 'provider_oauth_start'
    || value === 'provider_oauth_cancel'
    || value === 'provider_oauth_submit';
}

function isGatewayForwardEventName(value: unknown): value is RuntimeHostGatewayForwardEventName {
  return value === 'gateway:lifecycle'
    || value === 'gateway:notification'
    || value === 'session:update'
    || value === 'gateway:channel-status'
    || value === 'gateway:error';
}

async function handleShellActionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (req.method !== 'POST') {
    sendTransportError(
      res,
      405,
      'BAD_REQUEST',
      `Method not allowed: ${req.method ?? 'UNKNOWN'}`,
    );
    return true;
  }

  if (!ensureInternalToken(req, res, ctx)) {
    return true;
  }

  try {
    const body = await parseJsonBody<unknown>(req);
    const record = asRecord(body);
    if (!record) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        'Shell action body 必须是 object',
      );
      return true;
    }

    if (record.version !== RUNTIME_HOST_TRANSPORT_VERSION) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        `Unsupported transport version: ${String(record.version)}`,
      );
      return true;
    }

    if (!isShellAction(record.action)) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        `Invalid shell action: ${String(record.action)}`,
      );
      return true;
    }

    const result = await ctx.runtimeHost.executeShellAction(record.action, record.payload);
    sendJson(res, result.status, {
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: true,
      status: result.status,
      data: result.data,
    });
    return true;
  } catch (error) {
    sendTransportError(
      res,
      500,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}

async function handleGatewayEventRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (req.method !== 'POST') {
    sendTransportError(
      res,
      405,
      'BAD_REQUEST',
      `Method not allowed: ${req.method ?? 'UNKNOWN'}`,
    );
    return true;
  }

  if (!ensureInternalToken(req, res, ctx)) {
    return true;
  }

  try {
    const body = await parseJsonBody<unknown>(req);
    const record = asRecord(body);
    if (!record) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        'Gateway event body 必须是 object',
      );
      return true;
    }

    if (record.version !== RUNTIME_HOST_TRANSPORT_VERSION) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        `Unsupported transport version: ${String(record.version)}`,
      );
      return true;
    }

    if (!isGatewayForwardEventName(record.eventName)) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        `Invalid gateway forward event: ${String(record.eventName)}`,
      );
      return true;
    }

    ctx.runtimeHost.emitGatewayEvent(record.eventName, record.payload);
    sendJson(res, 200, {
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: true,
      status: 200,
      data: { accepted: true },
    });
    return true;
  } catch (error) {
    sendTransportError(
      res,
      500,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
}

export async function handleRuntimeHostInternalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname === SHELL_ACTION_PATH) {
    return await handleShellActionRoute(req, res, ctx);
  }
  if (url.pathname === GATEWAY_EVENT_PATH) {
    return await handleGatewayEventRoute(req, res, ctx);
  }
  return false;
}

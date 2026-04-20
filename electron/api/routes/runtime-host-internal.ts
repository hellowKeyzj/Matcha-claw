import type { IncomingMessage, ServerResponse } from 'http';
import {
  RUNTIME_HOST_TRANSPORT_VERSION,
} from '../../main/runtime-host-contract';
import type { RuntimeHostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const EXECUTION_SYNC_PATH = '/internal/runtime-host/execution-sync';
const SHELL_ACTION_PATH = '/internal/runtime-host/shell-actions';
const GATEWAY_EVENT_PATH = '/internal/runtime-host/gateway-events';

type RuntimeHostExecutionSyncAction =
  | 'set_execution_enabled'
  | 'restart_runtime_host';

type RuntimeHostShellAction =
  | 'shell_open_path'
  | 'gateway_restart'
  | 'provider_oauth_start'
  | 'provider_oauth_cancel'
  | 'provider_oauth_submit'
  | 'channel_session_start'
  | 'channel_session_cancel'
  | 'license_get_gate'
  | 'license_get_stored_key'
  | 'license_validate'
  | 'license_revalidate'
  | 'license_clear';

type RuntimeHostGatewayForwardEventName =
  | 'gateway:notification'
  | 'gateway:conversation-event'
  | 'gateway:channel-status'
  | 'gateway:error'
  | 'gateway:connection';

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

function isExecutionSyncAction(value: unknown): value is RuntimeHostExecutionSyncAction {
  return value === 'set_execution_enabled'
    || value === 'restart_runtime_host';
}

function isShellAction(value: unknown): value is RuntimeHostShellAction {
  return value === 'shell_open_path'
    || value === 'gateway_restart'
    || value === 'provider_oauth_start'
    || value === 'provider_oauth_cancel'
    || value === 'provider_oauth_submit'
    || value === 'channel_session_start'
    || value === 'channel_session_cancel'
    || value === 'license_get_gate'
    || value === 'license_get_stored_key'
    || value === 'license_validate'
    || value === 'license_revalidate'
    || value === 'license_clear';
}

function isGatewayForwardEventName(value: unknown): value is RuntimeHostGatewayForwardEventName {
  return value === 'gateway:notification'
    || value === 'gateway:conversation-event'
    || value === 'gateway:channel-status'
    || value === 'gateway:error'
    || value === 'gateway:connection';
}

async function handleExecutionSyncRoute(
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
        'Execution sync body 必须是 object',
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

    if (!isExecutionSyncAction(record.action)) {
      sendTransportError(
        res,
        400,
        'BAD_REQUEST',
        `Invalid execution sync action: ${String(record.action)}`,
      );
      return true;
    }

    if (record.action === 'set_execution_enabled') {
      const payload = asRecord(record.payload);
      if (!payload || typeof payload.enabled !== 'boolean') {
        sendTransportError(res, 400, 'BAD_REQUEST', 'enabled 必须是 boolean');
        return true;
      }
      await ctx.runtimeHost.setExecutionEnabled(payload.enabled);
    } else {
      await ctx.runtimeHost.restart();
    }

    const execution = ctx.runtimeHost.getExecutionState();
    sendJson(res, 200, {
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: true,
      status: 200,
      data: {
        execution,
      },
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
  if (url.pathname === EXECUTION_SYNC_PATH) {
    return await handleExecutionSyncRoute(req, res, ctx);
  }
  if (url.pathname === SHELL_ACTION_PATH) {
    return await handleShellActionRoute(req, res, ctx);
  }
  if (url.pathname === GATEWAY_EVENT_PATH) {
    return await handleGatewayEventRoute(req, res, ctx);
  }
  return false;
}

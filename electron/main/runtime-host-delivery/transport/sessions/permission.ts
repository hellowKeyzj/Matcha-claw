import {
  decodeSessionPermissionResult,
  isSessionPermissionRequest,
  type SessionPermissionRequest,
} from '../../../../../src/types/session-permission';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { sendLoopbackJsonDelivery } from '../client';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

export type { SessionPermissionRequest } from '../../../../../src/types/session-permission';
export type SessionPermissionOperationId = SessionPermissionRequest['operationId'];

const ENDPOINT = '/api/sessions/permission';
const UNAVAILABLE = { success: false, error: 'Session permission is unavailable' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export type SessionPermissionTransportResponse = Readonly<{
  status: 200 | 422 | 501 | 503;
  body: unknown;
}>;

export interface SessionPermissionTransport {
  get(request: unknown, traceId?: string | null): Promise<SessionPermissionTransportResponse>;
  set(request: unknown, traceId?: string | null): Promise<SessionPermissionTransportResponse>;
}

export function createSessionPermissionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionPermissionTransport {
  const execute = async (
    value: unknown,
    operationId: SessionPermissionOperationId,
    traceId?: string | null,
  ): Promise<SessionPermissionTransportResponse> => {
    const request = decodeSessionPermissionRequest(value);
    if (!request || request.operationId !== operationId) {
      logSessionTrace('electron.permission.rejected', traceId, () => ({ operationId }));
      return { status: 503, body: UNAVAILABLE };
    }
    const unavailable: SessionPermissionTransportResponse = {
      status: 503,
      body: request.scope.identity.endpoint.runtimeAdapterId === 'openclaw'
        ? UNAVAILABLE
        : { outcome: 'unavailable' },
    };
    const startedAt = traceId && isSessionTraceEnabled() ? Date.now() : 0;
    logSessionTrace('electron.permission.request', traceId, () => ({
      operationId,
      adapter: request.input.sessionIdentity.endpoint.runtimeAdapterId,
      sessionKey: summarizeIdentifier(request.input.sessionKey),
      permissionMode: request.operationId === 'sessions.permission.set'
        ? request.input.permissionMode
        : null,
    }));
    const delivery = await sendLoopbackJsonDelivery({
      port: runtimeHostTransportPort,
      path: ENDPOINT,
      issuer,
      decision: {
        endpoint: ENDPOINT,
        scope: operationId === 'sessions.permission.get' ? 'sessions:read' : 'sessions:write',
        capability: 'session.management',
        subject: 'session-permission',
      },
      method: 'POST',
      fetcher,
      body: request,
      headers: traceHeader(traceId),
    });
    if (delivery.outcome !== 'response') {
      logSessionTrace('electron.permission.failure', traceId, () => ({
        operationId,
        outcome: delivery.outcome,
        elapsedMs: Date.now() - startedAt,
      }));
      return delivery.outcome === 'unknown' ? { status: 503, body: UNKNOWN } : unavailable;
    }
    const { response } = delivery;
    const result = decodeSessionPermissionResult(response.status, response.body, request);
    logSessionTrace('electron.permission.response', traceId, () => ({
      operationId,
      status: response.status,
      contract: result ? 'valid' : 'invalid',
      outcome: result?.outcome,
      elapsedMs: Date.now() - startedAt,
    }));
    if (result && (response.status === 200 || response.status === 422
      || response.status === 501 || response.status === 503)) {
      return { status: response.status, body: response.body };
    }
    return { status: 503, body: UNKNOWN };
  };

  return {
    get: async (request, traceId) => await execute(request, 'sessions.permission.get', traceId),
    set: async (request, traceId) => await execute(request, 'sessions.permission.set', traceId),
  };
}

export function decodeSessionPermissionRequest(value: unknown): SessionPermissionRequest | null {
  return isSessionPermissionRequest(value) ? value : null;
}

import {
  decodeSessionThinkingResult,
  isSessionThinkingRequest,
  thinkingRuntime,
  type SessionThinkingRequest,
} from '../../../../../src/types/session-thinking';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { sendLoopbackJsonDelivery } from '../client';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

const ENDPOINT = '/api/sessions/thinking';

export function createSessionThinkingTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
) {
  const execute = async (value: unknown, operationId: SessionThinkingRequest['operationId'], traceId?: string | null) => {
    if (!isSessionThinkingRequest(value) || value.operationId !== operationId) {
      return { status: 400, body: { success: false, error: 'Session thinking request is invalid' } };
    }
    const runtime = thinkingRuntime(value.scope);
    const startedAt = traceId ? Date.now() : 0;
    logSessionTrace('electron.thinking.request', traceId, () => ({
      operationId, runtime, scopeKind: value.scope.kind,
      agent: summarizeIdentifier(value.scope.kind === 'session' ? value.scope.identity.agentId : value.scope.agentId),
      session: summarizeIdentifier(value.scope.kind === 'session' ? value.scope.identity.sessionKey : null),
      ...(value.operationId === 'sessions.thinking.get'
        ? { modelSelection: summarizeIdentifier(value.input.modelSelectionId) }
        : { requestedLevel: summarizeIdentifier(value.input.level) }),
    }));
    const delivery = await sendLoopbackJsonDelivery({
      port: runtimeHostTransportPort,
      path: ENDPOINT,
      issuer,
      decision: {
        endpoint: ENDPOINT,
        scope: operationId === 'sessions.thinking.get' ? 'sessions:read' : 'sessions:write',
        capability: 'session.thinking',
        subject: 'session-thinking',
      },
      method: 'POST',
      fetcher,
      body: value,
      headers: traceHeader(traceId),
      timeoutMs: 30_000,
    });
    if (delivery.outcome !== 'response') {
      logSessionTrace('electron.thinking.failure', traceId, () => ({
        operationId, runtime, delivery: delivery.outcome, reason: delivery.reason ?? 'transport_unavailable',
        elapsedMs: Date.now() - startedAt,
      }));
      return { status: 200, body: { runtime, outcome: delivery.outcome === 'unknown' ? 'unknown' : 'unavailable' } };
    }
    if (delivery.response.status === 401) {
      logSessionTrace('electron.thinking.failure', traceId, () => ({ operationId, runtime, reason: 'authorization_failed' }));
      return { status: 401, body: { success: false, error: 'Session thinking authorization failed' } };
    }
    const result = delivery.response.status === 200 ? decodeSessionThinkingResult(delivery.response.body, value) : null;
    logSessionTrace('electron.thinking.response', traceId, () => ({
      operationId, runtime, status: delivery.response.status, outcome: result?.outcome ?? 'unknown',
      reason: result ? 'decoded' : delivery.response.status === 200 ? 'invalid_readback' : 'http_status',
      elapsedMs: Date.now() - startedAt,
      ...(result && 'options' in result ? {
        level: summarizeIdentifier(result.level), effectiveLevel: summarizeIdentifier(result.effectiveLevel),
        options: result.options.map((level) => summarizeIdentifier(level)),
      } : {}),
      ...(result?.outcome === 'confirmed' ? { persisted: result.persisted, applied: result.applied } : {}),
    }));
    return { status: 200, body: result ?? { runtime, outcome: 'unknown' } };
  };
  return {
    get: (request: unknown, traceId?: string | null) => execute(request, 'sessions.thinking.get', traceId),
    set: (request: unknown, traceId?: string | null) => execute(request, 'sessions.thinking.set', traceId),
  };
}

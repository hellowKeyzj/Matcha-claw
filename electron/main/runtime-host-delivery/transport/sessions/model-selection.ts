import { logger } from '../../../../utils/logger';
import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { isSessionTraceEnabled } from './trace';

const DECISION_TTL_MS = 30_000;
const REJECTION_REASON_HEADER = 'x-runtime-host-session-model-rejection';
const OPENCLAW_PEER_CODE_HEADER = 'x-runtime-host-session-model-openclaw-code';
const OPENCLAW_PEER_MESSAGE_HEADER = 'x-runtime-host-session-model-openclaw-message';
const DIAGNOSTIC_ACCOUNT_HEADER = 'x-runtime-host-session-model-account';
const DIAGNOSTIC_MODEL_HEADER = 'x-runtime-host-session-model-model';
const DIAGNOSTIC_PROTOCOL_HEADER = 'x-runtime-host-session-model-protocol';
const DIAGNOSTIC_AUTH_MODE_HEADER = 'x-runtime-host-session-model-auth-mode';

const UNAVAILABLE = {
  success: false,
  error: 'Session model selection is unavailable',
} as const;

const INVALID_REQUEST = {
  success: false,
  error: 'Session model selection request is invalid',
} as const;

const UNSUPPORTED = {
  success: false,
  error: 'Session model selection endpoint is unsupported',
} as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type SessionModelSelectionRequest = Readonly<{
  id: 'session.modelSelection';
  operationId: 'sessions.patchModel';
  scope: Readonly<{
    kind: 'session';
    endpoint: Endpoint;
    sessionKey: string;
  }>;
  target: Readonly<{ kind: 'model-selection' }>;
  input: Readonly<{
    endpoint: Endpoint;
    sessionKey: string;
    modelSelectionId: string;
  }>;
}>;

export type SessionModelSelectionResponse = Readonly<{
  outcome: 'succeeded' | 'target_rejected' | 'outcome_unknown';
}>;

export type SessionModelSelectionTransportResponse = Readonly<{
  status: 200 | 400 | 422 | 503;
  body: SessionModelSelectionResponse | typeof INVALID_REQUEST | typeof UNSUPPORTED | typeof UNAVAILABLE;
}>;

export interface SessionModelSelectionTransport {
  select(request: unknown): Promise<SessionModelSelectionTransportResponse>;
}

export function createSessionModelSelectionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionModelSelectionTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionModelSelectionTransport {
  const url = `http://127.0.0.1:${sessionModelSelectionTransportPort}/api/sessions/model`;
  return {
    async select(request: unknown): Promise<SessionModelSelectionTransportResponse> {
      if (!isSessionModelSelectionRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/sessions/model',
              scope: 'sessions:write',
              capability: 'sessions.patchModel',
              subject: 'session-model-selection',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (
          response.status === 200
          && isSessionModelSelectionResponse(body)
          && body.outcome === 'target_rejected'
          && isSessionTraceEnabled()
        ) {
          logger.warn('[SessionModelSelection] target rejected', {
            adapter: request.input.endpoint.runtimeAdapterId,
            reason: response.headers?.get(REJECTION_REASON_HEADER) ?? 'unclassified',
            openclawCode: response.headers?.get(OPENCLAW_PEER_CODE_HEADER) ?? undefined,
            openclawMessage: response.headers?.get(OPENCLAW_PEER_MESSAGE_HEADER) ?? undefined,
            accountId: response.headers?.get(DIAGNOSTIC_ACCOUNT_HEADER) ?? undefined,
            modelId: response.headers?.get(DIAGNOSTIC_MODEL_HEADER) ?? undefined,
            protocol: response.headers?.get(DIAGNOSTIC_PROTOCOL_HEADER) ?? undefined,
            authMode: response.headers?.get(DIAGNOSTIC_AUTH_MODE_HEADER) ?? undefined,
            modelSelectionId: request.input.modelSelectionId,
            sessionKeyLength: request.input.sessionKey.length,
          });
        }
        if (response.status === 200 && isSessionModelSelectionResponse(body)) {
          return { status: 200, body };
        }
        if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
        if (response.status === 422) return { status: 422, body: UNSUPPORTED };
      } catch {
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSessionModelSelectionResponse(value: unknown): value is SessionModelSelectionResponse {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'succeeded'
      || value.outcome === 'target_rejected'
      || value.outcome === 'outcome_unknown');
}

function isSessionModelSelectionRequest(value: unknown): value is SessionModelSelectionRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.modelSelection'
    || value.operationId !== 'sessions.patchModel'
    || !isSessionScope(value.scope)
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'model-selection'
    || !isRecord(value.input)
    || !hasExactKeys(value.input, ['endpoint', 'sessionKey', 'modelSelectionId'])
    || !isEndpoint(value.input.endpoint)
    || value.scope.endpoint.runtimeAdapterId !== value.input.endpoint.runtimeAdapterId
    || value.scope.endpoint.runtimeInstanceId !== value.input.endpoint.runtimeInstanceId
    || value.scope.sessionKey !== value.input.sessionKey
    || typeof value.input.sessionKey !== 'string'
    || !value.input.sessionKey
    || typeof value.input.modelSelectionId !== 'string'
    || !value.input.modelSelectionId.trim()) {
    return false;
  }
  return isEndpoint(value.scope.endpoint);
}

function isSessionScope(value: unknown): value is SessionModelSelectionRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0;
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

import { logger } from '../../../../utils/logger';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { isSessionModelState } from './model-state-contract';
import { isEndpoint, type SessionIdentity, type SessionModelState } from './session-contract';
import {
  isSessionTraceEnabled,
  logSessionTrace,
  summarizeIdentifier,
  traceHeader,
} from './trace';

const ROUTE_PATH = '/api/sessions/model';
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

type Endpoint = SessionIdentity['endpoint'];
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
    endpointSessionId?: string;
    modelSelectionId: string;
  }>;
}>;

export type SessionModelSelectionResponse =
  | Readonly<{ outcome: 'succeeded'; modelState: SessionModelState }>
  | Readonly<{ outcome: 'target_rejected' | 'outcome_unknown' }>;

export type SessionModelSelectionTransportResponse = Readonly<{
  status: 200 | 400 | 422 | 503;
  body: SessionModelSelectionResponse | typeof INVALID_REQUEST | typeof UNSUPPORTED | typeof UNAVAILABLE;
}>;

export interface SessionModelSelectionTransport {
  select(request: unknown, traceId?: string | null): Promise<SessionModelSelectionTransportResponse>;
}

export function createSessionModelSelectionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionModelSelectionTransport {
  return {
    async select(request: unknown, traceId?: string | null): Promise<SessionModelSelectionTransportResponse> {
      const startedAt = traceId && isSessionTraceEnabled() ? Date.now() : 0;
      if (!isSessionModelSelectionRequest(request)) {
        logSessionTrace('electron.model-selection.rejected', traceId, () => ({
          reason: 'request-invalid',
          envelope: summarizeRequestShape(request),
        }));
        return { status: 503, body: UNAVAILABLE };
      }
      logSessionTrace('electron.model-selection.request', traceId, () => ({
        adapter: request.input.endpoint.runtimeAdapterId,
        sessionKey: summarizeIdentifier(request.input.sessionKey),
        endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
        modelSelectionId: summarizeIdentifier(request.input.modelSelectionId),
      }));
      const responseMetadata: { headers: Headers | null } = { headers: null };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'sessions:write',
          capability: 'sessions.patchModel',
          subject: 'session-model-selection',
        },
        method: 'POST',
        fetcher: async (input, init) => {
          const fetched = await fetcher(input, init);
          responseMetadata.headers = fetched.headers;
          return fetched;
        },
        body: request,
        headers: traceHeader(traceId),
      });
      if (response === null) {
        logSessionTrace('electron.model-selection.failure', traceId, () => ({
          elapsedMs: Date.now() - startedAt,
        }));
        return { status: 503, body: UNAVAILABLE };
      }
      const diagnosticHeaders = responseMetadata.headers;
      const body = response.body;
      logSessionTrace('electron.model-selection.response', traceId, () => {
        const valid = response.status === 200 && isSessionModelSelectionResponse(body);
        return {
          status: response.status,
          contract: response.status === 200 ? (valid ? 'valid' : 'invalid') : 'not-applicable',
          outcome: valid ? body.outcome : null,
          ...(valid && body.outcome === 'target_rejected' ? summarizeRejectionDiagnostic(diagnosticHeaders) : {}),
          elapsedMs: Date.now() - startedAt,
        };
      });
      if (
        isSessionTraceEnabled()
        && response.status === 200
        && isSessionModelSelectionResponse(body)
        && body.outcome === 'target_rejected'
      ) {
        if (request.input.endpoint.runtimeAdapterId === 'matcha-agent') {
          logger.warn('[SessionModelSelection] target rejected', {
            adapter: request.input.endpoint.runtimeAdapterId,
            ...summarizeRejectionDiagnostic(diagnosticHeaders),
            modelSelectionId: summarizeIdentifier(request.input.modelSelectionId),
            sessionKey: summarizeIdentifier(request.input.sessionKey),
            endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
          });
        } else {
          logger.warn('[SessionModelSelection] target rejected', {
            adapter: request.input.endpoint.runtimeAdapterId,
            reason: diagnosticHeaders?.get(REJECTION_REASON_HEADER) ?? 'unclassified',
            openclawCode: diagnosticHeaders?.get(OPENCLAW_PEER_CODE_HEADER) ?? undefined,
            openclawMessage: diagnosticHeaders?.get(OPENCLAW_PEER_MESSAGE_HEADER) ?? undefined,
            accountId: diagnosticHeaders?.get(DIAGNOSTIC_ACCOUNT_HEADER) ?? undefined,
            modelId: diagnosticHeaders?.get(DIAGNOSTIC_MODEL_HEADER) ?? undefined,
            protocol: diagnosticHeaders?.get(DIAGNOSTIC_PROTOCOL_HEADER) ?? undefined,
            authMode: diagnosticHeaders?.get(DIAGNOSTIC_AUTH_MODE_HEADER) ?? undefined,
            modelSelectionId: request.input.modelSelectionId,
            sessionKeyLength: request.input.sessionKey.length,
            endpointSessionIdLength: request.input.endpointSessionId?.length,
          });
        }
      }
      if (response.status === 200 && isSessionModelSelectionResponse(body)) {
        return { status: 200, body };
      }
      if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response.status === 422) return { status: 422, body: UNSUPPORTED };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isSessionModelSelectionResponse(value: unknown): value is SessionModelSelectionResponse {
  if (!isRecord(value) || typeof value.outcome !== 'string') return false;
  if (value.outcome === 'succeeded') {
    return hasExactKeys(value, ['outcome', 'modelState']) && isSessionModelState(value.modelState);
  }
  return hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'outcome_unknown');
}

function summarizeRejectionDiagnostic(headers: Headers | null) {
  const rejectionReason = headers?.get(REJECTION_REASON_HEADER) ?? '';
  const protocol = headers?.get(DIAGNOSTIC_PROTOCOL_HEADER) ?? '';
  const authMode = headers?.get(DIAGNOSTIC_AUTH_MODE_HEADER) ?? '';
  return {
    rejectionReason: [
      'invalid_session_key', 'binding_mismatch', 'invalid_model', 'model_selection_not_found',
      'openclaw_model_ref_invalid', 'matcha_provider_runtime_unavailable', 'session_not_found',
      'runtime_target_rejected', 'openclaw_runtime_target_rejected',
    ].includes(rejectionReason) ? rejectionReason : 'unclassified',
    accountId: summarizeIdentifier(headers?.get(DIAGNOSTIC_ACCOUNT_HEADER)),
    modelId: summarizeIdentifier(headers?.get(DIAGNOSTIC_MODEL_HEADER)),
    protocol: ['anthropic_messages', 'google_generative_ai', 'open_ai_completions', 'open_ai_responses'].includes(protocol)
      ? protocol : null,
    authMode: ['api_key', 'token', 'cli_reuse', 'oauth_browser', 'oauth_device', 'local'].includes(authMode)
      ? authMode : null,
  };
}

function summarizeRequestShape(value: unknown) {
  if (!isRecord(value)) {
    return { type: typeof value };
  }
  const scope = isRecord(value.scope) ? value.scope : null;
  const input = isRecord(value.input) ? value.input : null;
  return {
    bodyKeyCount: Object.keys(value).length,
    scopeKeyCount: scope ? Object.keys(scope).length : null,
    targetKeyCount: isRecord(value.target) ? Object.keys(value.target).length : null,
    inputKeyCount: input ? Object.keys(input).length : null,
    scopeSessionKey: summarizeIdentifier(typeof scope?.sessionKey === 'string' ? scope.sessionKey : null),
    inputSessionKey: summarizeIdentifier(typeof input?.sessionKey === 'string' ? input.sessionKey : null),
    endpointSessionId: summarizeIdentifier(typeof input?.endpointSessionId === 'string' ? input.endpointSessionId : null),
    modelSelectionId: summarizeIdentifier(typeof input?.modelSelectionId === 'string' ? input.modelSelectionId : null),
  };
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
    || !hasAllowedKeys(value.input, ['endpoint', 'sessionKey', 'modelSelectionId'], ['endpointSessionId'])
    || !isEndpoint(value.input.endpoint)
    || value.scope.endpoint.runtimeAdapterId !== value.input.endpoint.runtimeAdapterId
    || value.scope.endpoint.runtimeInstanceId !== value.input.endpoint.runtimeInstanceId
    || value.scope.sessionKey !== value.input.sessionKey
    || typeof value.input.sessionKey !== 'string'
    || !value.input.sessionKey
    || (value.input.endpointSessionId !== undefined && !isIdentifier(value.input.endpointSessionId))
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

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && value.trim() === value
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    });
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

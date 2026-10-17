import {
  decodeSessionQuestionListResult,
  decodeSessionQuestionRespondResult,
  isSessionQuestionIdentity,
  isSessionQuestionListInput,
  isSessionQuestionRespondInput,
  type SessionQuestionListInput,
  type SessionQuestionRespondInput,
  type SessionQuestionListResult,
  type SessionQuestionRespondResult,
  type SessionQuestionTarget,
} from '../../../../../src/types/session-question';
import { sessionIdentitiesEqual, type SessionIdentity } from '../../../../../src/types/desktop/runtime-address';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

export const SESSION_QUESTION_INVALID = { success: false, error: 'Session question request is invalid' } as const;
const AUTHORIZATION_FAILED = { success: false, error: 'Session question authorization failed' } as const;

type SessionBinding = Readonly<{ kind: 'session'; identity: SessionIdentity }>;
export type SessionQuestionRequest = Readonly<{
  id: 'session.question';
  scope: SessionBinding;
  target: SessionBinding;
}> & (
  | Readonly<{ operationId: 'sessions.questions.list'; input: SessionQuestionListInput }>
  | Readonly<{ operationId: 'sessions.questions.respond'; input: SessionQuestionRespondInput }>
);

export type SessionQuestionTransportResponse = Readonly<{
  status: 200 | 400 | 401 | 503;
  body: SessionQuestionListResult | SessionQuestionRespondResult | typeof SESSION_QUESTION_INVALID | typeof AUTHORIZATION_FAILED;
}>;

export interface SessionQuestionTransport {
  execute(request: unknown): Promise<SessionQuestionTransportResponse>;
}

export function createSessionQuestionTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionQuestionTransport {
  return {
    async execute(value) {
      const request = decodeSessionQuestionRequest(value);
      if (!request) return { status: 400, body: SESSION_QUESTION_INVALID };
      const listing = request.operationId === 'sessions.questions.list';
      const endpoint = listing ? '/api/sessions/questions/list' : '/api/sessions/questions/respond';
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: endpoint,
        issuer,
        decision: {
          endpoint,
          scope: listing ? 'sessions:read' : 'sessions:write',
          capability: request.operationId,
          subject: 'session-question',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 400) return { status: 400, body: SESSION_QUESTION_INVALID };
      if (response?.status === 401) return { status: 401, body: AUTHORIZATION_FAILED };
      if (response?.status === 200) {
        if (request.operationId === 'sessions.questions.list') {
          const result = decodeSessionQuestionListResult(response.body);
          if (result && (result.outcome !== 'listed'
            || result.questions.every((question) => question.target.sessionId === request.input.endpointSessionId))) {
            return { status: 200, body: result };
          }
        } else {
          const result = decodeSessionQuestionRespondResult(response.body);
          if (result && (!('receipt' in result) || result.receipt === undefined
            || sameQuestionTarget(result.receipt.target, request.input.target))) return { status: 200, body: result };
        }
      }
      return { status: 503, body: { outcome: listing ? 'unavailable' : 'unknown' } };
    },
  };
}

export function decodeSessionQuestionRequest(value: unknown): SessionQuestionRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.question'
    || !isSessionBinding(value.scope) || !isSessionBinding(value.target)
    || !sessionIdentitiesEqual(value.scope.identity, value.target.identity)) return null;
  if (value.operationId === 'sessions.questions.list') {
    return isSessionQuestionListInput(value.input)
      && sessionIdentitiesEqual(value.scope.identity, value.input.sessionIdentity)
      ? value as SessionQuestionRequest : null;
  }
  return value.operationId === 'sessions.questions.respond' && isSessionQuestionRespondInput(value.input)
    && sessionIdentitiesEqual(value.scope.identity, value.input.sessionIdentity)
    ? value as SessionQuestionRequest : null;
}

function isSessionBinding(value: unknown): value is SessionBinding {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity']) && value.kind === 'session'
    && isSessionQuestionIdentity(value.identity);
}

function sameQuestionTarget(left: SessionQuestionTarget, right: SessionQuestionTarget): boolean {
  return left.sessionId === right.sessionId && left.instanceId === right.instanceId
    && left.nativeRequestId === right.nativeRequestId;
}

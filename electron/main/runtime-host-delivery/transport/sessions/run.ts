import type { AppSessionRun } from '../../../../../sdk/app-plugins/src/execution';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isBoundedText, isRecord, sendLoopbackJson } from '../client';
import { isSessionIdentity, sameSessionIdentity, type SessionIdentity } from './session-contract';
import { isBoundedId, isTimelineScope } from './timeline-contract';

const ENDPOINT = '/api/sessions/run';
const UNAVAILABLE = { success: false, error: 'Session run is unavailable' } as const;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

export type SessionRunRequest = Readonly<{
  id: 'session.management';
  operationId: 'sessions.run.read';
  scope: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  input: Readonly<{ identity: SessionIdentity; runId: string }>;
}>;

export type SessionRunTransportResponse =
  | Readonly<{ status: 200; body: AppSessionRun }>
  | Readonly<{ status: 503; body: typeof UNAVAILABLE }>;

export interface SessionRunTransport {
  read(request: unknown, signal?: AbortSignal): Promise<SessionRunTransportResponse>;
}

export function createSessionRunTransport(issuer: RuntimeHostDeliveryIssuer, port: number, fetcher: typeof fetch = fetch): SessionRunTransport {
  return {
    async read(request, signal) {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port, path: ENDPOINT, issuer, fetcher, method: 'POST', body: request, signal,
        decision: { endpoint: ENDPOINT, scope: 'sessions:read', capability: 'session.management', subject: 'session-run' },
      });
      return response?.status === 200 && isSessionRun(response.body, request.input)
        ? { status: 200, body: response.body }
        : { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is SessionRunRequest {
  return isRecord(value) && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'session.management' && value.operationId === 'sessions.run.read'
    && isTimelineScope(value.scope) && isTimelineScope(value.target)
    && isRecord(value.input) && hasExactKeys(value.input, ['identity', 'runId'])
    && isSessionIdentity(value.input.identity) && isBoundedId(value.input.runId)
    && !/\p{Cc}/u.test(value.input.runId)
    && sameSessionIdentity(value.scope.identity, value.target.identity)
    && sameSessionIdentity(value.scope.identity, value.input.identity);
}

function isSessionRun(value: unknown, requested: SessionRunRequest['input']): value is AppSessionRun {
  return isRecord(value) && hasExactKeys(value, ['identity', 'runId', 'runtime', 'messagesStatus', 'messages', 'complete'])
    && isSessionIdentity(value.identity) && sameSessionIdentity(value.identity, requested.identity)
    && value.runId === requested.runId
    && (value.runtime === null || (isRecord(value.runtime) && hasExactKeys(value.runtime, ['phase', 'activeRunId', 'issue'])
      && ['queued', 'started', 'yielded', 'waiting_for_approval', 'cancellation_requested', 'cancelled', 'completed', 'failed', 'interrupted'].includes(value.runtime.phase as string)
      && (value.runtime.activeRunId === null || isBoundedId(value.runtime.activeRunId) && !/\p{Cc}/u.test(value.runtime.activeRunId))
      && (value.runtime.issue === null || ['unknown', 'unavailable', 'timeout', 'rejected'].includes(value.runtime.issue as string))))
    && ['complete', 'incomplete', 'unknown', 'unavailable'].includes(value.messagesStatus as string)
    && Array.isArray(value.messages) && value.messages.length <= 200
    && value.messages.every((message: unknown) => isRecord(message) && hasExactKeys(message, ['itemId', 'text', 'status'])
      && (message.itemId === null || isBoundedId(message.itemId) && !/\p{Cc}/u.test(message.itemId))
      && isBoundedText(message.text, MAX_TEXT_BYTES) && Buffer.byteLength(message.text, 'utf8') <= MAX_TEXT_BYTES
      && !/[\ud800-\udfff]/u.test(message.text)
      && ['pending', 'streaming', 'waiting_for_tool', 'final', 'error', 'aborted'].includes(message.status as string))
    && typeof value.complete === 'boolean' && value.complete === (value.messagesStatus === 'complete')
    && (!value.complete || (value.messages.length > 0 && value.messages.every((message) => message.status === 'final' && message.text.trim().length > 0)))
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RESULT_BYTES;
}

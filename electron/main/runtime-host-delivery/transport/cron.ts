import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { decodeCallReceipt } from '../../../../src/types/call-log/receipt';
import { isCronDeleteResult, isCronJob, isCronResultRequest } from '../../../../src/types/cron-operation-result';
import { hasExactKeys, isNonEmptyBoundedText as isNonEmptyString, isRecord, isSafeNonNegativeInteger as isTimestamp, sendLoopbackJson, type LoopbackDecision, type LoopbackJsonResponse } from './client';
const REQUEST_TIMEOUT_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Cron service is unavailable',
} as const;

type Operation =
  | 'cron.list'
  | 'cron.create'
  | 'cron.update'
  | 'cron.delete'
  | 'cron.toggle'
  | 'cron.trigger'
  | 'cron.session-history';
type CronCrudOperation = Exclude<Operation, 'cron.session-history'>;
type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
}>;

type CronRequest = Readonly<{
  id: 'scheduler.cron';
  operationId: CronCrudOperation;
  scope: Readonly<{ kind: 'runtime-instance'; endpoint: Endpoint }>;
  target: Readonly<{ kind: 'cron-job'; jobId?: string }>;
  input: Record<string, unknown>;
}>;

type CronSessionHistoryRequest = Readonly<{
  sessionKey: string;
  limit: number;
}>;

type CronSessionHistoryResponse = Readonly<{
  messages: readonly Readonly<{
    role: 'user' | 'assistant' | 'system' | 'toolresult';
    content: unknown;
    timestamp?: number;
    id?: string;
    toolCallId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
  }>[];
}>;

export type CronTransportResponse = Readonly<{
  status: 200 | 202 | 400 | 401 | 404 | 409 | 422 | 502 | 503 | 504;
  body: unknown;
}>;

export interface CronTransport {
  list(): Promise<CronTransportResponse>;
  create(request: unknown): Promise<CronTransportResponse>;
  update(request: unknown): Promise<CronTransportResponse>;
  remove(request: unknown): Promise<CronTransportResponse>;
  toggle(request: unknown): Promise<CronTransportResponse>;
  trigger(request: unknown): Promise<CronTransportResponse>;
  result(request: unknown): Promise<CronTransportResponse>;
  history(sessionKey: string, limit: number): Promise<CronTransportResponse>;
}

type CronE2ETraceStage =
  | 'transport_entered'
  | 'loopback_ok'
  | 'loopback_bad_request'
  | 'loopback_unauthorized'
  | 'loopback_not_found'
  | 'loopback_unavailable'
  | 'loopback_other_status'
  | 'loopback_timed_out'
  | 'loopback_failed';

type CronTransportOptions = Readonly<{
  reportE2ETrace?: (stage: CronE2ETraceStage) => Promise<void>;
}>;

export function createCronTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
  options: CronTransportOptions = {},
): CronTransport {
  return {
    list: () => send('cron.list', '/api/cron/jobs', {}),
    create: (request) => send('cron.create', '/api/cron/jobs/create', request),
    update: (request) => send('cron.update', '/api/cron/jobs/update', request),
    remove: (request) => send('cron.delete', '/api/cron/jobs/delete', request),
    toggle: (request) => send('cron.toggle', '/api/cron/jobs/toggle', request),
    trigger: (request) => send('cron.trigger', '/api/cron/jobs/trigger', request),
    result: sendResult,
    history: (sessionKey, limit) => sendHistory({ sessionKey, limit }),
  };

  async function sendCronLoopbackJson(request: Readonly<{
    path: string;
    decision: LoopbackDecision;
    method: 'GET' | 'POST';
    body?: unknown;
    query?: URLSearchParams;
    emptyContentLength?: boolean;
  }>): Promise<LoopbackJsonResponse | null> {
    const controller = new AbortController();
    let timedOut = false;
    const requestTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        issuer,
        fetcher,
        signal: controller.signal,
        ...request,
      });
      if (!response) await options.reportE2ETrace?.(timedOut ? 'loopback_timed_out' : 'loopback_failed');
      return response;
    } finally {
      clearTimeout(requestTimeout);
    }
  }

  async function sendResult(request: unknown): Promise<CronTransportResponse> {
    if (!isCronResultRequest(request)) return { status: 503, body: UNAVAILABLE };
    const response = await sendCronLoopbackJson({
      path: '/api/cron/results',
      decision: {
        endpoint: '/api/cron/results',
        scope: 'cron:write',
        capability: 'scheduler.cron',
        subject: 'cron-crud',
      },
      method: 'POST',
      body: request,
    });
    if (response?.status === 200
      && (request.command === 'delete' ? isCronDeleteResult(response.body)
        : isCronJob(response.body) && (request.command === 'create' || response.body.id === request.jobId))) {
      return { status: 200, body: response.body };
    }
    if (response && [400, 401, 404, 409, 422, 503].includes(response.status) && isPublicFailure(response.body)) {
      return { status: response.status as CronTransportResponse['status'], body: response.body };
    }
    return { status: 503, body: UNAVAILABLE };
  }

  async function sendHistory(request: CronSessionHistoryRequest): Promise<CronTransportResponse> {
    if (!isCronSessionHistoryRequest(request)) {
      return { status: 503, body: UNAVAILABLE };
    }
    await options.reportE2ETrace?.('transport_entered');
    const response = await sendCronLoopbackJson({
      path: '/api/cron/session-history',
      decision: {
        endpoint: '/api/cron/session-history',
        scope: 'cron:history:read',
        capability: 'scheduler.cron.history',
        subject: 'cron-session-history',
      },
      method: 'GET',
      query: new URLSearchParams({
        sessionKey: request.sessionKey,
        limit: String(request.limit),
      }),
      emptyContentLength: true,
    });
    if (response) {
      await options.reportE2ETrace?.(loopbackTraceStage(response.status));
      if (response.status === 200 && isCronSessionHistoryResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      if ([400, 401, 404, 409, 422, 502, 503, 504].includes(response.status)
        && isPublicFailure(response.body)) {
        return { status: response.status as CronTransportResponse['status'], body: response.body };
      }
    }
    return { status: 503, body: UNAVAILABLE };
  }

  async function send(
    operation: CronCrudOperation,
    path: string,
    request: unknown,
  ): Promise<CronTransportResponse> {
    if ((operation === 'cron.list' && !isEmptyObject(request))
      || (operation !== 'cron.list' && !isCronRequest(request, operation))) {
      return { status: 503, body: UNAVAILABLE };
    }
    await options.reportE2ETrace?.('transport_entered');
    const response = await sendCronLoopbackJson({
      path,
      decision: {
        endpoint: path,
        scope: 'cron:write',
        capability: 'scheduler.cron',
        subject: 'cron-crud',
      },
      method: 'POST',
      body: request,
    });
    if (response) {
      await options.reportE2ETrace?.(loopbackTraceStage(response.status));
      if (operation !== 'cron.list' && operation !== 'cron.trigger' && response.status === 202) {
        try { return { status: 202, body: decodeCallReceipt(response.body) }; } catch { /* Closed receipt boundary. */ }
      }
      if ((operation === 'cron.list' || operation === 'cron.trigger')
        && response.status === 200 && isSuccessResponse(response.body, operation)) {
        return { status: 200, body: response.body };
      }
      const failureStatuses = operation === 'cron.list' || operation === 'cron.trigger'
        ? [409, 422, 502, 503] : [400, 401, 404, 409, 422, 502, 503, 504];
      if (failureStatuses.includes(response.status)
        && isPublicFailure(response.body)) {
        return { status: response.status as CronTransportResponse['status'], body: response.body };
      }
    }
    return { status: 503, body: UNAVAILABLE };
  }
}

function loopbackTraceStage(status: number): CronE2ETraceStage {
  switch (status) {
    case 200:
    case 202:
      return 'loopback_ok';
    case 400:
      return 'loopback_bad_request';
    case 401:
      return 'loopback_unauthorized';
    case 404:
      return 'loopback_not_found';
    case 503:
      return 'loopback_unavailable';
    default:
      return 'loopback_other_status';
  }
}

function isCronSessionHistoryRequest(value: unknown): value is CronSessionHistoryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['sessionKey', 'limit'])
    && isNonEmptyString(value.sessionKey)
    && Number.isSafeInteger(value.limit)
    && value.limit >= 1
    && value.limit <= 200;
}

function isCronSessionHistoryResponse(value: unknown): value is CronSessionHistoryResponse {
  return isRecord(value)
    && hasExactKeys(value, ['messages'])
    && Array.isArray(value.messages)
    && value.messages.every(isCronSessionHistoryMessage);
}

function isCronSessionHistoryMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = ['role', 'content'];
  const optional = ['timestamp', 'id', 'toolCallId', 'toolName', 'details', 'isError'];
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
    && (value.role === 'user'
      || value.role === 'assistant'
      || value.role === 'system'
      || value.role === 'toolresult')
    && (value.timestamp === undefined || isTimestamp(value.timestamp))
    && (value.id === undefined || isNonEmptyString(value.id))
    && (value.toolCallId === undefined || isNonEmptyString(value.toolCallId))
    && (value.toolName === undefined || isNonEmptyString(value.toolName))
    && (value.isError === undefined || typeof value.isError === 'boolean');
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isCronRequest(value: unknown, operation: CronCrudOperation): value is CronRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'scheduler.cron'
    && value.operationId === operation
    && isScope(value.scope)
    && isTarget(value.target, operation)
    && isRecord(value.input)
    && (operation !== 'cron.update' || isUpdateInputBoundToTarget(value.input, value.target));
}

function isScope(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint'])
    && value.kind === 'runtime-instance'
    && isEndpoint(value.endpoint);
}

function isUpdateInputBoundToTarget(input: unknown, target: unknown): boolean {
  return isRecord(input)
    && isRecord(target)
    && isNonEmptyString(input.jobId)
    && input.jobId === target.jobId;
}

function isTarget(value: unknown, operation: CronCrudOperation): boolean {
  if (!isRecord(value) || value.kind !== 'cron-job') return false;
  if (operation === 'cron.create' || operation === 'cron.list') {
    return hasExactKeys(value, ['kind']);
  }
  return hasExactKeys(value, ['kind', 'jobId']) && isNonEmptyString(value.jobId);
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}

function isSuccessResponse(value: unknown, operation: CronCrudOperation): boolean {
  if (operation === 'cron.list') {
    return isRecord(value)
      && hasExactKeys(value, ['success', 'ready', 'refreshing', 'updatedAt', 'error', 'jobs'])
      && value.success === true
      && value.ready === true
      && value.refreshing === false
      && isOptionalTimestamp(value.updatedAt)
      && (value.error === null || typeof value.error === 'string')
      && Array.isArray(value.jobs)
      && value.jobs.every(isCronJob);
  }
  return operation === 'cron.trigger' && isCronTriggerResponse(value);
}

function isCronTriggerResponse(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'result'])
    || value.success !== true
    || !isRecord(value.result)
    || !hasAllowedKeys(value.result, ['outcome', 'reason'], ['outcome'])) {
    return false;
  }
  if (value.result.outcome !== 'accepted' && value.result.outcome !== 'skipped') return false;
  return value.result.reason === undefined
    || value.result.reason === 'already-running'
    || value.result.reason === 'not-due'
    || value.result.reason === 'invalid-spec'
    || value.result.reason === 'disabled'
    || value.result.reason === 'stopped';
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && typeof value.error === 'string';
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === null || value === undefined || isTimestamp(value);
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

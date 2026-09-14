import type { RuntimeHostDeliveryIssuer } from '../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  status: 200 | 400 | 401 | 404 | 409 | 422 | 502 | 503 | 504;
  body: unknown;
}>;

export interface CronTransport {
  list(): Promise<CronTransportResponse>;
  create(request: unknown): Promise<CronTransportResponse>;
  update(request: unknown): Promise<CronTransportResponse>;
  remove(request: unknown): Promise<CronTransportResponse>;
  toggle(request: unknown): Promise<CronTransportResponse>;
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
  port: number,
  fetcher: typeof fetch = fetch,
  options: CronTransportOptions = {},
): CronTransport {
  return {
    list: () => send('cron.list', '/api/cron/jobs', {}),
    create: (request) => send('cron.create', '/api/cron/jobs/create', request),
    update: (request) => send('cron.update', '/api/cron/jobs/update', request),
    remove: (request) => send('cron.delete', '/api/cron/jobs/delete', request),
    toggle: (request) => send('cron.toggle', '/api/cron/jobs/toggle', request),
    history: (sessionKey, limit) => sendHistory({ sessionKey, limit }),
  };

  async function sendHistory(request: CronSessionHistoryRequest): Promise<CronTransportResponse> {
    if (!isCronSessionHistoryRequest(request)) {
      return { status: 503, body: UNAVAILABLE };
    }
    await options.reportE2ETrace?.('transport_entered');
    const controller = new AbortController();
    let timedOut = false;
    const requestTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const query = new URLSearchParams({
        sessionKey: request.sessionKey,
        limit: String(request.limit),
      });
      const response = await fetcher(
        `http://127.0.0.1:${port}/api/cron/session-history?${query}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/cron/session-history',
              scope: 'cron:history:read',
              capability: 'scheduler.cron.history',
              subject: 'cron-session-history',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Length': '0',
          },
          signal: controller.signal,
        },
      );
      const body: unknown = await response.json();
      await options.reportE2ETrace?.(loopbackTraceStage(response.status));
      if (response.status === 200 && isCronSessionHistoryResponse(body)) {
        return { status: 200, body };
      }
      if ([400, 401, 404, 409, 422, 502, 503, 504].includes(response.status)
        && isPublicFailure(body)) {
        return { status: response.status as CronTransportResponse['status'], body };
      }
    } catch {
      await options.reportE2ETrace?.(timedOut ? 'loopback_timed_out' : 'loopback_failed');
    } finally {
      clearTimeout(requestTimeout);
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
    const controller = new AbortController();
    let timedOut = false;
    const requestTimeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issuer.signDecision({
            principal: 'electron-main-local',
            endpoint: path,
            scope: 'cron:write',
            capability: 'scheduler.cron',
            subject: 'cron-crud',
            expiresAt: Date.now() + DECISION_TTL_MS,
            revision: '1',
          })}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      await options.reportE2ETrace?.(loopbackTraceStage(response.status));
      if (response.status === 200 && isSuccessResponse(body, operation)) {
        return { status: 200, body };
      }
      if ((response.status === 409 || response.status === 422 || response.status === 502 || response.status === 503)
        && isPublicFailure(body)) {
        return { status: response.status, body };
      }
    } catch {
      await options.reportE2ETrace?.(timedOut ? 'loopback_timed_out' : 'loopback_failed');
      // The public contract deliberately suppresses loopback transport details.
    } finally {
      clearTimeout(requestTimeout);
    }
    return { status: 503, body: UNAVAILABLE };
  }
}

function loopbackTraceStage(status: number): CronE2ETraceStage {
  switch (status) {
    case 200:
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
  if (operation === 'cron.delete') {
    return isRecord(value) && hasExactKeys(value, ['removed']) && typeof value.removed === 'boolean';
  }
  return isCronJob(value);
}

function isCronJob(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, [
      'id', 'name', 'agentId', 'message', 'model', 'schedule', 'delivery', 'target', 'enabled',
      'createdAt', 'updatedAt', 'lastRun', 'nextRun', 'runningAt',
    ], [
      'id', 'name', 'agentId', 'message', 'schedule', 'delivery', 'enabled', 'createdAt', 'updatedAt',
    ])
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.agentId)
    && typeof value.message === 'string'
    && (value.model === undefined || isNonEmptyString(value.model))
    && isSchedule(value.schedule)
    && isDelivery(value.delivery)
    && (value.target === undefined || isTargetProjection(value.target))
    && typeof value.enabled === 'boolean'
    && isIsoTimestamp(value.createdAt)
    && isIsoTimestamp(value.updatedAt)
    && (value.lastRun === undefined || isLastRun(value.lastRun))
    && (value.nextRun === undefined || isIsoTimestamp(value.nextRun))
    && (value.runningAt === undefined || isIsoTimestamp(value.runningAt));
}

function isSchedule(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'at') return hasExactKeys(value, ['kind', 'at']) && isNonEmptyString(value.at);
  if (value.kind === 'every') return hasAllowedKeys(value, ['kind', 'everyMs', 'anchorMs'], ['kind', 'everyMs'])
    && isTimestamp(value.everyMs) && (value.anchorMs === undefined || isTimestamp(value.anchorMs));
  return value.kind === 'cron'
    && hasAllowedKeys(value, ['kind', 'expr', 'tz'], ['kind', 'expr'])
    && isNonEmptyString(value.expr)
    && (value.tz === undefined || isNonEmptyString(value.tz));
}

function isDelivery(value: unknown): boolean {
  if (!isRecord(value) || typeof value.mode !== 'string') return false;
  if (value.mode === 'none') return hasExactKeys(value, ['mode']);
  return value.mode === 'announce'
    && hasAllowedKeys(value, ['mode', 'channel', 'to', 'accountId'], ['mode', 'channel'])
    && isNonEmptyString(value.channel)
    && (value.to === undefined || isNonEmptyString(value.to))
    && (value.accountId === undefined || isNonEmptyString(value.accountId));
}

function isTargetProjection(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, ['channelType', 'channelId', 'channelName', 'recipient'], ['channelType', 'channelId', 'channelName'])
    && isNonEmptyString(value.channelType)
    && isNonEmptyString(value.channelId)
    && isNonEmptyString(value.channelName)
    && (value.recipient === undefined || isNonEmptyString(value.recipient));
}

function isLastRun(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, ['time', 'success', 'error', 'duration'], ['time', 'success'])
    && isIsoTimestamp(value.time)
    && typeof value.success === 'boolean'
    && (value.error === undefined || typeof value.error === 'string')
    && (value.duration === undefined || isTimestamp(value.duration));
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && typeof value.error === 'string';
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === null || value === undefined || isTimestamp(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

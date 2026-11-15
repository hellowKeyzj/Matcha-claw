import { validateSessionIdentity, type SessionIdentity } from './desktop/runtime-address';

export type OpenClawVideoTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface OpenClawVideoTaskRefreshInput {
  sessionIdentity: SessionIdentity;
  taskId: string;
}

export type OpenClawVideoTaskRefreshResult = { taskId: string } & (
  | { status: OpenClawVideoTaskStatus }
  | { errorCode: 'missing_job_reference' | 'provider_unsupported' | 'task_unavailable' | 'query_rejected' }
);

export function isOpenClawVideoTaskRefreshInput(value: unknown): value is OpenClawVideoTaskRefreshInput {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionIdentity', 'taskId'])
    || validateSessionIdentity(value.sessionIdentity) || !isTaskId(value.taskId)) return false;
  const identity = value.sessionIdentity as SessionIdentity;
  return identity.endpoint.kind === 'native-runtime' && identity.endpoint.runtimeAdapterId === 'openclaw'
    && identity.endpoint.runtimeInstanceId === 'local';
}

export function decodeOpenClawVideoTaskRefreshResult(value: unknown): OpenClawVideoTaskRefreshResult | null {
  if (!isRecord(value) || !isTaskId(value.taskId)) return null;
  if (hasExactKeys(value, ['taskId', 'errorCode'])) {
    switch (value.errorCode) {
      case 'missing_job_reference': case 'provider_unsupported': case 'task_unavailable': case 'query_rejected':
        return { taskId: value.taskId, errorCode: value.errorCode };
      default: return null;
    }
  }
  if (!hasExactKeys(value, ['taskId', 'status'])) return null;
  switch (value.status) {
    case 'queued': case 'running': case 'completed': case 'failed': case 'timed_out': case 'cancelled':
      return { taskId: value.taskId, status: value.status };
    default: return null;
  }
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && new TextEncoder().encode(value).length <= 4096 && !/\p{Cc}/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

import type { CallDetailByModule } from '../call-log';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** Mutation application and native task completion are independent facts. */
export interface TaskManagerCallDetail {
  agentRef: string | null;
  sessionRef: string | null;
  teamRef: string | null;
  taskRef: string | null;
  requestedStatus: TaskStatus | null;
  taskStatus: TaskStatus | null;
  taskCount: number | null;
  todoCount: number | null;
  mutation: 'applied' | 'rejected' | 'unknown' | null;
  read: 'found' | 'notFound' | 'unavailable' | 'rejected' | 'protocol' | null;
  failure: 'admissionClosed' | 'unsupported' | 'unavailable' | 'ownerUnavailable' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    'task-manager': TaskManagerCallDetail;
  }
}

export type TaskManagerCallSummary = CallDetailByModule['task-manager'];

export function decodeTaskManagerCallDetail(value: unknown): TaskManagerCallDetail | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const keys = ['agentRef', 'sessionRef', 'teamRef', 'taskRef', 'requestedStatus', 'taskStatus',
    'taskCount', 'todoCount', 'mutation', 'read', 'failure'];
  if (Object.keys(detail).length !== keys.length || !keys.every((key) => Object.hasOwn(detail, key))) return null;
  if (!['agentRef', 'sessionRef', 'teamRef', 'taskRef'].every((key) => detail[key] === null
    || (typeof detail[key] === 'string' && detail[key].length > 0 && detail[key].length <= 128
      && !/[^A-Za-z0-9._:-]/.test(detail[key])))) return null;
  const taskStatuses = ['pending', 'in_progress', 'completed', 'deleted'];
  if (!nullableLabel(detail.requestedStatus, taskStatuses) || !nullableLabel(detail.taskStatus, taskStatuses)
    || !nullableCount(detail.taskCount) || !nullableCount(detail.todoCount)
    || !nullableLabel(detail.mutation, ['applied', 'rejected', 'unknown'])
    || !nullableLabel(detail.read, ['found', 'notFound', 'unavailable', 'rejected', 'protocol'])
    || !nullableLabel(detail.failure, ['admissionClosed', 'unsupported', 'unavailable', 'ownerUnavailable'])
    || (detail.mutation !== null && detail.read !== null)) return null;
  return {
    agentRef: detail.agentRef as string | null,
    sessionRef: detail.sessionRef as string | null,
    teamRef: detail.teamRef as string | null,
    taskRef: detail.taskRef as string | null,
    requestedStatus: detail.requestedStatus as TaskStatus | null,
    taskStatus: detail.taskStatus as TaskStatus | null,
    taskCount: detail.taskCount as number | null,
    todoCount: detail.todoCount as number | null,
    mutation: detail.mutation as TaskManagerCallDetail['mutation'],
    read: detail.read as TaskManagerCallDetail['read'],
    failure: detail.failure as TaskManagerCallDetail['failure'],
  };
}

function nullableLabel(value: unknown, labels: readonly string[]): boolean {
  return value === null || (typeof value === 'string' && labels.includes(value));
}

function nullableCount(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

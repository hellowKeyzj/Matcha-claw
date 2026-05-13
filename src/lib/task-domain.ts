import type { TaskStatus } from '@/services/openclaw/task-manager-client';

const UNFINISHED_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'in_progress',
]);

const TASK_SESSION_METADATA_KEYS = [
  'sessionKey',
  'executionSessionKey',
  'taskSessionKey',
  'childSessionKey',
] as const;

export function filterUnfinishedTasks<T extends { status: TaskStatus }>(tasks: T[]): T[] {
  return tasks.filter((task) => UNFINISHED_TASK_STATUSES.has(task.status));
}

export function resolveTaskExecutionSessionKey(
  task: { metadata?: Record<string, unknown> },
  fallbackSessionKey: string,
): string {
  for (const key of TASK_SESSION_METADATA_KEYS) {
    const value = task.metadata?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallbackSessionKey.trim();
}

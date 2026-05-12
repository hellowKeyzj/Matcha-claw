import type { TaskStatus } from '@/services/openclaw/task-manager-client';

const UNFINISHED_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'in_progress',
]);

export function filterUnfinishedTasks<T extends { status: TaskStatus }>(tasks: T[]): T[] {
  return tasks.filter((task) => UNFINISHED_TASK_STATUSES.has(task.status));
}

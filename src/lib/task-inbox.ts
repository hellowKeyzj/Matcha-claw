import type { Task, TaskStatus } from '@/services/openclaw/task-manager-client';

const UNFINISHED_TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'in_progress',
]);

export function filterUnfinishedTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => UNFINISHED_TASK_STATUSES.has(task.status));
}

export function parseAgentIdFromSessionKey(session?: string): string | null {
  if (!session) {
    return null;
  }
  const matched = session.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

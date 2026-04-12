export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

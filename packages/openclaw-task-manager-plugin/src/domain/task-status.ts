export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'] as const
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type TodoStatus = (typeof TODO_STATUSES)[number]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

import type { TaskItem, TaskSummary } from '../domain/task-item.js'

export function asTaskSummaryPayload(task: TaskSummary) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...(task.owner ? { owner: task.owner } : {}),
    blockedBy: task.blockedBy,
  }
}

export function asTaskDetailPayload(task: TaskItem) {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    ...(task.activeForm ? { activeForm: task.activeForm } : {}),
    status: task.status,
    ...(task.owner ? { owner: task.owner } : {}),
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    ...(task.metadata ? { metadata: task.metadata } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

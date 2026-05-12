import type { TaskItem } from '../domain/task-item.js'

export function buildTaskArtifactPayload(sessionKey: string, tasks: TaskItem[]) {
  return {
    type: 'tasks',
    uri: `agent:///${sessionKey}/tasks/${sessionKey}`,
    name: 'Tasks',
    title: 'Tasks',
    mimeType: 'application/json',
    tasks: tasks.map((task) => ({
      id: task.id,
      content: task.subject,
      ...(task.activeForm ? { activeForm: task.activeForm } : {}),
      status: task.status,
      dependencies: task.blockedBy,
    })),
    enableEdit: false,
  }
}

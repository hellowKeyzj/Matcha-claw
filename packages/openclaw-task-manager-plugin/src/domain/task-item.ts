import type { TaskStatus, TodoStatus } from './task-status.js'

export interface TaskItem {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  owner?: string
  blockedBy: string[]
  blocks: string[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface TaskSummary {
  id: string
  subject: string
  status: TaskStatus
  owner?: string
  blockedBy: string[]
}

export interface TodoItem {
  id?: string
  content: string
  activeForm?: string
  status: TodoStatus
  owner?: string
}

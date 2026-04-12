import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { TaskItem, TaskSummary } from '../domain/task-item.js'
import type { TaskListMeta } from '../domain/task-list.js'
import { isTaskStatus, type TaskStatus } from '../domain/task-status.js'
import { normalizeTaskRecord } from '../schemas/task-store-schema.js'
import { TaskStoreError } from '../shared/errors.js'
import { normalizeStringList, toNonEmptyString } from '../shared/params.js'

export type TaskCreateInput = {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
}

export type TaskUpdateInput = {
  taskId: string
  status?: TaskStatus
  subject?: string
  description?: string
  activeForm?: string | null
  owner?: string | null
  addBlockedBy?: string[]
  addBlocks?: string[]
  metadata?: Record<string, unknown>
}

export type TaskClaimInput = {
  taskId: string
  owner: string
}

const STORE_VERSION = 1
const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 8_000

function nowTs(): number {
  return Date.now()
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const fh = await open(lockPath, 'wx')
      return async () => {
        await fh.close().catch(() => {})
        await unlink(lockPath).catch(() => {})
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : ''
      if (code !== 'EEXIST') {
        throw error
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  throw new TaskStoreError('store_unavailable', 'Task store lock timeout')
}

export class TaskStore {
  private readonly workspaceDir: string
  private readonly taskListId: string
  private readonly rootDir: string
  private readonly tasksDir: string
  private readonly metaPath: string
  private readonly lockPath: string

  constructor(workspaceDir: string, taskListId = 'default') {
    this.workspaceDir = workspaceDir
    this.taskListId = taskListId
    this.rootDir = join(workspaceDir, '.openclaw', 'task-manager', 'task-lists', taskListId)
    this.tasksDir = join(this.rootDir, 'tasks')
    this.metaPath = join(this.rootDir, 'meta.json')
    this.lockPath = join(this.rootDir, '.lock')
  }

  getWorkspaceDir(): string {
    return this.workspaceDir
  }

  getTaskListId(): string {
    return this.taskListId
  }

  private taskFilePath(taskId: string): string {
    return join(this.tasksDir, `${taskId}.json`)
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true })
    if (!existsSync(this.metaPath)) {
      const ts = nowTs()
      const meta: TaskListMeta = {
        version: STORE_VERSION,
        taskListId: this.taskListId,
        createdAt: ts,
        updatedAt: ts,
      }
      await writeFile(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureInitialized()
    const release = await acquireFileLock(this.lockPath)
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  private async readTaskUnsafe(taskId: string): Promise<TaskItem | null> {
    const safeTaskId = toNonEmptyString(taskId, 'taskId')
    const filePath = this.taskFilePath(safeTaskId)
    if (!existsSync(filePath)) {
      return null
    }
    const text = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(text) as unknown
    const normalized = normalizeTaskRecord(parsed)
    if (!normalized) {
      throw new TaskStoreError('store_unavailable', `Task file is corrupted: ${safeTaskId}`)
    }
    return normalized
  }

  private async writeTaskUnsafe(task: TaskItem): Promise<void> {
    const filePath = this.taskFilePath(task.id)
    await writeFile(filePath, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  }

  private async assertUnblocked(task: TaskItem): Promise<void> {
    const unresolved: string[] = []
    for (const blockerId of task.blockedBy) {
      const blocker = await this.readTaskUnsafe(blockerId)
      if (!blocker) {
        continue
      }
      if (blocker.status !== 'completed') {
        unresolved.push(blocker.id)
      }
    }
    if (unresolved.length > 0) {
      throw new TaskStoreError('blocked', `Task ${task.id} is blocked by: ${unresolved.join(', ')}`)
    }
  }

  async listTasks(): Promise<TaskItem[]> {
    await this.ensureInitialized()
    const entries = await readdir(this.tasksDir, { withFileTypes: true })
    const tasks: TaskItem[] = []
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== '.json') {
        continue
      }
      const text = await readFile(join(this.tasksDir, entry.name), 'utf8')
      const normalized = normalizeTaskRecord(JSON.parse(text) as unknown)
      if (normalized) {
        tasks.push(normalized)
      }
    }
    tasks.sort((a, b) => b.updatedAt - a.updatedAt)
    return tasks
  }

  async listTaskSummaries(): Promise<TaskSummary[]> {
    const tasks = await this.listTasks()
    return tasks.map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      ...(task.owner ? { owner: task.owner } : {}),
      blockedBy: task.blockedBy,
    }))
  }

  async getTask(taskId: string): Promise<TaskItem | null> {
    await this.ensureInitialized()
    return await this.readTaskUnsafe(taskId)
  }

  async createTask(input: TaskCreateInput): Promise<TaskItem> {
    return await this.withLock(async () => {
      const ts = nowTs()
      const subject = toNonEmptyString(input.subject, 'subject')
      const description = toNonEmptyString(input.description, 'description')
      const task: TaskItem = {
        id: `task-${randomUUID().slice(0, 8)}`,
        subject,
        description,
        status: 'pending',
        blockedBy: [],
        blocks: [],
        createdAt: ts,
        updatedAt: ts,
      }
      if (typeof input.activeForm === 'string' && input.activeForm.trim()) {
        task.activeForm = input.activeForm.trim()
      }
      if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
        task.metadata = input.metadata
      }
      await this.writeTaskUnsafe(task)
      return task
    })
  }

  async updateTask(input: TaskUpdateInput): Promise<{ task: TaskItem; updatedFields: string[]; statusChange?: { from: TaskStatus; to: TaskStatus } }> {
    return await this.withLock(async () => {
      const taskId = toNonEmptyString(input.taskId, 'taskId')
      const task = await this.readTaskUnsafe(taskId)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }

      const updatedFields: string[] = []
      const statusBefore = task.status

      if (typeof input.subject === 'string') {
        task.subject = toNonEmptyString(input.subject, 'subject')
        updatedFields.push('subject')
      }
      if (typeof input.description === 'string') {
        task.description = toNonEmptyString(input.description, 'description')
        updatedFields.push('description')
      }
      if (input.activeForm === null) {
        delete task.activeForm
        updatedFields.push('activeForm')
      } else if (typeof input.activeForm === 'string') {
        task.activeForm = toNonEmptyString(input.activeForm, 'activeForm')
        updatedFields.push('activeForm')
      }
      if (input.owner === null) {
        delete task.owner
        updatedFields.push('owner')
      } else if (typeof input.owner === 'string') {
        task.owner = toNonEmptyString(input.owner, 'owner')
        updatedFields.push('owner')
      }
      if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
        task.metadata = input.metadata
        updatedFields.push('metadata')
      }

      const addBlockedBy = normalizeStringList(input.addBlockedBy)
      const addBlocks = normalizeStringList(input.addBlocks)

      for (const blockerId of addBlockedBy) {
        if (blockerId === task.id) {
          throw new TaskStoreError('invalid_params', 'A task cannot block itself')
        }
        const blocker = await this.readTaskUnsafe(blockerId)
        if (!blocker) {
          throw new TaskStoreError('task_not_found', `BlockedBy task not found: ${blockerId}`)
        }
        if (!task.blockedBy.includes(blockerId)) {
          task.blockedBy.push(blockerId)
          updatedFields.push('blockedBy')
        }
        if (!blocker.blocks.includes(task.id)) {
          blocker.blocks.push(task.id)
          blocker.updatedAt = nowTs()
          await this.writeTaskUnsafe(blocker)
        }
      }

      for (const blockedId of addBlocks) {
        if (blockedId === task.id) {
          throw new TaskStoreError('invalid_params', 'A task cannot block itself')
        }
        const blocked = await this.readTaskUnsafe(blockedId)
        if (!blocked) {
          throw new TaskStoreError('task_not_found', `Blocks task not found: ${blockedId}`)
        }
        if (!task.blocks.includes(blockedId)) {
          task.blocks.push(blockedId)
          updatedFields.push('blocks')
        }
        if (!blocked.blockedBy.includes(task.id)) {
          blocked.blockedBy.push(task.id)
          blocked.updatedAt = nowTs()
          await this.writeTaskUnsafe(blocked)
        }
      }

      if (input.status !== undefined) {
        if (!isTaskStatus(input.status)) {
          throw new TaskStoreError('invalid_params', 'Invalid status value')
        }
        if (task.status === 'completed' && input.status !== 'completed') {
          throw new TaskStoreError('invalid_transition', 'Completed task cannot transition to non-completed status')
        }
        if (input.status === 'in_progress') {
          await this.assertUnblocked(task)
        }
        task.status = input.status
        updatedFields.push('status')
      }

      task.updatedAt = nowTs()
      await this.writeTaskUnsafe(task)

      const statusChange = task.status !== statusBefore
        ? { from: statusBefore, to: task.status }
        : undefined

      return { task, updatedFields: Array.from(new Set(updatedFields)), ...(statusChange ? { statusChange } : {}) }
    })
  }

  async claimTask(input: TaskClaimInput): Promise<TaskItem> {
    return await this.withLock(async () => {
      const taskId = toNonEmptyString(input.taskId, 'taskId')
      const owner = toNonEmptyString(input.owner, 'owner')
      const task = await this.readTaskUnsafe(taskId)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      if (task.owner && task.owner !== owner) {
        throw new TaskStoreError('already_claimed', `Task already claimed by ${task.owner}`)
      }
      if (task.status === 'completed') {
        throw new TaskStoreError('invalid_transition', 'Completed task cannot be claimed')
      }

      await this.assertUnblocked(task)
      task.owner = owner
      task.status = 'in_progress'
      task.updatedAt = nowTs()
      await this.writeTaskUnsafe(task)
      return task
    })
  }
}

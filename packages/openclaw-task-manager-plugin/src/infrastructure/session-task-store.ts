import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { TaskItem } from '../domain/task-item.js'
import type { TaskStatus } from '../domain/task-status.js'
import { isTaskStatus } from '../domain/task-status.js'
import { normalizeTaskRecord } from '../schemas/task-store-schema.js'
import { TaskStoreError } from '../shared/errors.js'
import { normalizeStringList, toNonEmptyString } from '../shared/params.js'

export type TaskCreateInput = {
  subject: string
  description: string
  activeForm?: string
  metadata?: Record<string, unknown>
  owner?: string
}

export type TaskUpdateInput = {
  taskId: string
  status?: TaskStatus
  subject?: string
  description?: string
  activeForm?: string
  owner?: string
  addBlockedBy?: string[]
  addBlocks?: string[]
  metadata?: Record<string, unknown>
}

const LOCK_RETRY_MS = 50
const LOCK_TIMEOUT_MS = 8_000

function nowTs(): number {
  return Date.now()
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function sanitizeScopeKey(scopeKey: string): string {
  const trimmed = toNonEmptyString(scopeKey, 'scopeKey')
  return trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
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

function numericTaskId(taskId: string): number {
  const parsed = Number.parseInt(taskId, 10)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function compareTaskIds(left: string, right: string): number {
  const leftNumber = numericTaskId(left)
  const rightNumber = numericTaskId(right)
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber
  }
  return left.localeCompare(right)
}

export class TaskStore {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  private scopeDir(scopeKey: string): string {
    return join(this.rootDir, 'tasks', sanitizeScopeKey(scopeKey))
  }

  private tasksDir(scopeKey: string): string {
    return join(this.scopeDir(scopeKey), 'items')
  }

  private taskFilePath(scopeKey: string, taskId: string): string {
    return join(this.tasksDir(scopeKey), `${taskId}.json`)
  }

  private lockPath(scopeKey: string): string {
    return join(this.scopeDir(scopeKey), '.lock')
  }

  private async ensureInitialized(scopeKey: string): Promise<void> {
    await mkdir(this.tasksDir(scopeKey), { recursive: true })
  }

  private async withLock<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureInitialized(scopeKey)
    const release = await acquireFileLock(this.lockPath(scopeKey))
    try {
      return await fn()
    } finally {
      await release()
    }
  }

  private async readTaskUnsafe(scopeKey: string, taskId: string): Promise<TaskItem | null> {
    const safeTaskId = toNonEmptyString(taskId, 'taskId')
    const filePath = this.taskFilePath(scopeKey, safeTaskId)
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

  private async writeTaskUnsafe(scopeKey: string, task: TaskItem): Promise<void> {
    const filePath = this.taskFilePath(scopeKey, task.id)
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    await writeFile(tmpPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    await rename(tmpPath, filePath)
  }

  private async nextTaskIdUnsafe(scopeKey: string): Promise<string> {
    const entries = await readdir(this.tasksDir(scopeKey), { withFileTypes: true })
    let maxId = 0
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== '.json' || entry.name.includes('.tmp.')) {
        continue
      }
      const id = entry.name.slice(0, -'.json'.length)
      const parsed = Number.parseInt(id, 10)
      if (Number.isFinite(parsed)) {
        maxId = Math.max(maxId, parsed)
      }
    }
    return String(maxId + 1)
  }

  async create(scopeKey: string, input: TaskCreateInput): Promise<TaskItem> {
    return await this.withLock(scopeKey, async () => {
      const ts = nowTs()
      const task: TaskItem = {
        id: await this.nextTaskIdUnsafe(scopeKey),
        subject: toNonEmptyString(input.subject, 'subject'),
        description: toNonEmptyString(input.description, 'description'),
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
      if (typeof input.owner === 'string' && input.owner.trim()) {
        task.owner = input.owner.trim()
      }
      await this.writeTaskUnsafe(scopeKey, task)
      return task
    })
  }

  async update(scopeKey: string, taskId: string, input: TaskUpdateInput): Promise<TaskItem | null> {
    return await this.withLock(scopeKey, async () => {
      const task = await this.readTaskUnsafe(scopeKey, taskId)
      if (!task) {
        return null
      }

      if (input.status !== undefined) {
        if (!isTaskStatus(input.status)) {
          throw new TaskStoreError('invalid_params', 'Invalid status value')
        }
        task.status = input.status
      }
      if (typeof input.subject === 'string') {
        task.subject = toNonEmptyString(input.subject, 'subject')
      }
      if (typeof input.description === 'string') {
        task.description = toNonEmptyString(input.description, 'description')
      }
      if (typeof input.activeForm === 'string') {
        task.activeForm = toNonEmptyString(input.activeForm, 'activeForm')
      }
      if (typeof input.owner === 'string') {
        task.owner = toNonEmptyString(input.owner, 'owner')
      }

      const addBlockedBy = normalizeStringList(input.addBlockedBy)
      for (const blockerId of addBlockedBy) {
        if (!task.blockedBy.includes(blockerId)) {
          task.blockedBy.push(blockerId)
        }
      }

      const addBlocks = normalizeStringList(input.addBlocks)
      for (const blockedId of addBlocks) {
        if (!task.blocks.includes(blockedId)) {
          task.blocks.push(blockedId)
        }
      }

      if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
        const nextMetadata = { ...(task.metadata ?? {}) }
        for (const [key, value] of Object.entries(input.metadata)) {
          if (value === null) {
            delete nextMetadata[key]
          } else {
            nextMetadata[key] = value
          }
        }
        if (Object.keys(nextMetadata).length > 0) {
          task.metadata = nextMetadata
        } else {
          delete task.metadata
        }
      }

      task.updatedAt = nowTs()
      await this.writeTaskUnsafe(scopeKey, task)
      return task
    })
  }

  async delete(scopeKey: string, taskId: string): Promise<boolean> {
    return await this.withLock(scopeKey, async () => {
      const safeTaskId = toNonEmptyString(taskId, 'taskId')
      const filePath = this.taskFilePath(scopeKey, safeTaskId)
      if (!existsSync(filePath)) {
        return false
      }
      await rm(filePath, { force: true })
      return true
    })
  }

  async get(scopeKey: string, taskId: string): Promise<TaskItem | null> {
    await this.ensureInitialized(scopeKey)
    return await this.readTaskUnsafe(scopeKey, taskId)
  }

  async list(scopeKey: string): Promise<TaskItem[]> {
    await this.ensureInitialized(scopeKey)
    const entries = await readdir(this.tasksDir(scopeKey), { withFileTypes: true })
    const tasks: TaskItem[] = []
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== '.json' || entry.name.includes('.tmp.')) {
        continue
      }
      const text = await readFile(join(this.tasksDir(scopeKey), entry.name), 'utf8')
      const normalized = normalizeTaskRecord(JSON.parse(text) as unknown)
      if (normalized) {
        tasks.push(normalized)
      }
    }
    tasks.sort((a, b) => compareTaskIds(a.id, b.id))
    return tasks
  }
}

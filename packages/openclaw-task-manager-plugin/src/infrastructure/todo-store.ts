import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TodoItem } from '../domain/task-item.js'
import { isTodoStatus } from '../domain/task-status.js'
import { TaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'

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

function normalizeTodoForCompare(todo: TodoItem): TodoItem {
  return {
    ...(todo.id ? { id: todo.id } : {}),
    content: todo.content,
    ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
    status: todo.status,
    ...(todo.owner ? { owner: todo.owner } : {}),
  }
}

function todosEqual(left: TodoItem[], right: TodoItem[]): boolean {
  return JSON.stringify(left.map(normalizeTodoForCompare)) === JSON.stringify(right.map(normalizeTodoForCompare))
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 8_000
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
      await sleep(50)
    }
  }
  throw new TaskStoreError('store_unavailable', 'Todo store lock timeout')
}

export class TodoStore {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  private scopeDir(): string {
    return join(this.rootDir, 'todos')
  }

  private todoFilePath(scopeKey: string): string {
    return join(this.scopeDir(), `${sanitizeScopeKey(scopeKey)}.json`)
  }

  private lockPath(scopeKey: string): string {
    return join(this.scopeDir(), `${sanitizeScopeKey(scopeKey)}.lock`)
  }

  private async ensureInitialized(): Promise<void> {
    await mkdir(this.scopeDir(), { recursive: true })
  }

  private async readUnsafe(scopeKey: string): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
    const filePath = this.todoFilePath(scopeKey)
    if (!existsSync(filePath)) {
      return { todos: [] }
    }
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { todos: [] }
    }
    const record = parsed as Record<string, unknown>
    const todos = Array.isArray(record.todos)
      ? record.todos.filter((todo): todo is TodoItem => (
          Boolean(todo)
          && typeof todo === 'object'
          && !Array.isArray(todo)
          && typeof (todo as { content?: unknown }).content === 'string'
          && isTodoStatus((todo as { status?: unknown }).status)
        ))
      : []
    return {
      todos,
      ...(typeof record.updatedAt === 'number' ? { updatedAt: record.updatedAt } : {}),
    }
  }

  async save(scopeKey: string, oldTodos: TodoItem[], newTodos: TodoItem[]): Promise<{ todos: TodoItem[]; updatedAt: number }> {
    await this.ensureInitialized()
    const release = await acquireFileLock(this.lockPath(scopeKey))
    try {
      const current = await this.readUnsafe(scopeKey)
      if (!todosEqual(current.todos, oldTodos)) {
        throw new TaskStoreError('stale_todos', 'TodoWrite oldTodos does not match the current todo list; call TodoGet and retry')
      }
      const payload = {
        todos: newTodos,
        updatedAt: nowTs(),
      }
      const filePath = this.todoFilePath(scopeKey)
      const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
      await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmpPath, filePath)
      return payload
    } finally {
      await release()
    }
  }

  async load(scopeKey: string): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
    await this.ensureInitialized()
    return await this.readUnsafe(scopeKey)
  }
}

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TodoItem } from '../domain/task-item.js'
import { isTodoStatus } from '../domain/task-status.js'
import { toNonEmptyString } from '../shared/params.js'

function nowTs(): number {
  return Date.now()
}

function sanitizeScopeKey(scopeKey: string): string {
  const trimmed = toNonEmptyString(scopeKey, 'scopeKey')
  return trimmed.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
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

  private async ensureInitialized(): Promise<void> {
    await mkdir(this.scopeDir(), { recursive: true })
  }

  async save(scopeKey: string, todos: TodoItem[]): Promise<{ todos: TodoItem[]; updatedAt: number }> {
    await this.ensureInitialized()
    const payload = {
      todos,
      updatedAt: nowTs(),
    }
    const filePath = this.todoFilePath(scopeKey)
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmpPath, filePath)
    return payload
  }

  async load(scopeKey: string): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
    await this.ensureInitialized()
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
}

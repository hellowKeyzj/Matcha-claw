import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionRecord } from '../protocol/types.js'

export class SessionIndex {
  private readonly storageRoot: string
  private indexMutationQueue: Promise<void> = Promise.resolve()

  constructor(options: { storageRoot: string }) {
    this.storageRoot = options.storageRoot
  }

  async writeAll(
    records: SessionRecord[] | Map<string, SessionRecord>,
  ): Promise<void> {
    const sessions = Array.isArray(records)
      ? records
      : Array.from(records.values())
    const filePath = this.indexPath()
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(sessions)}\n`, 'utf8')
  }

  async readAll(): Promise<SessionRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.indexPath(), 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return []
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || !parsed.every(isSessionRecordShape))
        return []
      return parsed
    } catch {
      return []
    }
  }

  upsert(record: SessionRecord): Promise<void> {
    return this.enqueueIndexMutation(async () => {
      const recordsById = new Map<string, SessionRecord>()
      for (const existing of await this.readAll()) {
        recordsById.set(existing.sessionId, existing)
      }
      recordsById.set(record.sessionId, record)
      await this.writeAll(recordsById)
    })
  }

  remove(sessionId: string): Promise<void> {
    return this.enqueueIndexMutation(async () => {
      const records = (await this.readAll()).filter(
        record => record.sessionId !== sessionId,
      )
      await this.writeAll(records)
    })
  }

  private enqueueIndexMutation(mutation: () => Promise<void>): Promise<void> {
    const operation = this.indexMutationQueue.then(mutation)
    this.indexMutationQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private indexPath(): string {
    return join(this.storageRoot, 'sessions', 'index.json')
  }
}

function isSessionRecordShape(value: unknown): value is SessionRecord {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    value.runtime === 'matcha-agent' &&
    typeof value.lastSeq === 'number' &&
    Number.isFinite(value.lastSeq) &&
    typeof value.lastSnapshotVersion === 'number' &&
    Number.isFinite(value.lastSnapshotVersion) &&
    isRecord(value.workerState)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

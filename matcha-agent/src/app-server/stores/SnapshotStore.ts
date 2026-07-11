import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionSnapshot } from '../protocol/types.js'
import { sessionStorageDirectoryName } from './sessionStoragePath.js'

export class SnapshotStore {
  private readonly storageRoot: string
  private readonly snapshotWriteQueues = new Map<string, Promise<void>>()

  constructor(options: { storageRoot: string }) {
    this.storageRoot = options.storageRoot
  }

  async readLatest(sessionId: string): Promise<SessionSnapshot | undefined> {
    let raw: string
    try {
      raw = await readFile(this.snapshotPath(sessionId), 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) return undefined
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isSessionSnapshotShape(parsed)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  writeLatest(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    return this.enqueueSnapshotWrite(sessionId, async () => {
      const existingSnapshot = await this.readLatest(sessionId)
      if (
        existingSnapshot !== undefined &&
        existingSnapshot.version > snapshot.version
      ) {
        return
      }

      const filePath = this.snapshotPath(sessionId)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(snapshot)}\n`, 'utf8')
    })
  }

  private enqueueSnapshotWrite(
    sessionId: string,
    writeSnapshot: () => Promise<void>,
  ): Promise<void> {
    const previousWrite =
      this.snapshotWriteQueues.get(sessionId) ?? Promise.resolve()
    const operation = previousWrite.then(writeSnapshot)
    const queueTail = operation.then(
      () => undefined,
      () => undefined,
    )

    this.snapshotWriteQueues.set(sessionId, queueTail)
    void queueTail.finally(() => {
      if (this.snapshotWriteQueues.get(sessionId) === queueTail) {
        this.snapshotWriteQueues.delete(sessionId)
      }
    })

    return operation
  }

  private snapshotPath(sessionId: string): string {
    return join(
      this.storageRoot,
      'sessions',
      sessionStorageDirectoryName(sessionId),
      'snapshot.json',
    )
  }
}

function isSessionSnapshotShape(value: unknown): value is SessionSnapshot {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    typeof value.version === 'number' &&
    Number.isFinite(value.version) &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.runs) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.pendingApprovals)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

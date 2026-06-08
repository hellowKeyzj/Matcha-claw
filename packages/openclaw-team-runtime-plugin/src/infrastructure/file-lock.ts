import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

export interface FileLockOptions {
  retryDelayMs?: number
  timeoutMs?: number
}

export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 10
  const timeoutMs = options.timeoutMs ?? 5_000
  const startedAt = Date.now()
  await mkdir(path.dirname(lockPath), { recursive: true })

  while (true) {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8')
      return await task()
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
      }
      if (!isExclusiveCreateFailure(error)) {
        throw error
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file lock: ${lockPath}`)
      }
      await delay(retryDelayMs)
    } finally {
      if (handle) {
        await handle.close().catch(() => {})
        await rm(lockPath, { force: true }).catch(() => {})
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isExclusiveCreateFailure(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

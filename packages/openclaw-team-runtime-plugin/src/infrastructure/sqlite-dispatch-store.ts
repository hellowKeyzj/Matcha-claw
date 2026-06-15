import initSqlJs, { type Database } from 'sql.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TeamDispatchQueueEntry, TeamDispatchQueueItemStatus } from '../domain/team-dispatch-queue.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'

export interface SqliteDispatchStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
  storageRoot: string
}

export class SqliteDispatchStore {
  private db: Database | null = null
  private dbPath: string
  private claimLock: Promise<void> = Promise.resolve()
  private initPromise: Promise<void> | null = null

  constructor(private readonly deps: SqliteDispatchStoreDeps) {
    this.dbPath = path.join(deps.storageRoot, 'dispatch-queue.db')
  }

  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    const SQL = await initSqlJs()
    await mkdir(path.dirname(this.dbPath), { recursive: true })
    try {
      const buffer = await readFile(this.dbPath)
      this.db = new SQL.Database(buffer)
    } catch {
      this.db = new SQL.Database()
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dispatch_queue (
        queueItemId TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        toRoleId TEXT NOT NULL,
        taskId TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        idempotencyKey TEXT NOT NULL UNIQUE,
        createdAt INTEGER NOT NULL,
        dispatchedAt INTEGER,
        failureReason TEXT
      )
    `)
    this.db.run('CREATE INDEX IF NOT EXISTS idx_dispatch_pending ON dispatch_queue(runId, status)')
    await this.persist()
  }

  async enqueue(entry: Omit<TeamDispatchQueueEntry, 'queueItemId' | 'status' | 'createdAt'>): Promise<{ item: TeamDispatchQueueEntry; created: boolean }> {
    await this.init()
    this.ensureDb()
    const existing = this.db!.exec('SELECT queueItemId FROM dispatch_queue WHERE idempotencyKey = ?', [entry.idempotencyKey])
    if (existing.length > 0 && existing[0].values.length > 0) {
      const row = existing[0].values[0]
      const item = this.rowToEntry(row, entry)
      return { item, created: false }
    }
    const queueItemId = this.deps.idGenerator.randomId()
    const createdAt = this.deps.clock.nowMs()
    this.db!.run(
      'INSERT INTO dispatch_queue (queueItemId, runId, toRoleId, taskId, prompt, status, idempotencyKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [queueItemId, entry.runId, entry.toRoleId, entry.taskId ?? null, entry.prompt, 'pending', entry.idempotencyKey, createdAt],
    )
    await this.persist()
    const item: TeamDispatchQueueEntry = { ...entry, queueItemId, status: 'pending', createdAt }
    return { item, created: true }
  }

  async claimPending(runId: string): Promise<TeamDispatchQueueEntry[]> {
    await this.init()
    this.ensureDb()
    // Serialize concurrent claim calls to prevent double-claim race condition.
    // sql.js is synchronous, so the lock only needs to span the SELECT+UPDATE.
    let resolve!: () => void
    const locked = new Promise<void>((r) => { resolve = r })
    const prev = this.claimLock
    this.claimLock = locked
    await prev

    try {
      const results = this.db!.exec('SELECT * FROM dispatch_queue WHERE runId = ? AND status = ?', [runId, 'pending'])
      if (results.length === 0 || results[0].values.length === 0) {
        return []
      }
      const now = this.deps.clock.nowMs()
      this.db!.run('UPDATE dispatch_queue SET status = ?, dispatchedAt = ? WHERE runId = ? AND status = ?', ['dispatched', now, runId, 'pending'])
      await this.persist()
      return results[0].values.map((row) => this.rowToFullEntry(row))
    } finally {
      resolve()
    }
  }

  async markDispatched(_runId: string, queueItemId: string): Promise<void> {
    await this.init()
    this.ensureDb()
    this.db!.run('UPDATE dispatch_queue SET status = ?, dispatchedAt = ? WHERE queueItemId = ?', ['dispatched', this.deps.clock.nowMs(), queueItemId])
    await this.persist()
  }

  async markFailed(_runId: string, queueItemId: string, reason: string): Promise<void> {
    await this.init()
    this.ensureDb()
    this.db!.run('UPDATE dispatch_queue SET status = ?, failureReason = ? WHERE queueItemId = ?', ['failed', reason, queueItemId])
    await this.persist()
  }

  async cancelPending(runId: string, reason: string): Promise<TeamDispatchQueueEntry[]> {
    await this.init()
    this.ensureDb()
    const results = this.db!.exec('SELECT * FROM dispatch_queue WHERE runId = ? AND status = ?', [runId, 'pending'])
    if (results.length === 0 || results[0].values.length === 0) {
      return []
    }
    this.db!.run('UPDATE dispatch_queue SET status = ?, failureReason = ? WHERE runId = ? AND status = ?', ['cancelled', reason, runId, 'pending'])
    await this.persist()
    return results[0].values.map((row) => ({
      ...this.rowToFullEntry(row),
      status: 'cancelled' as const,
      failureReason: reason,
    }))
  }

  async read(runId: string): Promise<TeamDispatchQueueEntry[]> {
    await this.init()
    this.ensureDb()
    const results = this.db!.exec('SELECT * FROM dispatch_queue WHERE runId = ?', [runId])
    if (results.length === 0) return []
    return results[0].values.map((row) => this.rowToFullEntry(row))
  }

  async hasPending(runId: string): Promise<boolean> {
    await this.init()
    this.ensureDb()
    const results = this.db!.exec('SELECT 1 FROM dispatch_queue WHERE runId = ? AND status = ? LIMIT 1', [runId, 'pending'])
    return results.length > 0 && results[0].values.length > 0
  }

  private ensureDb(): void {
    if (!this.db) throw new Error('SqliteDispatchStore not initialized. Call init() first.')
  }

  private async persist(): Promise<void> {
    if (!this.db) return
    const data = this.db.export()
    try {
      await writeFile(this.dbPath, Buffer.from(data))
    } catch (error) {
      console.error('[SqliteDispatchStore] persist failed:', error)
    }
  }

  private rowToFullEntry(row: unknown[]): TeamDispatchQueueEntry {
    return {
      queueItemId: String(row[0]),
      runId: String(row[1]),
      toRoleId: String(row[2]),
      taskId: row[3] != null ? String(row[3]) : undefined,
      prompt: String(row[4]),
      status: String(row[5]) as TeamDispatchQueueItemStatus,
      idempotencyKey: String(row[6]),
      createdAt: Number(row[7]),
      dispatchedAt: row[8] != null ? Number(row[8]) : undefined,
      failureReason: row[9] != null ? String(row[9]) : undefined,
    }
  }

  private rowToEntry(row: unknown[], override: Partial<TeamDispatchQueueEntry>): TeamDispatchQueueEntry {
    const base = this.rowToFullEntry(row)
    return { ...base, ...override, queueItemId: base.queueItemId, createdAt: base.createdAt }
  }
}

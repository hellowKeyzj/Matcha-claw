import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TeamInboundEnvelope, TeamOutboxRecord, TeamOutboxRecordStatus } from '../domain/team-outbox.js'

export interface SqliteTeamOutboxStoreDeps {
  readonly databasePath: string
  readonly nowMs: () => number
  readonly randomId: () => string
}

interface TeamOutboxRow {
  readonly run_id: unknown
  readonly sequence: unknown
  readonly record_id: unknown
  readonly idempotency_key: unknown
  readonly envelope_json: unknown
  readonly status: unknown
  readonly claimed_by: unknown
  readonly claim_expires_at: unknown
  readonly created_at: unknown
  readonly acked_at: unknown
}

export class SqliteTeamOutboxStore {
  private readonly database: DatabaseSync

  constructor(private readonly deps: SqliteTeamOutboxStoreDeps) {
    mkdirSync(path.dirname(deps.databasePath), { recursive: true })
    this.database = new DatabaseSync(deps.databasePath)
    this.initializeDatabase()
  }

  async append(envelope: TeamInboundEnvelope): Promise<TeamOutboxRecord> {
    assertNonEmptyString(envelope.runId, 'envelope.runId')
    assertNonEmptyString(envelope.idempotencyKey, 'envelope.idempotencyKey')

    const record = this.runImmediateTransaction(() => {
      const existing = this.getRecordByIdempotencyKey(envelope.runId, envelope.idempotencyKey)
      if (existing) {
        return existing
      }

      const record: TeamOutboxRecord = {
        recordId: `team-outbox-${this.deps.randomId()}`,
        runId: envelope.runId,
        sequence: this.nextSequence(envelope.runId),
        idempotencyKey: envelope.idempotencyKey,
        envelope,
        status: 'pending',
        createdAt: this.deps.nowMs(),
      }

      this.database.prepare(`
        INSERT INTO team_outbox_records (
          run_id,
          sequence,
          record_id,
          idempotency_key,
          envelope_json,
          status,
          claimed_by,
          claim_expires_at,
          created_at,
          acked_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
      `).run(
        record.runId,
        record.sequence,
        record.recordId,
        record.idempotencyKey,
        JSON.stringify(record.envelope),
        record.createdAt,
      )

      return record
    })

    return record
  }

  close(): void {
    this.database.close()
  }

  private initializeDatabase(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS team_outbox_records (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        record_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'acked')),
        claimed_by TEXT,
        claim_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        acked_at INTEGER,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (run_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS team_outbox_pull_idx
        ON team_outbox_records (run_id, status, sequence, claim_expires_at);
      CREATE INDEX IF NOT EXISTS team_outbox_dirty_runs_idx
        ON team_outbox_records (status, claim_expires_at, run_id, sequence);
    `)
  }

  private getRecordByIdempotencyKey(runId: string, idempotencyKey: string): TeamOutboxRecord | null {
    const row = this.database.prepare(`
      SELECT
        run_id,
        sequence,
        record_id,
        idempotency_key,
        envelope_json,
        status,
        claimed_by,
        claim_expires_at,
        created_at,
        acked_at
      FROM team_outbox_records
      WHERE run_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(runId, idempotencyKey)

    return row ? readOutboxRecord(row) : null
  }

  private nextSequence(runId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM team_outbox_records
      WHERE run_id = ?
    `).get(runId)
    return readInteger(readRecord(row).next_sequence, 'next_sequence')
  }

  private runImmediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function readOutboxRecord(row: unknown): TeamOutboxRecord {
  const record = readRecord(row) as unknown as TeamOutboxRow
  const claimedBy = readOptionalString(record.claimed_by, 'claimed_by')
  const claimExpiresAt = readOptionalInteger(record.claim_expires_at, 'claim_expires_at')
  const ackedAt = readOptionalInteger(record.acked_at, 'acked_at')

  return {
    recordId: readString(record.record_id, 'record_id'),
    runId: readString(record.run_id, 'run_id'),
    sequence: readInteger(record.sequence, 'sequence'),
    idempotencyKey: readString(record.idempotency_key, 'idempotency_key'),
    envelope: readEnvelope(record.envelope_json),
    status: readOutboxStatus(record.status),
    ...(claimedBy ? { claimedBy } : {}),
    ...(claimExpiresAt === undefined ? {} : { claimExpiresAt }),
    ...(ackedAt === undefined ? {} : { ackedAt }),
    createdAt: readInteger(record.created_at, 'created_at'),
  }
}

function readEnvelope(value: unknown): TeamInboundEnvelope {
  const parsed = JSON.parse(readString(value, 'envelope_json'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('envelope_json must contain a TeamInboundEnvelope object')
  }
  return parsed as TeamInboundEnvelope
}

function readOutboxStatus(value: unknown): TeamOutboxRecordStatus {
  if (value === 'pending' || value === 'claimed' || value === 'acked') {
    return value
  }
  throw new Error('status must be pending, claimed, or acked')
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error('SQLite row must be an object')
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value
  }
  throw new Error(`${fieldName} must be a non-empty string`)
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  return readString(value, fieldName)
}

function readInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  throw new Error(`${fieldName} must be a safe integer`)
}

function readOptionalInteger(value: unknown, fieldName: string): number | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  return readInteger(value, fieldName)
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
}

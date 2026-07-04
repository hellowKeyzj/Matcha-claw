import { DatabaseSync } from 'node:sqlite';
import type { TeamAgentCommand, TeamAgentCommandLedgerRecord, TeamAgentCommandStatus, TeamAgentCommandType } from '../../../domain/team-command-ledger';
import type { AppendTeamAgentCommandInput, TeamCommandLedgerPort } from '../../../ports/team-command-ledger-port';

export interface SqliteTeamCommandLedgerDeps {
  readonly databasePath: string;
  readonly ensureDatabaseDirectory: () => Promise<void>;
  readonly nowMs: () => number;
  readonly randomId: () => string;
}

interface TeamCommandLedgerRow {
  readonly run_id: unknown;
  readonly sequence: unknown;
  readonly record_id: unknown;
  readonly command_id: unknown;
  readonly command_type: unknown;
  readonly idempotency_key: unknown;
  readonly command_json: unknown;
  readonly status: unknown;
  readonly rejection_reason: unknown;
  readonly created_at: unknown;
  readonly accepted_at: unknown;
  readonly rejected_at: unknown;
}

export class SqliteTeamCommandLedger implements TeamCommandLedgerPort {
  private readonly database: DatabaseSync;

  private constructor(private readonly deps: SqliteTeamCommandLedgerDeps) {
    this.database = new DatabaseSync(deps.databasePath);
    this.initializeDatabase();
  }

  static async open(deps: SqliteTeamCommandLedgerDeps): Promise<SqliteTeamCommandLedger> {
    await deps.ensureDatabaseDirectory();
    return new SqliteTeamCommandLedger(deps);
  }

  async append(input: AppendTeamAgentCommandInput): Promise<TeamAgentCommandLedgerRecord> {
    assertNonEmptyString(input.command.runId, 'command.runId');
    assertNonEmptyString(input.command.idempotencyKey, 'command.idempotencyKey');

    return this.runImmediateTransaction(() => {
      const existing = this.getRecordByIdempotencyKey(input.command.runId, input.command.idempotencyKey);
      if (existing) return existing;

      const sequence = this.nextSequence(input.command.runId);
      const now = this.deps.nowMs();
      const record: TeamAgentCommandLedgerRecord = {
        recordId: `team-command-${this.deps.randomId()}`,
        runId: input.command.runId,
        sequence,
        commandId: input.command.commandId,
        type: input.command.type,
        idempotencyKey: input.command.idempotencyKey,
        command: input.command,
        status: input.status,
        ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
        createdAt: now,
        ...(input.status === 'accepted' ? { acceptedAt: now } : { rejectedAt: now }),
      };

      this.database.prepare(`
        INSERT INTO team_command_ledger_records (
          run_id,
          sequence,
          record_id,
          command_id,
          command_type,
          idempotency_key,
          command_json,
          status,
          rejection_reason,
          created_at,
          accepted_at,
          rejected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.runId,
        record.sequence,
        record.recordId,
        record.commandId,
        record.type,
        record.idempotencyKey,
        JSON.stringify(record.command),
        record.status,
        record.rejectionReason ?? null,
        record.createdAt,
        record.acceptedAt ?? null,
        record.rejectedAt ?? null,
      );

      return record;
    });
  }

  close(): void {
    this.database.close();
  }

  private initializeDatabase(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS team_command_ledger_records (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        record_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_type TEXT NOT NULL CHECK (command_type IN ('team.node_event', 'team.graph_patch')),
        idempotency_key TEXT NOT NULL,
        command_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
        rejection_reason TEXT,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        rejected_at INTEGER,
        PRIMARY KEY (run_id, sequence),
        UNIQUE (run_id, idempotency_key),
        UNIQUE (run_id, command_id)
      );

      CREATE INDEX IF NOT EXISTS team_command_ledger_run_type_idx
        ON team_command_ledger_records (run_id, command_type, sequence);
      CREATE INDEX IF NOT EXISTS team_command_ledger_status_idx
        ON team_command_ledger_records (status, run_id, sequence);
    `);
  }

  private getRecordByIdempotencyKey(runId: string, idempotencyKey: string): TeamAgentCommandLedgerRecord | null {
    const row = this.database.prepare(`
      SELECT
        run_id,
        sequence,
        record_id,
        command_id,
        command_type,
        idempotency_key,
        command_json,
        status,
        rejection_reason,
        created_at,
        accepted_at,
        rejected_at
      FROM team_command_ledger_records
      WHERE run_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(runId, idempotencyKey);

    return row ? readLedgerRecord(row) : null;
  }

  private nextSequence(runId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM team_command_ledger_records
      WHERE run_id = ?
    `).get(runId);
    return readInteger(readRecord(row).next_sequence, 'next_sequence');
  }

  private runImmediateTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function readLedgerRecord(row: unknown): TeamAgentCommandLedgerRecord {
  const record = readRecord(row) as unknown as TeamCommandLedgerRow;
  const rejectionReason = readOptionalString(record.rejection_reason, 'rejection_reason');
  const acceptedAt = readOptionalInteger(record.accepted_at, 'accepted_at');
  const rejectedAt = readOptionalInteger(record.rejected_at, 'rejected_at');
  return {
    recordId: readString(record.record_id, 'record_id'),
    runId: readString(record.run_id, 'run_id'),
    sequence: readInteger(record.sequence, 'sequence'),
    commandId: readString(record.command_id, 'command_id'),
    type: readCommandType(record.command_type),
    idempotencyKey: readString(record.idempotency_key, 'idempotency_key'),
    command: readCommand(record.command_json),
    status: readCommandStatus(record.status),
    ...(rejectionReason ? { rejectionReason } : {}),
    createdAt: readInteger(record.created_at, 'created_at'),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    ...(rejectedAt === undefined ? {} : { rejectedAt }),
  };
}

function readCommand(value: unknown): TeamAgentCommand {
  const rawCommand = readString(value, 'command_json');
  const parsed = JSON.parse(rawCommand);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('command_json must contain a TeamAgentCommand object');
  }
  return parsed as TeamAgentCommand;
}

function readCommandType(value: unknown): TeamAgentCommandType {
  if (value === 'team.node_event' || value === 'team.graph_patch') return value;
  throw new Error('command_type must be team.node_event or team.graph_patch');
}

function readCommandStatus(value: unknown): TeamAgentCommandStatus {
  if (value === 'accepted' || value === 'rejected') return value;
  throw new Error('status must be accepted or rejected');
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('SQLite row must be an object');
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new Error(`${fieldName} must be a non-empty string`);
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return readString(value, fieldName);
}

function readInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error(`${fieldName} must be a safe integer`);
}

function readOptionalInteger(value: unknown, fieldName: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return readInteger(value, fieldName);
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

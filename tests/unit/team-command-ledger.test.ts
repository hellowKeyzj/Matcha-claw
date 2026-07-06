import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTeamCommandLedger } from '../../runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-command-ledger';
import type { TeamGraphPatchCommand, TeamNodeEventCommand } from '../../runtime-host/application/team-runtime/domain/team-command-ledger';

const runtimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const tempDirs: string[] = [];

async function createTestLedger() {
  const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-team-command-ledger-'));
  tempDirs.push(tempDir);
  const databasePath = join(tempDir, 'team-command-ledger.sqlite');
  let nowMs = 1000;
  let nextId = 1;
  const ledger = await SqliteTeamCommandLedger.open({
    databasePath,
    ensureDatabaseDirectory: async () => {
      await mkdir(tempDir, { recursive: true });
    },
    nowMs: () => nowMs,
    randomId: () => `id-${nextId++}`,
  });

  return {
    ledger,
    databasePath,
    setNowMs: (value: number) => {
      nowMs = value;
    },
  };
}

function readJournalMode(databasePath: string): string {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown };
    return String(row.journal_mode);
  } finally {
    database.close();
  }
}

function buildNodeEventCommand(overrides: Partial<TeamNodeEventCommand> = {}): TeamNodeEventCommand {
  return {
    type: 'team.node_event',
    commandId: 'command-node-1',
    runId: 'run-1',
    idempotencyKey: 'node-event-1',
    sourceEndpoint: runtimeEndpoint,
    sourceAgentId: 'agent-1',
    sourceRuntimeAdapterId: 'openclaw',
    sourceRoleId: 'reviewer',
    sourceLocalSessionId: 'local-session-1',
    sourceEndpointSessionId: 'endpoint-session-1',
    createdAt: 900,
    nodeExecutionId: 'node-execution-1',
    event: 'complete',
    roleId: 'reviewer',
    summary: 'Node completed',
    outputPort: 'done',
    evidenceRefs: [{ type: 'artifact', id: 'artifact-1', label: 'Evidence' }],
    metadata: { confidence: 0.9 },
    ...overrides,
  };
}

function buildGraphPatchCommand(overrides: Partial<TeamGraphPatchCommand> = {}): TeamGraphPatchCommand {
  return {
    type: 'team.graph_patch',
    commandId: 'command-patch-1',
    runId: 'run-1',
    idempotencyKey: 'graph-patch-1',
    sourceEndpoint: runtimeEndpoint,
    sourceAgentId: 'agent-1',
    sourceRuntimeAdapterId: 'openclaw',
    sourceRoleId: 'reviewer',
    sourceLocalSessionId: 'local-session-1',
    sourceEndpointSessionId: 'endpoint-session-1',
    createdAt: 950,
    summary: 'Add review node',
    patch: {
      baseGraphId: 'graph-1',
      baseWorkflowPlanId: 'plan-1',
      operations: [
        { op: 'add_node', node: { nodeId: 'review', kind: 'work', title: 'Review', roleId: 'reviewer' } },
        { op: 'set_metadata', metadata: { owner: 'agent-1' } },
      ],
    },
    metadata: { reason: 'coverage' },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SqliteTeamCommandLedger', () => {
  it('persists accepted and rejected commands with WAL, per-run sequence, idempotency, and command JSON roundtrip', async () => {
    const { ledger, databasePath, setNowMs } = await createTestLedger();

    try {
      expect(readJournalMode(databasePath)).toBe('wal');

      const acceptedCommand = buildNodeEventCommand();
      const acceptedRecord = await ledger.append({ command: acceptedCommand, status: 'accepted' });

      expect(acceptedRecord).toEqual(expect.objectContaining({
        recordId: 'team-command-id-1',
        runId: 'run-1',
        sequence: 1,
        commandId: 'command-node-1',
        type: 'team.node_event',
        idempotencyKey: 'node-event-1',
        status: 'accepted',
        createdAt: 1000,
        acceptedAt: 1000,
      }));
      expect(acceptedRecord.rejectedAt).toBeUndefined();
      expect(acceptedRecord.rejectionReason).toBeUndefined();
      expect(acceptedRecord.command).toEqual(acceptedCommand);

      setNowMs(5000);
      const idempotentRecord = await ledger.append({
        command: buildNodeEventCommand({
          commandId: 'command-node-retry',
          summary: 'Changed retry payload must not overwrite the original command',
        }),
        status: 'rejected',
        rejectionReason: 'retry should be ignored',
      });

      expect(idempotentRecord).toEqual(acceptedRecord);

      setNowMs(2000);
      const rejectedCommand = buildGraphPatchCommand();
      const rejectedRecord = await ledger.append({
        command: rejectedCommand,
        status: 'rejected',
        rejectionReason: 'nodeExecutionId is not active',
      });

      expect(rejectedRecord).toEqual(expect.objectContaining({
        recordId: 'team-command-id-2',
        runId: 'run-1',
        sequence: 2,
        commandId: 'command-patch-1',
        type: 'team.graph_patch',
        idempotencyKey: 'graph-patch-1',
        status: 'rejected',
        rejectionReason: 'nodeExecutionId is not active',
        createdAt: 2000,
        rejectedAt: 2000,
      }));
      expect(rejectedRecord.acceptedAt).toBeUndefined();
      expect(rejectedRecord.command).toEqual(rejectedCommand);

      setNowMs(3000);
      const otherRunRecord = await ledger.append({
        command: buildGraphPatchCommand({
          commandId: 'command-other-run-1',
          runId: 'run-2',
          idempotencyKey: 'graph-patch-other-run-1',
        }),
        status: 'accepted',
      });

      expect(otherRunRecord).toEqual(expect.objectContaining({
        runId: 'run-2',
        sequence: 1,
        status: 'accepted',
        acceptedAt: 3000,
      }));
    } finally {
      ledger.close();
    }
  });
});

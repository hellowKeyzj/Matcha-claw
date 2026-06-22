import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTeamOutboxStore } from '../../runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-outbox-store';
import type { TeamInboundEnvelope } from '../../runtime-host/application/team-runtime/domain/team-envelope';

function buildEnvelope(overrides: Partial<TeamInboundEnvelope> = {}): TeamInboundEnvelope {
  return {
    type: 'task.completed',
    envelopeId: 'envelope-1',
    runId: 'run-1',
    sourceEndpoint: {
      kind: 'native-runtime',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    },
    sourceAgentId: 'agent-1',
    sourceSessionKey: 'session-1',
    sourceRoleId: 'role-1',
    workflowTaskId: 'task-1',
    roleId: 'role-1',
    summary: 'done',
    idempotencyKey: 'idem-1',
    createdAt: 10,
    ...overrides,
  } as TeamInboundEnvelope;
}

async function withStore<T>(
  run: (store: SqliteTeamOutboxStore) => Promise<T>,
  options: { nowMs?: () => number; randomId?: () => string } = {},
): Promise<T> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-outbox-store-'));
  try {
    const databasePath = path.join(storageRoot, 'team-runtime', 'outbox.sqlite');
    const store = await SqliteTeamOutboxStore.open({
      databasePath,
      ensureDatabaseDirectory: async () => { await mkdir(path.dirname(databasePath), { recursive: true }); },
      nowMs: options.nowMs ?? (() => 1000),
      randomId: options.randomId ?? (() => 'record'),
    });
    try {
      return await run(store);
    } finally {
      store.close();
    }
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
}

describe('SqliteTeamOutboxStore', () => {
  it('按 run sequence 追加、拉取并 ack outbox', async () => {
    await withStore(async (store) => {
      await store.append(buildEnvelope());
      await store.append(buildEnvelope({ envelopeId: 'envelope-2', workflowTaskId: 'task-2', idempotencyKey: 'idem-2' }));

      const pulled = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 1,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });

      expect(pulled.records.map((record) => record.sequence)).toEqual([1]);
      expect(pulled.hasMore).toBe(true);

      await store.ack({ runId: 'run-1', sequences: [1], consumerId: 'consumer-1' });
      const next = await store.pull({
        runId: 'run-1',
        afterSequence: 1,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });

      expect(next.records.map((record) => record.sequence)).toEqual([2]);
    });
  });

  it('同一 run 按 idempotencyKey 去重且不同 run 互不影响', async () => {
    let nextRecordId = 1;
    await withStore(async (store) => {
      const first = await store.append(buildEnvelope());
      const duplicate = await store.append(buildEnvelope({ envelopeId: 'different-envelope' }));
      const nextInSameRun = await store.append(buildEnvelope({ envelopeId: 'envelope-2', workflowTaskId: 'task-2', idempotencyKey: 'idem-2' }));
      const sameKeyInDifferentRun = await store.append(buildEnvelope({ runId: 'run-2', envelopeId: 'run-2-envelope' }));

      expect(duplicate).toEqual(first);
      expect(nextInSameRun.sequence).toBe(2);
      expect(sameKeyInDifferentRun.sequence).toBe(1);
      expect(sameKeyInDifferentRun.recordId).not.toBe(first.recordId);

      const runOne = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });
      const runTwo = await store.pull({
        runId: 'run-2',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });
      expect(runOne.records.map((record) => record.sequence)).toEqual([1, 2]);
      expect(runTwo.records.map((record) => record.sequence)).toEqual([1]);
    }, { randomId: () => `record-${nextRecordId++}` });
  });

  it('serializes concurrent appends per run and preserves the dirty-run index across runs', async () => {
    let nextRecordId = 1;
    await withStore(async (store) => {
      await Promise.all(Array.from({ length: 8 }, (_, index) => store.append(buildEnvelope({
        envelopeId: `run-1-envelope-${index}`,
        workflowTaskId: `task-${index}`,
        idempotencyKey: `run-1-idem-${index}`,
      }))));
      await Promise.all(['run-2', 'run-3', 'run-4'].map((runId) => store.append(buildEnvelope({
        runId,
        envelopeId: `${runId}-envelope`,
        idempotencyKey: `${runId}-idem`,
      }))));

      const runOne = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 20,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });
      expect(runOne.records.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      const runTwo = await store.pull({
        runId: 'run-2',
        afterSequence: 0,
        limit: 20,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });
      expect(runTwo.records.map((record) => record.sequence)).toEqual([1]);
    }, { randomId: () => `record-${nextRecordId++}` });
  });

  it('listDirtyRuns 只返回 pending 或租约过期的 claimed runs', async () => {
    let now = 1000;
    let nextRecordId = 1;
    await withStore(async (store) => {
      await store.append(buildEnvelope({ runId: 'run-pending', envelopeId: 'pending-1', idempotencyKey: 'pending-1' }));
      await store.append(buildEnvelope({ runId: 'run-pending', envelopeId: 'pending-2', idempotencyKey: 'pending-2' }));
      await store.append(buildEnvelope({ runId: 'run-active-claim', envelopeId: 'active-claim', idempotencyKey: 'active-claim' }));
      await store.append(buildEnvelope({ runId: 'run-expired-claim', envelopeId: 'expired-claim', idempotencyKey: 'expired-claim' }));
      await store.append(buildEnvelope({ runId: 'run-acked', envelopeId: 'acked-1', idempotencyKey: 'acked-1' }));

      await store.pull({ runId: 'run-active-claim', afterSequence: 0, limit: 10, consumerId: 'consumer-active', leaseMs: 1000 });
      await store.pull({ runId: 'run-expired-claim', afterSequence: 0, limit: 10, consumerId: 'consumer-expired', leaseMs: 100 });
      await store.pull({ runId: 'run-acked', afterSequence: 0, limit: 10, consumerId: 'consumer-ack', leaseMs: 1000 });
      await store.ack({ runId: 'run-acked', sequences: [1], consumerId: 'consumer-ack' });

      now = 1200;

      await expect(store.listDirtyRuns()).resolves.toEqual([
        { runId: 'run-expired-claim', latestSequence: 1, pendingCount: 1 },
        { runId: 'run-pending', latestSequence: 2, pendingCount: 2 },
      ]);
    }, { nowMs: () => now, randomId: () => `record-${nextRecordId++}` });
  });

  it('pull 会 claim、阻止其他 consumer 抢占、允许 owner 续租并在过期后释放', async () => {
    let now = 1000;
    await withStore(async (store) => {
      await store.append(buildEnvelope());

      const firstClaim = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 100,
      });

      expect(firstClaim.records).toMatchObject([
        { sequence: 1, status: 'claimed', claimedBy: 'consumer-1', claimExpiresAt: 1100 },
      ]);

      const blockedClaim = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-2',
        leaseMs: 100,
      });
      expect(blockedClaim.records).toEqual([]);
      expect(blockedClaim.hasMore).toBe(false);

      now = 1050;
      const renewedClaim = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 200,
      });
      expect(renewedClaim.records).toMatchObject([
        { sequence: 1, status: 'claimed', claimedBy: 'consumer-1', claimExpiresAt: 1250 },
      ]);

      now = 1251;
      const expiredLeaseClaim = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-2',
        leaseMs: 100,
      });
      expect(expiredLeaseClaim.records).toMatchObject([
        { sequence: 1, status: 'claimed', claimedBy: 'consumer-2', claimExpiresAt: 1351 },
      ]);
    }, { nowMs: () => now });
  });

  it('只有 claimed record 的 owner 可以 ack，acked record 后续 pull 不返回', async () => {
    let now = 1000;
    await withStore(async (store) => {
      await store.append(buildEnvelope());
      await store.append(buildEnvelope({ envelopeId: 'envelope-2', workflowTaskId: 'task-2', idempotencyKey: 'idem-2' }));
      await store.append(buildEnvelope({ envelopeId: 'envelope-3', workflowTaskId: 'task-3', idempotencyKey: 'idem-3' }));

      await store.ack({ runId: 'run-1', sequences: [3], consumerId: 'consumer-2' });

      const ownerClaim = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 2,
        consumerId: 'consumer-1',
        leaseMs: 100,
      });
      expect(ownerClaim.records.map((record) => record.sequence)).toEqual([1, 2]);

      await store.ack({ runId: 'run-1', sequences: [1], consumerId: 'consumer-2' });
      await store.ack({ runId: 'run-1', sequences: [2], consumerId: 'consumer-1' });

      now = 1101;
      await store.ack({ runId: 'run-1', sequences: [1], consumerId: 'consumer-1' });
      const afterOwnerAck = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-2',
        leaseMs: 100,
      });
      expect(afterOwnerAck.records.map((record) => record.sequence)).toEqual([1, 3]);

      await store.ack({ runId: 'run-1', sequences: [1, 3], consumerId: 'consumer-2' });
      const afterAllAcked = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-2',
        leaseMs: 100,
      });
      expect(afterAllAcked.records).toEqual([]);
      expect(afterAllAcked.hasMore).toBe(false);
    }, { nowMs: () => now });
  });

  it('pull 必须提供有效 limit，并按 limit 返回 hasMore', async () => {
    await withStore(async (store) => {
      await store.append(buildEnvelope());
      await store.append(buildEnvelope({ envelopeId: 'envelope-2', workflowTaskId: 'task-2', idempotencyKey: 'idem-2' }));
      await store.append(buildEnvelope({ envelopeId: 'envelope-3', workflowTaskId: 'task-3', idempotencyKey: 'idem-3' }));

      const firstPage = await store.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 2,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });
      expect(firstPage.records.map((record) => record.sequence)).toEqual([1, 2]);
      expect(firstPage.hasMore).toBe(true);

      const lastPage = await store.pull({
        runId: 'run-1',
        afterSequence: 2,
        limit: 2,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      });
      expect(lastPage.records.map((record) => record.sequence)).toEqual([3]);
      expect(lastPage.hasMore).toBe(false);
    });

    await withStore(async (store) => {
      await store.append(buildEnvelope());

      await expect(Reflect.apply(store.pull, store, [{
        runId: 'run-1',
        afterSequence: 0,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      }])).rejects.toThrow(/limit/i);

      await expect(store.ack({ runId: 'run-1', sequences: [-1], consumerId: 'consumer-1' })).rejects.toThrow(/sequences/i);

      for (const invalidLimit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.pull({
          runId: 'run-1',
          afterSequence: 0,
          limit: invalidLimit,
          consumerId: 'consumer-1',
          leaseMs: 30_000,
        })).rejects.toThrow(/limit/i);
      }
    });
  });
});

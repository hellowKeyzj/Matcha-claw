import { describe, expect, it, vi } from 'vitest';
import { TeamRuntimeOutboxPoller } from '../../runtime-host/application/team-runtime/team-runtime-outbox-poller';
import { TeamRunRegistry } from '../../runtime-host/application/team-runtime/team-run-registry';
import type { ApplicationResponseOf } from '../../runtime-host/application/common/application-response';
import type { TeamRuntimeOperationId } from '../../runtime-host/application/team-runtime/team-runtime-operation-id';
import type { RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';

function ok(data: unknown): ApplicationResponseOf {
  return { status: 200, data };
}

describe('TeamRuntimeOutboxPoller', () => {
  it('does not poll when the global run registry has no non-terminal runs', () => {
    vi.useFakeTimers();
    try {
      const listDirtyRuns = vi.fn(async () => []);
      const invoke = vi.fn(async () => ok({ success: true }));
      const poller = new TeamRuntimeOutboxPoller({
        runRegistry: new TeamRunRegistry(),
        dirtyRunStore: { listDirtyRuns },
        teamRuntimeService: { invoke },
        nowMs: () => 1000,
      });

      poller.refresh();
      vi.runOnlyPendingTimers();

      expect(listDirtyRuns).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      poller.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ticks only dirty runs that are present in the global non-terminal run registry', async () => {
    vi.useFakeTimers();
    try {
      const runRegistry = new TeamRunRegistry();
      runRegistry.upsert({ teamId: 'team-1', runId: 'run-active', status: 'running', revision: 1, updatedAt: 1000 });
      runRegistry.upsert({ teamId: 'team-1', runId: 'run-terminal', status: 'completed', revision: 2, updatedAt: 1001 });
      const listDirtyRuns = vi.fn(async () => [
        { runId: 'run-active', latestSequence: 2, pendingCount: 2 },
        { runId: 'run-terminal', latestSequence: 3, pendingCount: 1 },
        { runId: 'run-unknown', latestSequence: 4, pendingCount: 1 },
      ]);
      const invoke = vi.fn(async (_operationId: TeamRuntimeOperationId, _params: unknown, _scope?: RuntimeScope) => ok({ success: true }));
      const poller = new TeamRuntimeOutboxPoller({
        runRegistry,
        dirtyRunStore: { listDirtyRuns },
        teamRuntimeService: { invoke },
        nowMs: () => 5000,
        activeDelayMs: 1000,
        idleDelayMs: 3000,
        errorDelayMs: 6000,
      });

      poller.refresh();
      await vi.runOnlyPendingTimersAsync();

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith('team.runTick', {
        runId: 'run-active',
        idempotencyKey: 'team-runtime-poller:run-active:2:5000',
      });
      expect(vi.getTimerCount()).toBe(1);
      poller.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

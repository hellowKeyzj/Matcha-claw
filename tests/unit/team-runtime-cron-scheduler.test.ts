import { describe, expect, it, vi } from 'vitest';
import { TeamRuntimeCronScheduler, computeNextRunMs } from '../../runtime-host/application/team-runtime/team-runtime-cron-scheduler';
import { TeamRunRegistry } from '../../runtime-host/application/team-runtime/team-run-registry';
import type { TeamRuntimePort } from '../../runtime-host/application/team-runtime/team-runtime-port';

describe('TeamRuntimeCronScheduler', () => {
  it('computes the next cron occurrence and rejects invalid expressions', () => {
    const fromMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(computeNextRunMs('* * * * *', fromMs)).toBeGreaterThan(fromMs);
    expect(computeNextRunMs('not a cron', fromMs)).toBeNull();
  });

  it('fires due cron StartNode triggers through team.runtime', async () => {
    vi.useFakeTimers();
    try {
      let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
      const runRegistry = new TeamRunRegistry();
      runRegistry.upsert({ runId: 'run-1', status: 'running', revision: 1, updatedAt: nowMs });
      const invoke = vi.fn(async (operationId: string) => {
        if (operationId === 'team.triggerList') {
          return {
            status: 200,
            data: {
              triggers: [
                { runId: 'run-1', startNodeId: 'start-1', trigger: { mode: 'cron', cron: '* * * * *' } },
              ],
            },
          };
        }
        if (operationId === 'team.runSnapshot') {
          return { status: 200, data: { nodePromptDeliveries: [] } };
        }
        return { status: 200, data: { fired: true } };
      });
      const scheduler = new TeamRuntimeCronScheduler({
        runRegistry,
        teamRuntimeService: { invoke } as unknown as TeamRuntimePort,
        nowMs: () => nowMs,
        reconcileDelayMs: 60_000,
      });

      scheduler.refresh();
      await vi.runOnlyPendingTimersAsync();
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenCalledWith('team.triggerList', {});
      expect(invoke).toHaveBeenCalledWith('team.runSnapshot', { runId: 'run-1' });

      nowMs += 60_000;
      await vi.runOnlyPendingTimersAsync();
      expect(invoke).toHaveBeenCalledWith('team.triggerFire', {
        runId: 'run-1',
        startNodeId: 'start-1',
        triggerSource: 'cron',
        idempotencyKey: `team-cron:run-1:start-1:${nowMs}`,
      });
      scheduler.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes up scheduled node prompt retries without waiting for a cron trigger fire', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
      let nowMs = startMs;
      let retryDelivered = false;
      const retryAtMs = startMs + 5_000;
      const runRegistry = new TeamRunRegistry();
      runRegistry.upsert({ runId: 'run-retry', status: 'running', revision: 1, updatedAt: startMs });
      const invoke = vi.fn(async (operationId: string) => {
        if (operationId === 'team.triggerList') {
          return { status: 200, data: { triggers: [] } };
        }
        if (operationId === 'team.runSnapshot') {
          return {
            status: 200,
            data: {
              nodePromptDeliveries: retryDelivered
                ? []
                : [{ deliveryRecordId: 'delivery-1', status: 'retry_scheduled', nextRetryAt: retryAtMs }],
            },
          };
        }
        if (operationId === 'team.nodePromptRetryDue') {
          retryDelivered = true;
          return { status: 200, data: { processedDeliveryRecordIds: ['delivery-1'], nextRetryAt: null } };
        }
        throw new Error(`unexpected operation ${operationId}`);
      });
      const scheduler = new TeamRuntimeCronScheduler({
        runRegistry,
        teamRuntimeService: { invoke } as unknown as TeamRuntimePort,
        nowMs: () => nowMs,
        reconcileDelayMs: 60_000,
      });

      scheduler.refresh();
      await vi.runOnlyPendingTimersAsync();
      expect(invoke).not.toHaveBeenCalledWith('team.triggerFire', expect.anything());
      expect(invoke).not.toHaveBeenCalledWith('team.nodePromptRetryDue', expect.anything());

      nowMs = retryAtMs;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(invoke).toHaveBeenCalledWith('team.nodePromptRetryDue', { runId: 'run-retry' });
      expect(invoke).not.toHaveBeenCalledWith('team.triggerFire', expect.anything());
      scheduler.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears scheduled retry timers on close', async () => {
    vi.useFakeTimers();
    try {
      const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
      let nowMs = startMs;
      const retryAtMs = startMs + 5_000;
      const runRegistry = new TeamRunRegistry();
      runRegistry.upsert({ runId: 'run-retry', status: 'running', revision: 1, updatedAt: startMs });
      const invoke = vi.fn(async (operationId: string) => {
        if (operationId === 'team.triggerList') {
          return { status: 200, data: { triggers: [] } };
        }
        if (operationId === 'team.runSnapshot') {
          return {
            status: 200,
            data: {
              nodePromptDeliveries: [{ deliveryRecordId: 'delivery-1', status: 'retry_scheduled', nextRetryAt: retryAtMs }],
            },
          };
        }
        if (operationId === 'team.nodePromptRetryDue') {
          return { status: 200, data: { processedDeliveryRecordIds: ['delivery-1'], nextRetryAt: null } };
        }
        throw new Error(`unexpected operation ${operationId}`);
      });
      const scheduler = new TeamRuntimeCronScheduler({
        runRegistry,
        teamRuntimeService: { invoke } as unknown as TeamRuntimePort,
        nowMs: () => nowMs,
        reconcileDelayMs: 60_000,
      });

      scheduler.refresh();
      await vi.runOnlyPendingTimersAsync();
      scheduler.close();

      nowMs = retryAtMs;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(invoke).not.toHaveBeenCalledWith('team.nodePromptRetryDue', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

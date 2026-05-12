import { describe, expect, it, vi } from 'vitest';
import { BackgroundTaskManager } from '../../runtime-host/services/background-task-manager';
import type { RuntimeJobSnapshot } from '../../runtime-host/application/common/runtime-contracts';

function createManager(options: {
  now?: () => number;
  jobs?: RuntimeJobSnapshot[];
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const jobs = options.jobs ?? [];
  return new BackgroundTaskManager({
    jobQueries: {
      snapshotQueue: vi.fn(),
      listRegisteredTypes: vi.fn(() => []),
      list: vi.fn(() => jobs),
      listByType: vi.fn((type: string) => jobs.filter((job) => job.type === type)),
      get: vi.fn((jobId: string) => jobs.find((job) => job.id === jobId) ?? null),
    },
    timer: {
      sleep: options.sleep ?? vi.fn(async () => {}),
    },
    nowMs: options.now ?? (() => Date.now()),
  });
}

describe('BackgroundTaskManager', () => {
  it('waits for a running registered task to complete before returning output', async () => {
    let now = 1_000;
    let status: 'running' | 'completed' = 'running';
    const sleep = vi.fn(async () => {
      now += 250;
      status = 'completed';
    });
    const manager = createManager({ now: () => now, sleep });

    manager.registerTask({
      id: 'agent-1',
      sessionKey: 'session-1',
      kind: 'agent',
      status: () => status,
      result: () => status === 'completed' ? { answer: 'done' } : undefined,
    });

    await expect(manager.output('agent-1', { wait: true, timeoutMs: 2_000 }))
      .resolves.toMatchObject({
        id: 'agent-1',
        sessionKey: 'session-1',
        kind: 'agent',
        status: 'completed',
        result: { answer: 'done' },
      });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('returns shell stdout and stderr while keeping running status readable later', async () => {
    const manager = createManager({ now: () => 1_000 });

    manager.registerTask({
      id: 'shell-1',
      kind: 'shell',
      status: () => 'running',
      stdout: () => 'line 1\n',
      stderr: () => 'warn\n',
    });

    await expect(manager.output('shell-1')).resolves.toMatchObject({
      id: 'shell-1',
      kind: 'shell',
      status: 'running',
      stdout: 'line 1\n',
      stderr: 'warn\n',
    });
  });

  it('returns failed task error and completed runtime job result', async () => {
    const jobs: RuntimeJobSnapshot[] = [{
      id: 'job-1',
      type: 'agent.run',
      queue: 'default',
      status: 'succeeded',
      queuedAt: 10,
      startedAt: 20,
      finishedAt: 30,
      attempts: 1,
      maxAttempts: 1,
      result: { stdout: 'ok', sessionKey: 'session-1', value: 42 },
    }];
    const manager = createManager({ jobs });

    manager.registerTask({
      id: 'agent-failed',
      kind: 'agent',
      status: () => 'failed',
      error: () => 'boom',
    });

    await expect(manager.output('agent-failed')).resolves.toMatchObject({
      id: 'agent-failed',
      status: 'failed',
      error: 'boom',
    });
    await expect(manager.output('job-1')).resolves.toMatchObject({
      id: 'job-1',
      kind: 'agent',
      status: 'completed',
      stdout: 'ok',
      result: { stdout: 'ok', sessionKey: 'session-1', value: 42 },
    });
  });

  it('stops a registered background task through its cancel callback', async () => {
    const cancel = vi.fn(async () => {});
    const manager = createManager({ now: () => 1_000 });

    manager.registerTask({
      id: 'shell-kill',
      kind: 'shell',
      cancel,
    });

    await expect(manager.stop('shell-kill')).resolves.toMatchObject({
      success: true,
      task: {
        id: 'shell-kill',
        kind: 'shell',
        status: 'cancelled',
      },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/types/cron';

const hostApiFetchMock = vi.fn();
const hostCapabilityExecuteMock = vi.fn();
const waitForRuntimeJobResultMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: async (path: string, init?: { body?: string; timeoutMs?: number }) => {
    if (path === '/api/capabilities/execute') {
      const payload = init?.body ? JSON.parse(init.body) : {};
      return await hostCapabilityExecuteMock(payload, { timeoutMs: init?.timeoutMs });
    }
    return await hostApiFetchMock(path, init);
  },
  resolveSingleCapabilityScope: () => ({ kind: 'app' }),
  waitForRuntimeJobResult: (...args: unknown[]) => waitForRuntimeJobResultMock(...args),
}));

function buildJob(id: string): CronJob {
  return {
    id,
    name: `job-${id}`,
    agentId: 'main',
    message: 'hello',
    schedule: '0 9 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function jobsSnapshot(jobs: CronJob[], ready = true) {
  return {
    success: true,
    jobs,
    ready,
    refreshing: !ready,
    updatedAt: ready ? 1 : null,
    error: null,
  };
}

describe('cron session utils', () => {
  it('rejects cron session keys without an explicit agent id', async () => {
    const { parseCronSessionKey, isCronSessionKey } = await import('@/stores/chat/cron-session-utils');

    expect(parseCronSessionKey('agent::cron:job-1')).toBeNull();
    expect(isCronSessionKey('agent::cron:job-1')).toBe(false);
    expect(parseCronSessionKey('agent:test:cron:job-1')).toEqual({ agentId: 'test', jobId: 'job-1' });
  });
});

describe('cron store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    hostCapabilityExecuteMock.mockReset();
    waitForRuntimeJobResultMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次无快照时进入 initialLoading，成功后写入快照', async () => {
    const jobs = [buildJob('job-1')];
    let resolveFetch: ((value: ReturnType<typeof jobsSnapshot>) => void) | null = null;
    hostApiFetchMock.mockReturnValue(new Promise<ReturnType<typeof jobsSnapshot>>((resolve) => {
      resolveFetch = resolve;
    }));

    const { useCronStore } = await import('@/stores/cron');
    const fetchPromise = useCronStore.getState().fetchJobs();

    expect(useCronStore.getState().initialLoading).toBe(true);
    expect(useCronStore.getState().refreshing).toBe(false);

    resolveFetch?.(jobsSnapshot(jobs));
    await fetchPromise;

    const state = useCronStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.jobs).toEqual(jobs);
    expect(state.error).toBeNull();
  });

  it('已有快照时刷新失败保留旧数据，不回退空白', async () => {
    const jobs = [buildJob('job-2')];
    hostApiFetchMock.mockResolvedValueOnce(jobsSnapshot(jobs));

    const { useCronStore } = await import('@/stores/cron');
    await useCronStore.getState().fetchJobs();

    hostApiFetchMock.mockRejectedValueOnce(new Error('network down'));
    await useCronStore.getState().fetchJobs();

    const state = useCronStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.jobs).toEqual(jobs);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBe('network down');
  });

  it('fetchJobs 并发请求会单飞去重', async () => {
    const jobs = [buildJob('job-3')];
    let resolveFetch: ((value: ReturnType<typeof jobsSnapshot>) => void) | null = null;
    hostApiFetchMock.mockReturnValue(new Promise<ReturnType<typeof jobsSnapshot>>((resolve) => {
      resolveFetch = resolve;
    }));

    const { useCronStore } = await import('@/stores/cron');
    const first = useCronStore.getState().fetchJobs();
    const second = useCronStore.getState().fetchJobs();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(jobsSnapshot(jobs));
    await Promise.all([first, second]);
  });

  it('jobs 快照未 ready 时保持加载并自动重试', async () => {
    vi.useFakeTimers();
    const jobs = [buildJob('job-ready-later')];
    hostApiFetchMock
      .mockResolvedValueOnce(jobsSnapshot([], false))
      .mockResolvedValueOnce(jobsSnapshot(jobs));

    const { useCronStore } = await import('@/stores/cron');
    await useCronStore.getState().fetchJobs();

    expect(useCronStore.getState().snapshotReady).toBe(false);
    expect(useCronStore.getState().initialLoading).toBe(true);
    expect(useCronStore.getState().refreshing).toBe(true);
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1200);

    const state = useCronStore.getState();
    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.jobs).toEqual(jobs);
  });

  it('updateJob 会维护 mutatingByJobId 生命周期', async () => {
    const job = buildJob('job-4');
    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([job]);

    let resolveUpdate: (() => void) | null = null;
    hostCapabilityExecuteMock.mockImplementation(async (payload: { operationId?: string }) => {
      if (payload.operationId === 'cron.update') {
        await new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        });
        return {
          success: true,
          job: {
            id: 'runtime-job-4',
            type: 'cron.update',
            status: 'queued',
            queuedAt: 1,
            attempts: 0,
            maxAttempts: 1,
          },
        };
      }
      throw new Error(`unexpected operation: ${payload.operationId}`);
    });
    waitForRuntimeJobResultMock.mockResolvedValueOnce({ success: true });

    const updatePromise = useCronStore.getState().updateJob('job-4', { name: 'updated-name' });
    await waitFor(() => {
      expect(useCronStore.getState().mutating).toBe(true);
      expect(useCronStore.getState().mutatingByJobId['job-4']).toBe(1);
    });

    resolveUpdate?.();
    await updatePromise;

    const state = useCronStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingByJobId['job-4']).toBeUndefined();
    expect(state.jobs[0]?.name).toBe('updated-name');
    expect(waitForRuntimeJobResultMock).toHaveBeenCalledWith('runtime-job-4');
  });

  it('createJob 会保留返回的 agentId', async () => {
    const createdJob = { ...buildJob('job-5'), agentId: 'agent-alpha' };
    hostCapabilityExecuteMock.mockResolvedValueOnce({
      success: true,
      job: {
        id: 'runtime-job-5',
        type: 'cron.create',
        status: 'queued',
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    });
    waitForRuntimeJobResultMock.mockResolvedValueOnce(createdJob);

    const { useCronStore } = await import('@/stores/cron');
    const result = await useCronStore.getState().createJob({
      name: createdJob.name,
      agentId: 'agent-alpha',
      message: createdJob.message,
      schedule: '0 9 * * *',
      enabled: true,
    });

    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'scheduler.cron',
      operationId: 'cron.create',
      input: expect.objectContaining({
        name: createdJob.name,
        agentId: 'agent-alpha',
        message: createdJob.message,
        schedule: '0 9 * * *',
        enabled: true,
      }),
    }), { timeoutMs: undefined });
    expect(result.agentId).toBe('agent-alpha');
    expect(useCronStore.getState().jobs[0]?.agentId).toBe('agent-alpha');
  });

  it('triggerJob 提交后台任务并等待任务结果后刷新列表', async () => {
    const job = buildJob('job-6');
    const refreshedJob = { ...job, updatedAt: '2026-01-01T00:01:00.000Z' };
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/cron/jobs') {
        return jobsSnapshot([refreshedJob]);
      }
      throw new Error(`unexpected path: ${path}`);
    });
    hostCapabilityExecuteMock.mockImplementation(async (payload: { operationId?: string }) => {
      if (payload.operationId === 'cron.trigger') {
        return {
          success: true,
          job: {
            id: 'runtime-job-6',
            type: 'cron.trigger',
            status: 'queued',
            queuedAt: 1,
            attempts: 0,
            maxAttempts: 1,
          },
        };
      }
      throw new Error(`unexpected operation: ${payload.operationId}`);
    });
    waitForRuntimeJobResultMock.mockResolvedValueOnce({ ok: true, ran: true });

    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([job]);

    const result = await useCronStore.getState().triggerJob('job-6');

    expect(hostCapabilityExecuteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'scheduler.cron',
      operationId: 'cron.trigger',
      input: expect.objectContaining({ id: 'job-6' }),
    }), { timeoutMs: undefined });
    expect(waitForRuntimeJobResultMock).toHaveBeenCalledWith('runtime-job-6');
    expect(result).toEqual({ ran: true, reason: undefined });
    expect(useCronStore.getState().jobs).toEqual([refreshedJob]);
    expect(useCronStore.getState().mutating).toBe(false);
  });
});

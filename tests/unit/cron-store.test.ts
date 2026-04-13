import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/types/cron';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

function buildJob(id: string): CronJob {
  return {
    id,
    name: `job-${id}`,
    message: 'hello',
    schedule: '0 9 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('cron store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('首次无快照时进入 initialLoading，成功后写入快照', async () => {
    const jobs = [buildJob('job-1')];
    let resolveFetch: ((value: CronJob[]) => void) | null = null;
    hostApiFetchMock.mockReturnValue(new Promise<CronJob[]>((resolve) => {
      resolveFetch = resolve;
    }));

    const { useCronStore } = await import('@/stores/cron');
    const fetchPromise = useCronStore.getState().fetchJobs();

    expect(useCronStore.getState().initialLoading).toBe(true);
    expect(useCronStore.getState().refreshing).toBe(false);

    resolveFetch?.(jobs);
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
    hostApiFetchMock.mockResolvedValueOnce(jobs);

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
    let resolveFetch: ((value: CronJob[]) => void) | null = null;
    hostApiFetchMock.mockReturnValue(new Promise<CronJob[]>((resolve) => {
      resolveFetch = resolve;
    }));

    const { useCronStore } = await import('@/stores/cron');
    const first = useCronStore.getState().fetchJobs();
    const second = useCronStore.getState().fetchJobs();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(jobs);
    await Promise.all([first, second]);
  });

  it('updateJob 会维护 mutatingByJobId 生命周期', async () => {
    const job = buildJob('job-4');
    const { useCronStore } = await import('@/stores/cron');
    useCronStore.getState().setJobs([job]);

    let resolveUpdate: (() => void) | null = null;
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/cron/jobs/job-4') {
        await new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        });
        return {};
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const updatePromise = useCronStore.getState().updateJob('job-4', { name: 'updated-name' });
    expect(useCronStore.getState().mutating).toBe(true);
    expect(useCronStore.getState().mutatingByJobId['job-4']).toBe(1);

    resolveUpdate?.();
    await updatePromise;

    const state = useCronStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingByJobId['job-4']).toBeUndefined();
    expect(state.jobs[0]?.name).toBe('updated-name');
  });
});


import { describe, expect, it, vi } from 'vitest';
import { cronRoutes } from '../../runtime-host/api/routes/cron-routes';
import { CronService } from '../../runtime-host/application/cron/service';
import { createImmediateRuntimeTimer } from './helpers/runtime-scheduler';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const clock = {
  nowMs: () => 3456,
  nowIso: () => '1970-01-01T00:00:03.456Z',
};

function createCronJobsMock() {
  const job = (type: string, id = type) => ({
    success: true as const,
    job: {
      id,
      type,
      status: 'queued' as const,
      queuedAt: 1,
      attempts: 0,
      maxAttempts: 1,
    },
  });
  return {
    submitRefreshJobs: vi.fn(() => job('cron.refreshJobs')),
    submitCreate: vi.fn(() => job('cron.create')),
    submitUpdate: vi.fn(() => job('cron.update')),
    submitDelete: vi.fn(() => job('cron.delete')),
    submitToggle: vi.fn(() => job('cron.toggle')),
    submitTrigger: vi.fn((payload: { readonly id: string }) => job('cron.trigger', `runtime-${payload.id}`)),
    submitRepairDelivery: vi.fn(() => job('cron.repairDelivery')),
  };
}

describe('runtime-host cron routes', () => {
  it('routes through the injected cron service instead of constructing dependencies', async () => {
    const cronService = {
      usageRecent: vi.fn(async () => ({ usage: [] })),
      listJobs: vi.fn(),
      sessionHistory: vi.fn(),
      createJob: vi.fn(),
      updateJob: vi.fn(),
      deleteJob: vi.fn(),
      toggleJob: vi.fn(),
      trigger: vi.fn(),
    };
    const routeUrl = new URL('http://127.0.0.1/api/runtime-host/usage/recent?limit=3');

    const response = await dispatchRuntimeRouteDefinition(cronRoutes, 
      'GET',
      '/api/runtime-host/usage/recent',
      routeUrl,
      undefined,
      { cronService },
    );

    expect(response).toEqual({
      status: 200,
      data: { usage: [] },
    });
    expect(cronService.usageRecent).toHaveBeenCalledWith(undefined, routeUrl);
  });

  it('usageRecent 请求后台刷新并立即返回缓存快照', async () => {
    const requestUsageHistoryRefresh = vi.fn();
    const usageHistory = {
      isReady: vi.fn(() => true),
      refreshCache: vi.fn(),
      recent: vi.fn(() => [{ totalTokens: 3 }]),
    };
    const service = new CronService({
      gateway: {
        listCronJobs: vi.fn(),
        addCronJob: vi.fn(),
        updateCronJob: vi.fn(),
        removeCronJob: vi.fn(),
        runCronJob: vi.fn(),
      },
      sessionHistory: { read: vi.fn() },
      usageHistory: usageHistory as any,
      timer: createImmediateRuntimeTimer(),
      clock,
      jobs: createCronJobsMock(),
      requestUsageHistoryRefresh,
    });

    await expect(service.usageRecent(undefined, new URL('http://127.0.0.1/api/runtime-host/usage/recent?limit=1')))
      .resolves.toEqual([{ totalTokens: 3 }]);
    expect(requestUsageHistoryRefresh).toHaveBeenCalledTimes(1);
    expect(usageHistory.recent).toHaveBeenCalledWith({ limit: 1 });
  });

  it('cron jobs route 只返回 service 快照状态，不直接等待 gateway list', async () => {
    const jobs = [{ id: 'job-1', agentId: 'main' }];
    const snapshot = {
      success: true,
      jobs,
      ready: true,
      refreshing: false,
      updatedAt: 3456,
      error: null,
    };
    const cronService = {
      listJobs: vi.fn(() => snapshot),
    };

    const response = await dispatchRuntimeRouteDefinition(cronRoutes, 
      'GET',
      '/api/cron/jobs',
      new URL('http://127.0.0.1/api/cron/jobs'),
      undefined,
      { cronService } as never,
    );

    expect(response).toEqual({ status: 200, data: snapshot });
    expect(cronService.listJobs).toHaveBeenCalledTimes(1);
  });
});

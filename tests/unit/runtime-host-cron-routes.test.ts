import { describe, expect, it, vi } from 'vitest';
import { cronRoutes } from '../../runtime-host/api/routes/cron-routes';
import { createCronSchedulerCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/scheduler/cron-scheduler-capability';
import { CronService } from '../../runtime-host/application/cron/service';
import { CronJobMutationWorkflow } from '../../runtime-host/application/workflows/cron/cron-job-mutation-workflow';
import { CronOperationsWorkflow } from '../../runtime-host/application/workflows/cron/cron-operations-workflow';
import { ScheduledAgentTriggerWorkflow } from '../../runtime-host/application/workflows/scheduled-agent/scheduled-agent-trigger-workflow';
import { createImmediateRuntimeTimer } from './helpers/runtime-scheduler';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const clock = {
  nowMs: () => 3456,
  nowIso: () => '1970-01-01T00:00:03.456Z',
  toIsoString: (ms: number) => new Date(ms).toISOString(),
};

type CronGatewayMock = ConstructorParameters<typeof ScheduledAgentTriggerWorkflow>[0]['gateway'];

function createScheduledAgentTriggerWorkflow(gateway: CronGatewayMock): ScheduledAgentTriggerWorkflow {
  return new ScheduledAgentTriggerWorkflow({
    gateway,
    clock,
    timer: createImmediateRuntimeTimer(),
  });
}

function createCronService(input: {
  gateway: CronGatewayMock;
  jobs: ReturnType<typeof createCronJobsMock>;
  usageHistory?: { isReady: ReturnType<typeof vi.fn>; refreshCache: ReturnType<typeof vi.fn>; recent: ReturnType<typeof vi.fn> };
  requestUsageHistoryRefresh?: () => void;
}): CronService {
  const jobMutationWorkflow = new CronJobMutationWorkflow({
    gateway: input.gateway,
    clock,
    jobs: input.jobs,
    scheduledAgentTriggerWorkflow: createScheduledAgentTriggerWorkflow(input.gateway),
  });
  const operationsWorkflow = new CronOperationsWorkflow({
    gateway: input.gateway,
    usageHistory: (input.usageHistory ?? {
      isReady: vi.fn(() => true),
      refreshCache: vi.fn(),
      recent: vi.fn(() => []),
    }) as any,
    jobs: input.jobs,
    jobMutationWorkflow,
    requestUsageHistoryRefresh: input.requestUsageHistoryRefresh,
  });
  return new CronService({
    sessionHistory: { read: vi.fn() },
    operationsWorkflow,
  });
}

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
    const gateway = {
      listCronJobs: vi.fn(),
      addCronJob: vi.fn(),
      updateCronJob: vi.fn(),
      removeCronJob: vi.fn(),
      runCronJob: vi.fn(),
      readGatewayConnectionState: vi.fn(async () => ({
        state: 'connected',
        gatewayReady: true,
        portReachable: true,
      })),
    };
    const service = createCronService({
      gateway,
      jobs: createCronJobsMock(),
      usageHistory,
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

  it('cron scheduler capability 提交 trigger 后台任务，不在请求链路执行 gateway', async () => {
    const jobs = createCronJobsMock();
    const gateway = {
      listCronJobs: vi.fn(),
      addCronJob: vi.fn(),
      updateCronJob: vi.fn(),
      removeCronJob: vi.fn(),
      runCronJob: vi.fn(),
      readGatewayConnectionState: vi.fn(async () => ({
        state: 'connected',
        gatewayReady: true,
        portReachable: true,
      })),
    };
    const service = createCronService({ gateway, jobs });
    const triggerRoute = createCronSchedulerCapabilityOperationRoutes({ cronService: service })
      .find((route) => route.operationId === 'cron.trigger');

    expect(await triggerRoute?.handle({ id: 'job-1' })).toMatchObject({
      status: 202,
      data: {
        success: true,
        job: { id: 'runtime-job-1', type: 'cron.trigger' },
      },
    });
    expect(jobs.submitTrigger).toHaveBeenCalledWith({ id: 'job-1' });
    expect(gateway.runCronJob).not.toHaveBeenCalled();
  });

  it('cron jobs 在 Gateway 未 ready 时不提交刷新任务', async () => {
    const jobs = createCronJobsMock();
    const gateway = {
      listCronJobs: vi.fn(),
      addCronJob: vi.fn(),
      updateCronJob: vi.fn(),
      removeCronJob: vi.fn(),
      runCronJob: vi.fn(),
      readGatewayConnectionState: vi.fn(async () => ({
        state: 'disconnected',
        gatewayReady: false,
        portReachable: false,
      })),
    };
    const service = createCronService({ gateway, jobs });

    await expect(service.listJobs()).resolves.toEqual({
      success: true,
      ready: false,
      refreshing: false,
      updatedAt: null,
      error: null,
      jobs: [],
    });
    expect(jobs.submitRefreshJobs).not.toHaveBeenCalled();
  });

  it('cron refresh 后台任务在 Gateway 未 ready 时不调用 RPC，也不缓存连接错误', async () => {
    const listCronJobs = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18789');
    });
    const gateway = {
      listCronJobs,
      addCronJob: vi.fn(),
      updateCronJob: vi.fn(),
      removeCronJob: vi.fn(),
      runCronJob: vi.fn(),
      readGatewayConnectionState: vi.fn(async () => ({
        state: 'disconnected',
        gatewayReady: false,
        portReachable: false,
      })),
    };
    const service = createCronService({ gateway, jobs: createCronJobsMock() });

    await expect(service.refreshJobsSnapshot()).resolves.toEqual({
      success: true,
      jobs: [],
      ready: false,
      refreshing: false,
      updatedAt: null,
      error: null,
    });

    await expect(service.listJobs()).resolves.toMatchObject({
      success: true,
      ready: false,
      error: null,
      jobs: [],
    });
    expect(listCronJobs).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawChannelPluginProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection';
import { CronService } from '../../runtime-host/application/cron/service';
import { CronJobMutationWorkflow } from '../../runtime-host/application/workflows/cron/cron-job-mutation-workflow';
import { CronOperationsWorkflow } from '../../runtime-host/application/workflows/cron/cron-operations-workflow';
import { ScheduledAgentTriggerWorkflow } from '../../runtime-host/application/workflows/scheduled-agent/scheduled-agent-trigger-workflow';
import { createImmediateRuntimeTimer } from './helpers/runtime-scheduler';

function createBridgeMock() {
  return {
    listCronJobs: vi.fn(),
    addCronJob: vi.fn(),
    updateCronJob: vi.fn(),
    removeCronJob: vi.fn(),
    runCronJob: vi.fn(),
    readGatewayConnectionState: vi.fn(async () => ({
      state: 'connected' as const,
      gatewayReady: true,
      portReachable: true,
    })),
  };
}

function createCronJobsMock() {
  return {
    submitRefreshJobs: vi.fn(() => ({
      success: true as const,
      job: {
        id: 'runtime-cron-refresh',
        type: 'cron.refreshJobs',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitCreate: vi.fn((payload: unknown) => ({
      success: true as const,
      job: {
        id: 'runtime-cron-create',
        type: 'cron.create',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
    submitUpdate: vi.fn((payload: { readonly jobId: string; readonly updates: unknown }) => ({
      success: true as const,
      job: {
        id: `runtime-${payload.jobId}-update`,
        type: 'cron.update',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
    submitDelete: vi.fn((payload: { readonly jobId: string }) => ({
      success: true as const,
      job: {
        id: `runtime-${payload.jobId}-delete`,
        type: 'cron.delete',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
    submitToggle: vi.fn((payload: { readonly id: string; readonly enabled: boolean }) => ({
      success: true as const,
      job: {
        id: `runtime-${payload.id}-toggle`,
        type: 'cron.toggle',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
    submitTrigger: vi.fn((payload: { readonly id: string }) => ({
      success: true as const,
      job: {
        id: `runtime-${payload.id}`,
        type: 'cron.trigger',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitRepairDelivery: vi.fn(() => ({
      success: true as const,
      job: {
        id: 'runtime-cron-repair-delivery',
        type: 'cron.repairDelivery',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
  };
}

const deliveryChannelProjection = new OpenClawChannelPluginProjection();

describe('cron service delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const clock = {
    nowMs: () => 4567,
    nowIso: () => '1970-01-01T00:00:04.567Z',
    toIsoString: (ms: number) => new Date(ms).toISOString(),
  };

  function createCronService(gateway = createBridgeMock(), jobs = createCronJobsMock()): CronService {
    const scheduledAgentTriggerWorkflow = new ScheduledAgentTriggerWorkflow({
      gateway,
      clock,
      timer: createImmediateRuntimeTimer(),
    });
    const jobMutationWorkflow = new CronJobMutationWorkflow({
      gateway,
      clock,
      jobs,
      scheduledAgentTriggerWorkflow,
      deliveryChannelProjection,
    });
    const operationsWorkflow = new CronOperationsWorkflow({
      gateway,
      usageHistory: { recent: vi.fn(() => []), isReady: vi.fn(() => true), refreshCache: vi.fn() } as any,
      jobs,
      jobMutationWorkflow,
      deliveryChannelProjection,
    });
    return new CronService({
      sessionHistory: { read: vi.fn() },
      operationsWorkflow,
    });
  }

  it('createJob 会透传 delivery.channel/accountId/to 到 gateway', async () => {
    const bridge = createBridgeMock();
    bridge.addCronJob.mockResolvedValue({
      id: 'job-1',
      name: 'Daily Report',
      agentId: 'agent-reporter',
      payload: { kind: 'agentTurn', message: 'summarize today' },
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      delivery: { mode: 'announce', channel: 'feishu', accountId: 'feishu-main', to: 'user:ou_xxx' },
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      state: {},
    });
    const service = createCronService(bridge);

    const response = await service.createJob({
      name: 'Daily Report',
      agentId: 'agent-reporter',
      message: 'summarize today',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-main',
        to: 'user:ou_xxx',
      },
    });

    expect(bridge.addCronJob).not.toHaveBeenCalled();
    const executed = await service.executeCreateJob({
      name: 'Daily Report',
      agentId: 'agent-reporter',
      message: 'summarize today',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-main',
        to: 'user:ou_xxx',
      },
    });

    expect(bridge.addCronJob).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-reporter',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-main',
        to: 'user:ou_xxx',
      },
    }));
    expect(response.status).toBe(202);
    expect((executed as { agentId?: string }).agentId).toBe('agent-reporter');
    expect((executed as { delivery?: unknown }).delivery).toEqual({
      mode: 'announce',
      channel: 'feishu',
      accountId: 'feishu-main',
      to: 'user:ou_xxx',
    });
  });

  it('createJob 支持 WeChat 定时投递（要求 to + accountId）', async () => {
    const bridge = createBridgeMock();
    bridge.addCronJob.mockResolvedValue({
      id: 'job-wx-1',
      name: 'WeChat Push',
      agentId: 'wechat-agent',
      payload: { kind: 'agentTurn', message: 'ping' },
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      delivery: { mode: 'announce', channel: 'openclaw-weixin', accountId: 'wechat-main', to: 'wxid_123@im.wechat' },
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      state: {},
    });
    const service = createCronService(bridge);

    const response = await service.createJob({
      name: 'WeChat Push',
      agentId: 'wechat-agent',
      message: 'ping',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        to: 'wxid_123@im.wechat',
      },
    });

    expect(response.status).toBe(202);
    const executed = await service.executeCreateJob({
      name: 'WeChat Push',
      agentId: 'wechat-agent',
      message: 'ping',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        to: 'wxid_123@im.wechat',
      },
    });
    expect((executed as { id?: string }).id).toBe('job-wx-1');
    expect(bridge.addCronJob).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'wechat-agent',
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        to: 'wxid_123@im.wechat',
      },
    }));
  });

  it('createJob 缺少 agentId 时拒绝', async () => {
    const bridge = createBridgeMock();
    const service = createCronService(bridge);

    const response = await service.createJob({
      name: 'Daily Report',
      message: 'summarize today',
      schedule: '0 9 * * *',
      delivery: { mode: 'none' },
    });

    expect(response.status).toBe(400);
    expect((response.data as { success: boolean; error?: string }).success).toBe(false);
    expect((response.data as { error?: string }).error).toBe('Invalid cron create payload');
    expect(bridge.addCronJob).not.toHaveBeenCalled();
  });

  it('createJob 在 WeChat 定时投递缺少 accountId 时拒绝', async () => {
    const bridge = createBridgeMock();
    const service = createCronService(bridge);

    const response = await service.createJob({
      name: 'WeChat Push',
      agentId: 'wechat-agent',
      message: 'ping',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        to: 'wxid_123@im.wechat',
      },
    });

    expect(response.status).toBe(400);
    expect((response.data as { success: boolean; error?: string }).success).toBe(false);
    expect((response.data as { error?: string }).error).toContain('delivery.accountId');
    expect(bridge.addCronJob).not.toHaveBeenCalled();
  });

  it('updateJob 会把 message/schedule/delivery 转成网关补丁格式', async () => {
    const bridge = createBridgeMock();
    bridge.updateCronJob.mockResolvedValue({ success: true });
    const service = createCronService(bridge);

    const response = await service.updateJob('job-2', {
      agentId: 'agent-evening',
      message: 'next report',
      schedule: '0 18 * * *',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-secondary',
        to: 'chat:oc_yyy',
      },
    });

    expect(response.status).toBe(202);
    expect(bridge.updateCronJob).not.toHaveBeenCalled();
    const executed = await service.executeUpdateJob('job-2', {
      agentId: 'agent-evening',
      message: 'next report',
      schedule: '0 18 * * *',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-secondary',
        to: 'chat:oc_yyy',
      },
    });
    expect(executed).toEqual({ success: true });
    expect(bridge.updateCronJob).toHaveBeenCalledWith('job-2', expect.objectContaining({
      agentId: 'agent-evening',
      schedule: { kind: 'cron', expr: '0 18 * * *' },
      payload: { kind: 'agentTurn', message: 'next report' },
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-secondary',
        to: 'chat:oc_yyy',
      },
    }));
  });

  it('updateJob 缺少 agentId 时拒绝', async () => {
    const bridge = createBridgeMock();
    const service = createCronService(bridge);

    const response = await service.updateJob('job-2', {
      agentId: ' ',
    });

    expect(response.status).toBe(400);
    expect((response.data as { success: boolean; error?: string }).success).toBe(false);
    expect((response.data as { error?: string }).error).toBe('agentId is required');
    expect(bridge.updateCronJob).not.toHaveBeenCalled();
  });

  it('listJobs 会过滤缺失 agentId 的任务', async () => {
    const bridge = createBridgeMock();
    bridge.listCronJobs.mockResolvedValue({
      jobs: [
        {
          id: 'job-main',
          name: 'Main Agent Job',
          payload: { kind: 'agentTurn', message: 'hello' },
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          state: {},
        },
      ],
    });
    const jobsPort = createCronJobsMock();
    const service = createCronService(bridge, jobsPort);

    await expect(service.listJobs()).resolves.toMatchObject({
      success: true,
      jobs: [],
      ready: false,
      refreshing: true,
      updatedAt: null,
      error: null,
    });
    expect(jobsPort.submitRefreshJobs).toHaveBeenCalledTimes(1);
    const refreshResult = await service.refreshJobsSnapshot();
    const snapshot = await service.listJobs();

    expect(refreshResult.success).toBe(true);
    expect(snapshot).toMatchObject({
      success: true,
      ready: true,
      refreshing: true,
      updatedAt: 4567,
      error: null,
    });
    expect(snapshot.jobs).toHaveLength(0);
  });

  it('listJobs 发现旧 delivery 配置时只返回修复后的读模型并提交后台修复', async () => {
    const bridge = createBridgeMock();
    const jobsPort = createCronJobsMock();
    bridge.listCronJobs.mockResolvedValue({
      jobs: [
        {
          id: 'job-repair',
          name: 'Repair Delivery',
          agentId: 'repair-agent',
          payload: { kind: 'agentTurn', message: 'hello' },
          schedule: { kind: 'cron', expr: '0 9 * * *' },
          delivery: { mode: 'announce' },
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          state: {
            lastRunAtMs: 1_700_000_000_000,
            lastError: 'Channel is required',
            lastStatus: 'error',
          },
        },
      ],
    });
    const service = createCronService(bridge, jobsPort);

    await expect(service.listJobs()).resolves.toMatchObject({
      success: true,
      jobs: [],
      ready: false,
      refreshing: true,
      updatedAt: null,
      error: null,
    });
    const refreshResult = await service.refreshJobsSnapshot();
    const snapshot = await service.listJobs();

    expect(refreshResult.success).toBe(true);
    expect(jobsPort.submitRepairDelivery).toHaveBeenCalledTimes(1);
    expect(bridge.updateCronJob).not.toHaveBeenCalled();
    expect(snapshot.jobs[0]?.delivery).toEqual({ mode: 'none' });
    expect(snapshot.jobs[0]?.lastRun?.success).toBe(true);
  });

  it('executeDeliveryRepair 才会写回 gateway 修复旧 delivery 配置', async () => {
    const bridge = createBridgeMock();
    bridge.listCronJobs.mockResolvedValue({
      jobs: [
        {
          id: 'job-repair',
          payload: { kind: 'agentTurn', message: 'hello' },
          delivery: { mode: 'announce' },
        },
      ],
    });
    bridge.updateCronJob.mockResolvedValue({ success: true });
    const service = createCronService(bridge);

    const result = await service.executeDeliveryRepair();

    expect(result).toEqual({ success: true, repairedCount: 1 });
    expect(bridge.updateCronJob).toHaveBeenCalledWith('job-repair', { delivery: { mode: 'none' } });
  });

  it('trigger 只提交后台任务，不在请求链路执行 runCronJob', () => {
    const bridge = createBridgeMock();
    const jobs = createCronJobsMock();
    const service = createCronService(bridge, jobs);

    const response = service.trigger({ id: 'job-trigger' });

    expect(response.status).toBe(202);
    expect(jobs.submitTrigger).toHaveBeenCalledWith({ id: 'job-trigger' });
    expect(bridge.runCronJob).not.toHaveBeenCalled();
  });

  it('deleteJob 和 toggleJob 只提交后台任务，不在请求链路改 gateway', async () => {
    const bridge = createBridgeMock();
    const jobs = createCronJobsMock();
    const service = createCronService(bridge, jobs);

    const deleteResponse = await service.deleteJob('job-delete');
    const toggleResponse = service.toggleJob({ id: 'job-toggle', enabled: false });

    expect(deleteResponse.status).toBe(202);
    expect(toggleResponse.status).toBe(202);
    expect(jobs.submitDelete).toHaveBeenCalledWith({ jobId: 'job-delete' });
    expect(jobs.submitToggle).toHaveBeenCalledWith({ id: 'job-toggle', enabled: false });
    expect(bridge.removeCronJob).not.toHaveBeenCalled();
    expect(bridge.updateCronJob).not.toHaveBeenCalled();

    await service.executeDeleteJob('job-delete');
    await service.executeToggleJob({ id: 'job-toggle', enabled: false });

    expect(bridge.removeCronJob).toHaveBeenCalledWith('job-delete');
    expect(bridge.updateCronJob).toHaveBeenCalledWith('job-toggle', { enabled: false });
  });

  it('updateJob 在 WeChat 定时投递缺少 accountId 时拒绝', async () => {
    const bridge = createBridgeMock();
    bridge.listCronJobs.mockResolvedValue({
      jobs: [
        {
          id: 'job-wx-2',
          delivery: {
            mode: 'announce',
            channel: 'openclaw-weixin',
            to: 'wxid_123@im.wechat',
          },
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          state: {},
        },
      ],
    });
    const service = createCronService(bridge);
    await service.refreshJobsSnapshot();

    const response = await service.updateJob('job-wx-2', {
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        to: 'wxid_123@im.wechat',
        accountId: '',
      },
    });

    expect(response.status).toBe(400);
    expect((response.data as { error?: string }).error).toContain('delivery.accountId');
    expect(bridge.updateCronJob).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CronService } from '../../runtime-host/application/cron/service';

function createBridgeMock() {
  return {
    listCronJobs: vi.fn(),
    addCronJob: vi.fn(),
    updateCronJob: vi.fn(),
    removeCronJob: vi.fn(),
    runCronJob: vi.fn(),
  };
}

describe('cron service delivery', () => {
  const getOpenClawConfigDir = vi.fn(() => '/tmp/openclaw');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createJob 会透传 delivery.channel/accountId/to 到 gateway', async () => {
    const bridge = createBridgeMock();
    bridge.addCronJob.mockResolvedValue({
      id: 'job-1',
      name: 'Daily Report',
      payload: { kind: 'agentTurn', message: 'summarize today' },
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      delivery: { mode: 'announce', channel: 'feishu', accountId: 'feishu-main', to: 'user:ou_xxx' },
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      state: {},
    });
    const service = new CronService({
      openclawBridge: bridge,
      getOpenClawConfigDir,
    });

    const response = await service.createJob({
      name: 'Daily Report',
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
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-main',
        to: 'user:ou_xxx',
      },
    }));
    expect(response.status).toBe(200);
    expect((response.data as { delivery?: unknown }).delivery).toEqual({
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
      payload: { kind: 'agentTurn', message: 'ping' },
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      delivery: { mode: 'announce', channel: 'openclaw-weixin', accountId: 'wechat-main', to: 'wxid_123@im.wechat' },
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      state: {},
    });
    const service = new CronService({
      openclawBridge: bridge,
      getOpenClawConfigDir,
    });

    const response = await service.createJob({
      name: 'WeChat Push',
      message: 'ping',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        to: 'wxid_123@im.wechat',
      },
    });

    expect(response.status).toBe(200);
    expect(bridge.addCronJob).toHaveBeenCalledWith(expect.objectContaining({
      delivery: {
        mode: 'announce',
        channel: 'openclaw-weixin',
        accountId: 'wechat-main',
        to: 'wxid_123@im.wechat',
      },
    }));
  });

  it('createJob 在 WeChat 定时投递缺少 accountId 时拒绝', async () => {
    const bridge = createBridgeMock();
    const service = new CronService({
      openclawBridge: bridge,
      getOpenClawConfigDir,
    });

    const response = await service.createJob({
      name: 'WeChat Push',
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
    const service = new CronService({
      openclawBridge: bridge,
      getOpenClawConfigDir,
    });

    const response = await service.updateJob('job-2', {
      message: 'next report',
      schedule: '0 18 * * *',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        accountId: 'feishu-secondary',
        to: 'chat:oc_yyy',
      },
    });

    expect(response.status).toBe(200);
    expect(bridge.updateCronJob).toHaveBeenCalledWith('job-2', expect.objectContaining({
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
        },
      ],
    });
    const service = new CronService({
      openclawBridge: bridge,
      getOpenClawConfigDir,
    });

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

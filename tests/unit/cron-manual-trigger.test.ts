import { describe, expect, it, vi } from 'vitest';
import {
  buildManualRunPatches,
  shouldUseManualRunProfileSwitch,
  triggerCronJobWithSplitProfiles,
  type GatewayCronJobForTrigger,
} from '../../runtime-host/application/cron/manual-trigger';

function buildJob(overrides?: Partial<GatewayCronJobForTrigger>): GatewayCronJobForTrigger {
  return {
    id: 'job-1',
    name: 'github今日热门项目',
    sessionTarget: 'isolated',
    wakeMode: 'next-heartbeat',
    payload: {
      kind: 'agentTurn',
      message: '每日都生成github今日热门项目',
    },
    delivery: { mode: 'none' },
    state: {},
    ...overrides,
  };
}

describe('cron 手动触发配置切换', () => {
  it('isolated + agentTurn 时启用手动配置切换', () => {
    const job = buildJob();
    expect(shouldUseManualRunProfileSwitch(job)).toBe(true);
  });

  it('main + systemEvent 时不启用手动配置切换', () => {
    const job = buildJob({
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: '执行系统事件' },
    });
    expect(shouldUseManualRunProfileSwitch(job)).toBe(false);
  });

  it('生成手动执行 patch 与恢复 patch', () => {
    const job = buildJob();
    const { manualPatch, restorePatch } = buildManualRunPatches(job);

    expect(manualPatch).toMatchObject({
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: {
        kind: 'systemEvent',
        text: '每日都生成github今日热门项目',
      },
    });

    expect(restorePatch).toMatchObject({
      sessionTarget: 'isolated',
      wakeMode: 'next-heartbeat',
      payload: {
        kind: 'agentTurn',
        message: '每日都生成github今日热门项目',
      },
      delivery: { mode: 'none' },
    });
  });

  it('手动触发会在同一个任务链路内等待完成并恢复配置', async () => {
    let currentJob = buildJob({
      state: {
        lastRunAtMs: 100,
      },
    });
    const gateway = {
      listCronJobs: vi.fn(async () => ({ jobs: [currentJob] })),
      updateCronJob: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        currentJob = {
          ...currentJob,
          ...patch,
        };
        return { success: true };
      }),
      runCronJob: vi.fn(async () => {
        currentJob = {
          ...currentJob,
          state: {
            lastRunAtMs: 200,
          },
        };
        return { ran: true };
      }),
    };

    const result = await triggerCronJobWithSplitProfiles({
      gateway,
      id: 'job-1',
      clock: {
        nowMs: () => 1000,
        nowIso: () => '1970-01-01T00:00:01.000Z',
      },
      timer: {
        sleep: vi.fn(async () => undefined),
      },
    });

    expect(result).toEqual({ ran: true });
    expect(gateway.updateCronJob).toHaveBeenNthCalledWith(1, 'job-1', expect.objectContaining({
      sessionTarget: 'main',
      wakeMode: 'now',
    }));
    expect(gateway.runCronJob).toHaveBeenCalledWith('job-1', 'force');
    expect(gateway.updateCronJob).toHaveBeenLastCalledWith('job-1', expect.objectContaining({
      sessionTarget: 'isolated',
      wakeMode: 'next-heartbeat',
    }));
    expect(gateway.listCronJobs).toHaveBeenCalledTimes(2);
  });
});

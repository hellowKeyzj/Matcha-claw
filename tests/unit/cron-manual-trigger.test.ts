import { describe, expect, it } from 'vitest';
import { buildManualRunPatches, shouldUseManualRunProfileSwitch, type GatewayCronJobForTrigger } from '@electron/utils/cron-manual-trigger';

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
});


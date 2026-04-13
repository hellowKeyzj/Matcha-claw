import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('dashboard ui store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('初始化为 dashboard 默认 UI 状态', async () => {
    const { useDashboardUiStore } = await import('@/stores/dashboard-ui');
    const state = useDashboardUiStore.getState();

    expect(state.dashboardHeavyContentReady).toBe(false);
    expect(state.usageGroupBy).toBe('model');
    expect(state.usageWindow).toBe('7d');
    expect(state.usagePage).toBe(1);
  });

  it('切换 usage 维度和窗口会重置分页', async () => {
    const { useDashboardUiStore } = await import('@/stores/dashboard-ui');

    useDashboardUiStore.getState().setUsagePage(4);
    useDashboardUiStore.getState().setUsageGroupBy('day');
    let state = useDashboardUiStore.getState();
    expect(state.usageGroupBy).toBe('day');
    expect(state.usagePage).toBe(1);

    useDashboardUiStore.getState().setUsagePage(3);
    useDashboardUiStore.getState().setUsageWindow('30d');
    state = useDashboardUiStore.getState();
    expect(state.usageWindow).toBe('30d');
    expect(state.usagePage).toBe(1);
  });

  it('setUsagePage 支持 updater 且会归一化非法页码', async () => {
    const { useDashboardUiStore } = await import('@/stores/dashboard-ui');

    useDashboardUiStore.getState().setUsagePage((page) => page + 2);
    let state = useDashboardUiStore.getState();
    expect(state.usagePage).toBe(3);

    useDashboardUiStore.getState().setUsagePage(0);
    state = useDashboardUiStore.getState();
    expect(state.usagePage).toBe(1);
  });
});

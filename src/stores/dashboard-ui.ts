import { create } from 'zustand';
import type { UsageGroupBy, UsageWindow } from '@/pages/Dashboard/usage-history';

const DEFAULT_USAGE_GROUP_BY: UsageGroupBy = 'model';
const DEFAULT_USAGE_WINDOW: UsageWindow = '7d';
const DEFAULT_USAGE_PAGE = 1;

interface DashboardUiState {
  usageGroupBy: UsageGroupBy;
  usageWindow: UsageWindow;
  usagePage: number;
  setUsageGroupBy: (nextGroupBy: UsageGroupBy) => void;
  setUsageWindow: (nextWindow: UsageWindow) => void;
  setUsagePage: (nextPage: number | ((previousPage: number) => number)) => void;
}

function normalizeUsagePage(nextPage: number): number {
  if (!Number.isFinite(nextPage)) {
    return DEFAULT_USAGE_PAGE;
  }
  return Math.max(DEFAULT_USAGE_PAGE, Math.floor(nextPage));
}

export const useDashboardUiStore = create<DashboardUiState>((set) => ({
  usageGroupBy: DEFAULT_USAGE_GROUP_BY,
  usageWindow: DEFAULT_USAGE_WINDOW,
  usagePage: DEFAULT_USAGE_PAGE,

  setUsageGroupBy: (nextGroupBy) => {
    set((state) => (
      state.usageGroupBy === nextGroupBy && state.usagePage === DEFAULT_USAGE_PAGE
        ? state
        : {
          usageGroupBy: nextGroupBy,
          usagePage: DEFAULT_USAGE_PAGE,
        }
    ));
  },

  setUsageWindow: (nextWindow) => {
    set((state) => (
      state.usageWindow === nextWindow && state.usagePage === DEFAULT_USAGE_PAGE
        ? state
        : {
          usageWindow: nextWindow,
          usagePage: DEFAULT_USAGE_PAGE,
        }
    ));
  },

  setUsagePage: (nextPage) => {
    set((state) => {
      const resolved = typeof nextPage === 'function'
        ? nextPage(state.usagePage)
        : nextPage;
      const normalized = normalizeUsagePage(resolved);
      return state.usagePage === normalized
        ? state
        : { usagePage: normalized };
    });
  },
}));

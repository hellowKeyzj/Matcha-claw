import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Cron } from '@/pages/Cron';
import { useChatStore } from '@/stores/chat';
import { useCronStore } from '@/stores/cron';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import type { CronJob } from '@/types/cron';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

function buildCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-long-title',
    name: 'Memory Dreaming Promotion With An Unusually Long Title That Should Trigger Truncation',
    agentId: 'main',
    message: '__openclaw_memory_core_short_term_promotion_pipeline__step_overflow_check__',
    schedule: { kind: 'cron', expr: '0 3 * * *' },
    enabled: true,
    createdAt: '2026-04-30T03:00:00.000Z',
    updatedAt: '2026-04-30T03:00:00.000Z',
    ...overrides,
  };
}

describe('cron card layout', () => {
  it('lets long titles shrink before the status and switch controls', () => {
    useGatewayStore.setState({
      isInitialized: true,
      status: {
        processState: 'running',
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    } as never);
    useChatStore.setState({ currentSessionKey: 'agent:main:main' } as never);
    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [{ id: 'main', name: 'Main Agent' }],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);
    useCronStore.setState({
      jobs: [buildCronJob()],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingByJobId: {},
      error: null,
      fetchJobs: vi.fn().mockResolvedValue(undefined),
      triggerJob: vi.fn().mockResolvedValue({ ran: true }),
    } as never);

    render(<Cron embedded />);

    expect(screen.getByTestId('cron-job-card-job-long-title')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-card-title-job-long-title')).toHaveClass('truncate');
    expect(screen.getByTestId('cron-job-card-title-job-long-title').parentElement).toHaveClass('min-w-0');
    expect(screen.getByTestId('cron-job-card-switch-job-long-title')).toHaveClass('shrink-0');
  });
});

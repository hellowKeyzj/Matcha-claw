/**
 * Cron State Store
 * Manages scheduled task state
 */
import { create } from 'zustand';
import {
  hostApiFetch,
  resolveSingleCapabilityScope,
} from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { CronJob, CronJobCreateInput, CronJobUpdateInput } from '../types/cron';
import type { CapabilityTarget } from '../../electron/desktop-contract/capability-target';

interface CronState {
  jobs: CronJob[];
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  mutatingByJobId: Record<string, number>;
  error: string | null;
  
  // Actions
  fetchJobs: (options?: { silent?: boolean }) => Promise<void>;
  createJob: (input: CronJobCreateInput) => Promise<CronJob>;
  updateJob: (id: string, input: CronJobUpdateInput) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  toggleJob: (id: string, enabled: boolean) => Promise<void>;
  triggerJob: (id: string) => Promise<{ ran: boolean; reason?: string }>;
  setJobs: (jobs: CronJob[]) => void;
}

interface CronJobsSnapshot {
  success?: boolean;
  jobs: CronJob[];
  ready: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

let inflightCronFetchPromise: Promise<void> | null = null;
let cronSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cronEventCleanup: (() => void) | null = null;
let cronEventGeneration = 0;
const CRON_SNAPSHOT_NOT_READY_RETRY_MS = 1_200;
const SCHEDULER_CRON_CAPABILITY_ID = 'scheduler.cron';

type CronMutationOperation = 'cron.create' | 'cron.update' | 'cron.delete' | 'cron.toggle';
type CronTriggerOutcome = 'accepted' | 'skipped' | 'failed' | 'outcome-unknown';
type CronTriggerSkipReason = 'already-running' | 'not-due' | 'invalid-spec';
type CronTriggerResult = {
  outcome: CronTriggerOutcome;
  reason?: CronTriggerSkipReason;
};

function clearCronSnapshotRetry(): void {
  if (cronSnapshotRetryTimer) {
    clearTimeout(cronSnapshotRetryTimer);
    cronSnapshotRetryTimer = null;
  }
}

function scheduleCronSnapshotRetry(fetchJobs: () => Promise<void>): void {
  if (cronSnapshotRetryTimer) {
    return;
  }
  cronSnapshotRetryTimer = setTimeout(() => {
    cronSnapshotRetryTimer = null;
    void fetchJobs();
  }, CRON_SNAPSHOT_NOT_READY_RETRY_MS);
}

async function cronMutationRequest<TResult>(
  path: string,
  operationId: CronMutationOperation,
  input: Record<string, unknown>,
  target: CapabilityTarget,
): Promise<TResult> {
  return await hostApiFetch<TResult>(path, {
    method: 'POST',
    body: JSON.stringify({
      id: SCHEDULER_CRON_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(SCHEDULER_CRON_CAPABILITY_ID),
      target,
      input,
    }),
  });
}

async function cronTriggerRequest(id: string): Promise<CronTriggerResult> {
  const result = await hostApiFetch<unknown>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.trigger',
      scope: await resolveSingleCapabilityScope(SCHEDULER_CRON_CAPABILITY_ID),
      target: { kind: 'cron-job', jobId: id },
      input: { id },
    }),
  });
  if (!isRecord(result) || typeof result.success !== 'boolean' || !isRecord(result.result)
    || !isCronTriggerOutcome(result.result.outcome)
    || (result.result.reason !== undefined && !isCronTriggerSkipReason(result.result.reason))
    || (result.result.outcome !== 'skipped' && result.result.reason !== undefined)) {
    throw new Error('Invalid Cron trigger response');
  }
  return {
    outcome: result.result.outcome,
    ...(result.result.reason === undefined ? {} : { reason: result.result.reason }),
  };
}

function isCronTriggerOutcome(value: unknown): value is CronTriggerOutcome {
  return value === 'accepted' || value === 'skipped' || value === 'failed' || value === 'outcome-unknown';
}

function isCronTriggerSkipReason(value: unknown): value is CronTriggerSkipReason {
  return value === 'already-running' || value === 'not-due' || value === 'invalid-spec';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCronExecutionEvent(value: unknown): value is {
  jobId: string;
  runId: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'outcome-unknown';
} {
  return isRecord(value)
    && Object.keys(value).length === 3
    && typeof value.jobId === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(value.jobId)
    && value.jobId.length <= 128
    && typeof value.runId === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(value.runId)
    && value.runId.length <= 128
    && isCronExecutionStatus(value.status);
}

function isCronExecutionStatus(value: unknown): value is CronExecutionEvent['status'] {
  return value === 'succeeded'
    || value === 'failed'
    || value === 'skipped'
    || value === 'cancelled'
    || value === 'outcome-unknown';
}

type CronExecutionEvent = {
  jobId: string;
  runId: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'outcome-unknown';
};

function decodeCronJobsSnapshot(payload: unknown): CronJobsSnapshot {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid /api/cron/jobs response: expected snapshot object');
  }
  const snapshot = payload as { jobs?: unknown; ready?: unknown; refreshing?: unknown; updatedAt?: unknown; error?: unknown };
  if (!Array.isArray(snapshot.jobs)) {
    throw new Error('Invalid /api/cron/jobs response: expected jobs array');
  }
  return {
    jobs: snapshot.jobs as CronJob[],
    ready: snapshot.ready !== false,
    refreshing: snapshot.refreshing === true,
    updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
    error: typeof snapshot.error === 'string' ? snapshot.error : null,
  };
}

function hasMutatingJobs(mutatingByJobId: Record<string, number>): boolean {
  return Object.keys(mutatingByJobId).length > 0;
}

function incrementMutatingJob(mutatingByJobId: Record<string, number>, jobId: string): Record<string, number> {
  const current = mutatingByJobId[jobId] ?? 0;
  return {
    ...mutatingByJobId,
    [jobId]: current + 1,
  };
}

function decrementMutatingJob(mutatingByJobId: Record<string, number>, jobId: string): Record<string, number> {
  const current = mutatingByJobId[jobId] ?? 0;
  if (current <= 1) {
    const next = { ...mutatingByJobId };
    delete next[jobId];
    return next;
  }
  return {
    ...mutatingByJobId,
    [jobId]: current - 1,
  };
}

export const useCronStore = create<CronState>((set, get) => ({
  jobs: [],
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  mutatingByJobId: {},
  error: null,
  
  fetchJobs: async (options) => {
    if (!cronEventCleanup) {
      initCronEvents();
    }
    const silent = options?.silent === true;
    if (inflightCronFetchPromise) {
      await inflightCronFetchPromise;
      return;
    }
    const hasSnapshot = get().snapshotReady;
    if (hasSnapshot) {
      if (!silent) {
        set({ refreshing: true, initialLoading: false, error: null });
      }
    } else {
      set({ initialLoading: true, refreshing: false, error: null });
    }

    const task = (async () => {
      try {
        const snapshot = decodeCronJobsSnapshot(await hostApiFetch<unknown>('/api/cron/jobs'));
        if (!snapshot.ready) {
          set((state) => ({
            initialLoading: !state.snapshotReady,
            refreshing: true,
            error: snapshot.error,
          }));
          scheduleCronSnapshotRetry(() => get().fetchJobs({ silent: true }));
          return;
        }
        clearCronSnapshotRetry();
        set({
          jobs: snapshot.jobs,
          snapshotReady: true,
          initialLoading: false,
          refreshing: false,
          error: null,
        });
      } catch (error) {
        set({
          initialLoading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    inflightCronFetchPromise = task;
    try {
      await task;
    } finally {
      if (inflightCronFetchPromise === task) {
        inflightCronFetchPromise = null;
      }
    }
  },
  
  createJob: async (input) => {
    set({ mutating: true });
    try {
      const job = await cronMutationRequest<CronJob>(
        '/api/cron/jobs/create',
        'cron.create',
        {
          name: input.name,
          agentId: input.agentId ?? 'main',
          message: input.message,
          schedule: input.schedule,
          delivery: input.delivery ?? { mode: 'none' },
          enabled: input.enabled ?? true,
        },
        { kind: 'cron-job' },
      );
      if (!isRecord(job) || typeof job.id !== 'string') {
        throw new Error('Invalid cron create response');
      }
      set((state) => ({ jobs: [...state.jobs, job], snapshotReady: true }));
      return job;
    } catch (error) {
      console.error('Failed to create cron job:', error);
      throw error;
    } finally {
      set({ mutating: false });
    }
  },
  
  updateJob: async (id, input) => {
    set((state) => {
      const next = incrementMutatingJob(state.mutatingByJobId, id);
      return {
        mutatingByJobId: next,
        mutating: true,
      };
    });
    try {
      const job = await cronMutationRequest<CronJob>(
        '/api/cron/jobs/update',
        'cron.update',
        { jobId: id, ...input },
        { kind: 'cron-job', jobId: id },
      );
      if (!job || typeof job.id !== 'string' || job.id !== id) {
        throw new Error('Invalid cron update response');
      }
      set((state) => ({
        jobs: state.jobs.map((current) => current.id === id ? job : current),
      }));
    } catch (error) {
      console.error('Failed to update cron job:', error);
      throw error;
    } finally {
      set((state) => {
        const next = decrementMutatingJob(state.mutatingByJobId, id);
        return {
          mutatingByJobId: next,
          mutating: hasMutatingJobs(next),
        };
      });
    }
  },
  
  deleteJob: async (id) => {
    set((state) => {
      const next = incrementMutatingJob(state.mutatingByJobId, id);
      return {
        mutatingByJobId: next,
        mutating: true,
      };
    });
    try {
      const result = await cronMutationRequest<{ removed: boolean }>(
        '/api/cron/jobs/delete',
        'cron.delete',
        { jobId: id },
        { kind: 'cron-job', jobId: id },
      );
      if (!result || typeof result.removed !== 'boolean') {
        throw new Error('Invalid cron delete response');
      }
      if (result.removed) {
        set((state) => ({
          jobs: state.jobs.filter((job) => job.id !== id),
        }));
      }
    } catch (error) {
      console.error('Failed to delete cron job:', error);
      throw error;
    } finally {
      set((state) => {
        const next = decrementMutatingJob(state.mutatingByJobId, id);
        return {
          mutatingByJobId: next,
          mutating: hasMutatingJobs(next),
        };
      });
    }
  },
  
  toggleJob: async (id, enabled) => {
    set((state) => {
      const next = incrementMutatingJob(state.mutatingByJobId, id);
      return {
        mutatingByJobId: next,
        mutating: true,
      };
    });
    try {
      const job = await cronMutationRequest<CronJob>(
        '/api/cron/jobs/toggle',
        'cron.toggle',
        { id, enabled },
        { kind: 'cron-job', jobId: id },
      );
      if (!job || typeof job.id !== 'string' || job.id !== id) {
        throw new Error('Invalid cron toggle response');
      }
      set((state) => ({
        jobs: state.jobs.map((current) => current.id === id ? job : current),
      }));
    } catch (error) {
      console.error('Failed to toggle cron job:', error);
      throw error;
    } finally {
      set((state) => {
        const next = decrementMutatingJob(state.mutatingByJobId, id);
        return {
          mutatingByJobId: next,
          mutating: hasMutatingJobs(next),
        };
      });
    }
  },
  
  triggerJob: async (id) => {
    set((state) => {
      const next = incrementMutatingJob(state.mutatingByJobId, id);
      return {
        mutatingByJobId: next,
        mutating: true,
      };
    });
    try {
      const result = await cronTriggerRequest(id);
      if (result.outcome === 'accepted') {
        return { ran: true };
      }
      if (result.outcome === 'skipped') {
        return { ran: false, reason: result.reason ?? 'already-running' };
      }
      throw new Error(result.outcome === 'failed'
        ? 'Cron trigger was rejected'
        : 'Cron trigger outcome is unknown');
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      throw error;
    } finally {
      set((state) => {
        const next = decrementMutatingJob(state.mutatingByJobId, id);
        return {
          mutatingByJobId: next,
          mutating: hasMutatingJobs(next),
        };
      });
    }
  },
  
  setJobs: (jobs) => set({ jobs, snapshotReady: true }),
}));

export function initCronEvents(): () => void {
  cronEventCleanup?.();
  const generation = ++cronEventGeneration;
  let active = true;
  const unsubscribe = subscribeHostEvent<unknown>('openclaw:cron', (event) => {
    if (!active || !isCronExecutionEvent(event)) return;
    if (!useCronStore.getState().jobs.some((job) => job.id === event.jobId)) return;
    void useCronStore.getState().fetchJobs({ silent: true });
  });
  const cleanup = () => {
    if (!active) return;
    active = false;
    unsubscribe();
    if (cronEventGeneration === generation) {
      cronEventCleanup = null;
    }
  };
  cronEventCleanup = cleanup;
  return cleanup;
}

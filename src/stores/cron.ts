/**
 * Cron State Store
 * Manages scheduled task state
 */
import { create } from 'zustand';
import { hostApiFetch, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import type { CronJob, CronJobCreateInput, CronJobUpdateInput } from '../types/cron';

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
const CRON_SNAPSHOT_NOT_READY_RETRY_MS = 1_200;

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
      const submission = await hostApiFetch<RuntimeJobSubmission<{ status?: number; data?: CronJob }>>('/api/cron/jobs', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      const response = await waitForRuntimeJobResult<{ status?: number; data?: CronJob }>(submission.job.id);
      const job = response?.data;
      if (!job || typeof job.id !== 'string') {
        throw new Error('Invalid cron create job result');
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
      const submission = await hostApiFetch<RuntimeJobSubmission>(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      await waitForRuntimeJobResult(submission.job.id);
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === id
            ? {
              ...job,
              ...input,
              ...(input.agentId ? { agentId: input.agentId } : {}),
              updatedAt: new Date().toISOString(),
            }
            : job
        ),
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
      const submission = await hostApiFetch<RuntimeJobSubmission>(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await waitForRuntimeJobResult(submission.job.id);
      set((state) => ({
        jobs: state.jobs.filter((job) => job.id !== id),
      }));
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
      const submission = await hostApiFetch<RuntimeJobSubmission>('/api/cron/toggle', {
        method: 'POST',
        body: JSON.stringify({ id, enabled }),
      });
      await waitForRuntimeJobResult(submission.job.id);
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === id ? { ...job, enabled } : job
        ),
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
      const submission = await hostApiFetch<RuntimeJobSubmission<{ status?: number; data?: { ok?: boolean; ran?: boolean; reason?: string } }>>('/api/cron/trigger', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      const response = await waitForRuntimeJobResult<{ status?: number; data?: { ok?: boolean; ran?: boolean; reason?: string } }>(
        submission.job.id,
      );
      const result = response?.data ?? {};
      console.log('Cron trigger result:', result);
      // Refresh jobs after trigger to update lastRun/nextRun state
      await get().fetchJobs({ silent: true });
      return {
        ran: result?.ran !== false,
        reason: typeof result?.reason === 'string' ? result.reason : undefined,
      };
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

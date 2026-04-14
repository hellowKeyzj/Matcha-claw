/**
 * Cron State Store
 * Manages scheduled task state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
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

function decodeCronJobs(payload: unknown): CronJob[] {
  if (!Array.isArray(payload)) {
    throw new Error('Invalid /api/cron/jobs response: expected array');
  }
  return payload as CronJob[];
}

let inflightCronFetchPromise: Promise<void> | null = null;

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
        const jobs = decodeCronJobs(await hostApiFetch<unknown>('/api/cron/jobs'));
        set({
          jobs,
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
      const job = await hostApiFetch<CronJob>('/api/cron/jobs', {
        method: 'POST',
        body: JSON.stringify(input),
      });
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
      await hostApiFetch(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === id ? { ...job, ...input, updatedAt: new Date().toISOString() } : job
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
      await hostApiFetch(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
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
      await hostApiFetch('/api/cron/toggle', {
        method: 'POST',
        body: JSON.stringify({ id, enabled }),
      });
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
      const result = await hostApiFetch<{ ok?: boolean; ran?: boolean; reason?: string }>('/api/cron/trigger', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      console.log('Cron trigger result:', result);
      // Refresh jobs after trigger to update lastRun/nextRun state
      try {
        const refreshed = decodeCronJobs(await hostApiFetch<unknown>('/api/cron/jobs'));
        set({ jobs: refreshed });
      } catch {
        // Ignore refresh error
      }
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

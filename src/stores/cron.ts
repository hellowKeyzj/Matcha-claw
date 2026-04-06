/**
 * Cron State Store
 * Manages scheduled task state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { CronJob, CronJobCreateInput, CronJobUpdateInput } from '../types/cron';

interface CronState {
  jobs: CronJob[];
  loading: boolean;
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

export const useCronStore = create<CronState>((set) => ({
  jobs: [],
  loading: false,
  error: null,
  
  fetchJobs: async (options) => {
    const silent = options?.silent === true;
    if (!silent) {
      set({ loading: true, error: null });
    }
    
    try {
      const jobs = decodeCronJobs(await hostApiFetch<unknown>('/api/cron/jobs'));
      if (silent) {
        set({ jobs });
      } else {
        set({ jobs, loading: false });
      }
    } catch (error) {
      if (!silent) {
        set({ error: String(error), loading: false });
      }
    }
  },
  
  createJob: async (input) => {
    try {
      const job = await hostApiFetch<CronJob>('/api/cron/jobs', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      set((state) => ({ jobs: [...state.jobs, job] }));
      return job;
    } catch (error) {
      console.error('Failed to create cron job:', error);
      throw error;
    }
  },
  
  updateJob: async (id, input) => {
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
    }
  },
  
  deleteJob: async (id) => {
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
    }
  },
  
  toggleJob: async (id, enabled) => {
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
    }
  },
  
  triggerJob: async (id) => {
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
    }
  },
  
  setJobs: (jobs) => set({ jobs }),
}));

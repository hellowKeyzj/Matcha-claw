import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';
import { RUNTIME_REFRESH_JOB_COOLDOWN_MS } from '../common/runtime-job-throttle';

export const CRON_TRIGGER_JOB = 'cron.trigger';
export const CRON_CREATE_JOB = 'cron.create';
export const CRON_UPDATE_JOB = 'cron.update';
export const CRON_DELETE_JOB = 'cron.delete';
export const CRON_TOGGLE_JOB = 'cron.toggle';
export const CRON_REFRESH_JOBS_JOB = 'cron.refreshJobs';
export const CRON_REPAIR_DELIVERY_JOB = 'cron.repairDelivery';

export type CronRuntimeJobSubmission = RuntimeLongTaskSubmission;

export interface CronRuntimeJobPort {
  submitRefreshJobs(): CronRuntimeJobSubmission;
  submitCreate(payload: unknown): CronRuntimeJobSubmission;
  submitUpdate(payload: { readonly jobId: string; readonly updates: unknown }): CronRuntimeJobSubmission;
  submitDelete(payload: { readonly jobId: string }): CronRuntimeJobSubmission;
  submitToggle(payload: { readonly id: string; readonly enabled: boolean }): CronRuntimeJobSubmission;
  submitTrigger(payload: { readonly id: string }): CronRuntimeJobSubmission;
  submitRepairDelivery(): CronRuntimeJobSubmission;
}

export function createCronRuntimeJobPort(tasks: RuntimeLongTaskSubmissionPort): CronRuntimeJobPort {
  return {
    submitRefreshJobs: () => tasks.submit(CRON_REFRESH_JOBS_JOB, null, {
      dedupeKey: CRON_REFRESH_JOBS_JOB,
      dedupeCooldownMs: RUNTIME_REFRESH_JOB_COOLDOWN_MS,
    }),
    submitCreate: (payload) => tasks.submit(CRON_CREATE_JOB, payload),
    submitUpdate: (payload) => tasks.submit(CRON_UPDATE_JOB, payload, {
      dedupeKey: `${CRON_UPDATE_JOB}:${payload.jobId}`,
    }),
    submitDelete: (payload) => tasks.submit(CRON_DELETE_JOB, payload, {
      dedupeKey: `${CRON_DELETE_JOB}:${payload.jobId}`,
    }),
    submitToggle: (payload) => tasks.submit(CRON_TOGGLE_JOB, payload, {
      dedupeKey: `${CRON_TOGGLE_JOB}:${payload.id}`,
    }),
    submitTrigger: (payload) => tasks.submit(CRON_TRIGGER_JOB, payload, {
      dedupeKey: `${CRON_TRIGGER_JOB}:${payload.id}`,
    }),
    submitRepairDelivery: () => tasks.submit(CRON_REPAIR_DELIVERY_JOB, null, {
      dedupeKey: CRON_REPAIR_DELIVERY_JOB,
    }),
  };
}

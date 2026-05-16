import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';
import { RUNTIME_REFRESH_JOB_COOLDOWN_MS } from '../common/runtime-job-throttle';

export const ACTIVATE_DIRECT_CHANNEL_JOB = 'channels.activateDirect';
export const DELETE_CHANNEL_CONFIG_JOB = 'channels.deleteConfig';
export const REFRESH_CHANNEL_SNAPSHOT_JOB = 'channels.refreshSnapshot';

export type ChannelJobSubmission = RuntimeLongTaskSubmission;

export interface ChannelJobPort {
  submitRefreshSnapshot(): ChannelJobSubmission;
  submitActivateDirectChannel(payload: unknown): ChannelJobSubmission;
  submitDeleteChannelConfig(payload: { readonly channelType: string }): ChannelJobSubmission;
}

export function createChannelJobPort(tasks: RuntimeLongTaskSubmissionPort): ChannelJobPort {
  return {
    submitRefreshSnapshot: () => tasks.submit(REFRESH_CHANNEL_SNAPSHOT_JOB, null, {
      dedupeKey: REFRESH_CHANNEL_SNAPSHOT_JOB,
      dedupeCooldownMs: RUNTIME_REFRESH_JOB_COOLDOWN_MS,
    }),
    submitActivateDirectChannel: (payload) => tasks.submit(ACTIVATE_DIRECT_CHANNEL_JOB, payload),
    submitDeleteChannelConfig: (payload) => tasks.submit(DELETE_CHANNEL_CONFIG_JOB, payload),
  };
}

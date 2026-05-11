import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const REFRESH_TOKEN_USAGE_HISTORY_JOB = 'usage.refreshHistory';

export type TokenUsageHistoryJobSubmission = RuntimeLongTaskSubmission;

export interface TokenUsageHistoryJobPort {
  submitRefreshHistory(): TokenUsageHistoryJobSubmission;
}

export function createTokenUsageHistoryJobPort(tasks: RuntimeLongTaskSubmissionPort): TokenUsageHistoryJobPort {
  return {
    submitRefreshHistory: () => tasks.submit(REFRESH_TOKEN_USAGE_HISTORY_JOB, null, {
      dedupeKey: REFRESH_TOKEN_USAGE_HISTORY_JOB,
    }),
  };
}

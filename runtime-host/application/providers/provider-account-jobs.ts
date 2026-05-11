import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const CREATE_PROVIDER_ACCOUNT_JOB = 'providers.createAccount';
export const SET_DEFAULT_PROVIDER_ACCOUNT_JOB = 'providers.setDefaultAccount';
export const UPDATE_PROVIDER_ACCOUNT_JOB = 'providers.updateAccount';
export const DELETE_PROVIDER_ACCOUNT_JOB = 'providers.deleteAccount';

export type ProviderAccountJobSubmission = RuntimeLongTaskSubmission;

export interface ProviderAccountJobPort {
  submitCreate(payload: unknown): ProviderAccountJobSubmission;
  submitSetDefault(payload: unknown): ProviderAccountJobSubmission;
  submitUpdate(accountId: string, payload: unknown): ProviderAccountJobSubmission;
  submitDelete(accountId: string, apiKeyOnly: boolean): ProviderAccountJobSubmission;
}

export function createProviderAccountJobPort(tasks: RuntimeLongTaskSubmissionPort): ProviderAccountJobPort {
  return {
    submitCreate: (payload) => tasks.submit(CREATE_PROVIDER_ACCOUNT_JOB, payload),
    submitSetDefault: (payload) => tasks.submit(SET_DEFAULT_PROVIDER_ACCOUNT_JOB, payload),
    submitUpdate: (accountId, payload) => tasks.submit(UPDATE_PROVIDER_ACCOUNT_JOB, { accountId, payload }),
    submitDelete: (accountId, apiKeyOnly) => tasks.submit(DELETE_PROVIDER_ACCOUNT_JOB, { accountId, apiKeyOnly }),
  };
}

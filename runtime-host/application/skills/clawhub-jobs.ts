import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const CLAWHUB_INSTALL_JOB = 'clawhub.install';
export const CLAWHUB_UNINSTALL_JOB = 'clawhub.uninstall';

export interface ClawHubInstallJobPayload {
  readonly slug: string;
  readonly version?: string;
  readonly force?: boolean;
}

export interface ClawHubUninstallJobPayload {
  readonly slug: string;
}

export type ClawHubJobSubmission = RuntimeLongTaskSubmission;

export interface ClawHubJobPort {
  submitInstall(payload: ClawHubInstallJobPayload): ClawHubJobSubmission;
  submitUninstall(payload: ClawHubUninstallJobPayload): ClawHubJobSubmission;
}

export function createClawHubJobPort(tasks: RuntimeLongTaskSubmissionPort): ClawHubJobPort {
  return {
    submitInstall: (payload) => tasks.submit(CLAWHUB_INSTALL_JOB, payload, {
      dedupeKey: `${CLAWHUB_INSTALL_JOB}:${payload.slug}`,
    }),
    submitUninstall: (payload) => tasks.submit(CLAWHUB_UNINSTALL_JOB, payload, {
      dedupeKey: `${CLAWHUB_UNINSTALL_JOB}:${payload.slug}`,
    }),
  };
}

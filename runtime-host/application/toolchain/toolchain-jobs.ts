import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const TOOLCHAIN_UV_INSTALL_JOB = 'toolchain.uvInstall';

export type ToolchainJobSubmission = RuntimeLongTaskSubmission;

export interface ToolchainJobPort {
  submitUvInstall(): ToolchainJobSubmission;
}

export function createToolchainJobPort(tasks: RuntimeLongTaskSubmissionPort): ToolchainJobPort {
  return {
    submitUvInstall: () => tasks.submit(TOOLCHAIN_UV_INSTALL_JOB, null, {
      queue: 'low',
      dedupeKey: TOOLCHAIN_UV_INSTALL_JOB,
    }),
  };
}

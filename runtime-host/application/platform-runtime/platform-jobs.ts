import type { ToolSource } from '../../shared/platform-runtime-contracts';
import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const PLATFORM_INSTALL_NATIVE_TOOL_JOB = 'platform.installNativeTool';
export const PLATFORM_RECONCILE_TOOLS_JOB = 'platform.reconcileTools';

export type PlatformJobSubmission = RuntimeLongTaskSubmission;

export interface PlatformJobPort {
  submitInstallNativeTool(source: ToolSource): PlatformJobSubmission;
  submitReconcileTools(): PlatformJobSubmission;
}

export function createPlatformJobPort(tasks: RuntimeLongTaskSubmissionPort): PlatformJobPort {
  return {
    submitInstallNativeTool: (source) => tasks.submit(PLATFORM_INSTALL_NATIVE_TOOL_JOB, { source }, {
      dedupeKey: `${PLATFORM_INSTALL_NATIVE_TOOL_JOB}:${JSON.stringify(source)}`,
    }),
    submitReconcileTools: () => tasks.submit(PLATFORM_RECONCILE_TOOLS_JOB, null, {
      dedupeKey: PLATFORM_RECONCILE_TOOLS_JOB,
    }),
  };
}

import type { RuntimePlatform } from '../common/runtime-ports';
import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const COLLECT_DIAGNOSTICS_JOB = 'diagnostics.collect';

export interface DiagnosticsCollectInput {
  userDataDir: string;
  runtimeDataRootDir: string;
  appInfo: {
    name: string;
    version: string;
    isPackaged: boolean;
    platform: RuntimePlatform;
    arch: string;
    electron?: string;
    node: string;
  };
  gatewayStatus?: unknown;
  gatewayRuntimePaths?: unknown;
  licenseGateSnapshot?: unknown;
}

export type DiagnosticsJobSubmission = RuntimeLongTaskSubmission;

export interface DiagnosticsJobPort {
  submitCollect(input: DiagnosticsCollectInput): DiagnosticsJobSubmission;
}

export function createDiagnosticsJobPort(tasks: RuntimeLongTaskSubmissionPort): DiagnosticsJobPort {
  return {
    submitCollect: (input) => tasks.submit(COLLECT_DIAGNOSTICS_JOB, input, {
      queue: 'low',
      dedupeKey: COLLECT_DIAGNOSTICS_JOB,
    }),
  };
}

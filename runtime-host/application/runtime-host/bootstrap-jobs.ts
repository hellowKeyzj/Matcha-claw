import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from './runtime-task-ports';

export const GATEWAY_PRELAUNCH_JOB = 'runtimeHost.gatewayPrelaunch';
export const WORKSPACE_TEMPLATE_MIGRATION_JOB = 'runtimeHost.workspaceTemplateMigration';

export interface GatewayPrelaunchInput {
  gatewayToken?: string;
  proxyEnabled?: boolean;
  proxyServer?: string;
  proxyBypassRules?: string;
}
export type RuntimeHostBootstrapJobSubmission = RuntimeLongTaskSubmission;

export interface RuntimeHostBootstrapJobPort {
  submitGatewayPrelaunch(input: GatewayPrelaunchInput): RuntimeHostBootstrapJobSubmission;
  submitWorkspaceTemplateMigration(): RuntimeHostBootstrapJobSubmission;
}

export function createRuntimeHostBootstrapJobPort(
  tasks: RuntimeLongTaskSubmissionPort,
): RuntimeHostBootstrapJobPort {
  return {
    submitGatewayPrelaunch: (input) => tasks.submit(GATEWAY_PRELAUNCH_JOB, input, {
      queue: 'critical',
      dedupeKey: GATEWAY_PRELAUNCH_JOB,
    }),
    submitWorkspaceTemplateMigration: () => tasks.submit(WORKSPACE_TEMPLATE_MIGRATION_JOB, null, {
      dedupeKey: WORKSPACE_TEMPLATE_MIGRATION_JOB,
    }),
  };
}

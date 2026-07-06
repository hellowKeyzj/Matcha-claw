import { RUNTIME_REFRESH_JOB_COOLDOWN_MS } from '../../../common/runtime-job-throttle';
import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../../../runtime-host/runtime-task-ports';

export const OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB = 'externalConnectors.openclawMcpStatusRefresh';

export type OpenClawMcpServerStatusRefreshJobPayload = {
  readonly sessionKey: string;
};

export type OpenClawMcpServerStatusRefreshJobSubmission = RuntimeLongTaskSubmission;

export interface OpenClawMcpServerStatusRefreshJobPort {
  submitMcpServerStatusRefresh(payload: OpenClawMcpServerStatusRefreshJobPayload): OpenClawMcpServerStatusRefreshJobSubmission;
}

export function createOpenClawMcpServerStatusRefreshJobPort(
  tasks: RuntimeLongTaskSubmissionPort,
): OpenClawMcpServerStatusRefreshJobPort {
  return {
    submitMcpServerStatusRefresh: (payload) => tasks.submit(OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB, payload, {
      queue: 'low',
      dedupeKey: buildOpenClawMcpStatusRefreshDedupeKey(payload.sessionKey),
      dedupeCooldownMs: RUNTIME_REFRESH_JOB_COOLDOWN_MS,
    }),
  };
}

export function buildOpenClawMcpStatusRefreshDedupeKey(sessionKey: string): string {
  return `${OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB}:${sessionKey}`;
}

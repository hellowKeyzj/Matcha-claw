import type { GatewayTransportIssue } from '../../../runtime-host/shared/gateway-error';
import type { ChatSessionRuntimeState } from '@/stores/chat';

export const TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS = 700;

export function isTransientRuntimeErrorBanner(input: {
  runtime: Pick<ChatSessionRuntimeState, 'lastIssue' | 'runPhase'>;
  gatewayIssue?: GatewayTransportIssue;
  message: string | null;
}): boolean {
  if (!input.message) {
    return false;
  }

  const issue = input.runtime.lastIssue ?? input.gatewayIssue ?? null;
  if (!issue || issue.retryable !== true) {
    return false;
  }

  if (input.runtime.runPhase === 'error') {
    return false;
  }

  return issue.source === 'runtime'
    || issue.source === 'connect'
    || issue.source === 'socket-close'
    || issue.source === 'heartbeat-timeout';
}

export function shouldShowRuntimeErrorBannerImmediately(input: {
  runtime: Pick<ChatSessionRuntimeState, 'lastIssue' | 'runPhase'>;
  gatewayIssue?: GatewayTransportIssue;
  message: string | null;
}): boolean {
  return Boolean(input.message) && !isTransientRuntimeErrorBanner(input);
}

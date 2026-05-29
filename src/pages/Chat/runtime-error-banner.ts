import type { GatewayTransportIssue } from '../../../runtime-host/shared/gateway-error';
import type { ChatRunPhase, ChatSessionRuntimeState } from '@/stores/chat/types';
import { isRunActive } from '@/stores/chat/types';

export const TRANSIENT_RUNTIME_ERROR_BANNER_DELAY_MS = 700;

function isGatewayTransportIssue(value: GatewayTransportIssue | null | undefined): value is GatewayTransportIssue {
  return Boolean(value?.source);
}

function shouldDelayGatewayFallbackError(input: {
  gatewayIssue?: GatewayTransportIssue;
  runPhase: ChatRunPhase;
}): boolean {
  if (!isRunActive({ runPhase: input.runPhase })) {
    return false;
  }
  if (!input.gatewayIssue) {
    return true;
  }
  return input.gatewayIssue.retryable !== false;
}

export function isTransientRuntimeErrorBanner(input: {
  runtime: Pick<ChatSessionRuntimeState, 'lastIssue' | 'runPhase'>;
  gatewayIssue?: GatewayTransportIssue;
  message: string | null;
}): boolean {
  if (!input.message) {
    return false;
  }

  if (!input.runtime.lastIssue && shouldDelayGatewayFallbackError({
    gatewayIssue: input.gatewayIssue,
    runPhase: input.runtime.runPhase,
  })) {
    return true;
  }

  const issue = input.runtime.lastIssue ?? input.gatewayIssue ?? null;
  if (!isGatewayTransportIssue(issue) || issue.retryable !== true) {
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

import { describe, expect, it } from 'vitest';
import {
  isTransientRuntimeErrorBanner,
  shouldShowRuntimeErrorBannerImmediately,
} from '@/pages/Chat/runtime-error-banner';
import type { ChatSessionRuntimeState } from '@/stores/chat';
import type { GatewayTransportIssue } from '../../runtime-host/shared/gateway-error';

function runtime(patch: Partial<ChatSessionRuntimeState> = {}): ChatSessionRuntimeState {
  return {
    activeRunId: null,
    runPhase: 'streaming',
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runtimeActivity: null,
    lastUserMessageAt: null,
    lastError: null,
    lastIssue: null,
    updatedAt: null,
    ...patch,
  };
}

function issue(patch: Partial<GatewayTransportIssue> = {}): GatewayTransportIssue {
  return {
    source: 'runtime',
    message: 'Gateway control plane unavailable',
    at: 1,
    retryable: true,
    ...patch,
  };
}

describe('chat runtime error banner visibility', () => {
  it('delays retryable control-plane issues while the run is not terminal error', () => {
    const state = runtime({ lastIssue: issue() });

    expect(isTransientRuntimeErrorBanner({ runtime: state, message: state.lastIssue?.message ?? null })).toBe(true);
    expect(shouldShowRuntimeErrorBannerImmediately({ runtime: state, message: state.lastIssue?.message ?? null })).toBe(false);
  });

  it('shows terminal run errors immediately even when the issue is retryable', () => {
    const state = runtime({
      runPhase: 'error',
      lastError: 'The active run disconnected before a terminal event was received.',
      lastIssue: issue(),
    });

    expect(isTransientRuntimeErrorBanner({ runtime: state, message: state.lastError })).toBe(false);
    expect(shouldShowRuntimeErrorBannerImmediately({ runtime: state, message: state.lastError })).toBe(true);
  });

  it('shows non-retryable provider/auth errors immediately', () => {
    const state = runtime({
      runPhase: 'error',
      lastError: 'Authentication failed',
      lastIssue: issue({ source: 'rpc', code: 'AUTH_UNAUTHORIZED', retryable: false }),
    });

    expect(isTransientRuntimeErrorBanner({ runtime: state, message: state.lastError })).toBe(false);
    expect(shouldShowRuntimeErrorBannerImmediately({ runtime: state, message: state.lastError })).toBe(true);
  });

  it('delays retryable gateway fallback issues while a run is active', () => {
    const state = runtime({ runPhase: 'submitted' });
    const gatewayIssue = issue({ source: 'connect', message: 'Gateway reconnecting' });

    expect(isTransientRuntimeErrorBanner({
      runtime: state,
      gatewayIssue,
      message: gatewayIssue.message,
    })).toBe(true);
  });

  it('delays gateway fallback text without a structured issue while a run is active', () => {
    const state = runtime({ runPhase: 'submitted' });

    expect(shouldShowRuntimeErrorBannerImmediately({
      runtime: state,
      message: 'Gateway RPC timeout: chat.send',
    })).toBe(false);
  });

  it('keeps non-retryable gateway fallback issues immediate while a run is active', () => {
    const state = runtime({ runPhase: 'submitted' });
    const gatewayIssue = issue({ source: 'rpc', message: 'Authentication failed', retryable: false });

    expect(shouldShowRuntimeErrorBannerImmediately({
      runtime: state,
      gatewayIssue,
      message: gatewayIssue.message,
    })).toBe(true);
  });
});

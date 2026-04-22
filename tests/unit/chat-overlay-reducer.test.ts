import { describe, expect, it } from 'vitest';
import type { SessionRuntimeSnapshot, ToolStatus } from '@/stores/chat/types';
import {
  reduceRuntimeOverlay,
} from '@/stores/chat/overlay-reducer';

function buildRuntimeSnapshot(
  partial: Partial<SessionRuntimeSnapshot> = {},
): SessionRuntimeSnapshot {
  return {
    messages: [],
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingMessage: null,
    streamRuntime: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
    ...partial,
  };
}

function buildRuntimeState(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [],
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingMessage: null,
    streamRuntime: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    sessions: [],
    currentSessionKey: 'agent:main:main',
    sessionLabels: {},
    sessionLastActivity: {},
    sessionReadyByKey: {},
    sessionRuntimeByKey: {},
    showThinking: true,
    thinkingLevel: null,
    ...partial,
  };
}

describe('chat runtime overlay reducer', () => {
  it('restores runtime and forces waiting_tool while approvals exist', () => {
    const snapshot = buildRuntimeSnapshot({
      sending: true,
      runPhase: 'streaming',
      approvalStatus: 'idle',
      activeRunId: 'run-1',
    });

    const patch = reduceRuntimeOverlay(buildRuntimeState() as never, {
      type: 'session_runtime_restored',
      targetRuntime: snapshot,
      currentPendingApprovals: 2,
    });

    expect(patch.sending).toBe(true);
    expect(patch.activeRunId).toBe('run-1');
    expect(patch.runPhase).toBe('waiting_tool');
    expect(patch.approvalStatus).toBe('awaiting_approval');
  });

  it('restores original runPhase when no pending approvals', () => {
    const snapshot = buildRuntimeSnapshot({
      runPhase: 'done',
      approvalStatus: 'idle',
    });

    const patch = reduceRuntimeOverlay(buildRuntimeState() as never, {
      type: 'session_runtime_restored',
      targetRuntime: snapshot,
      currentPendingApprovals: 0,
    });

    expect(patch.runPhase).toBe('done');
    expect(patch.approvalStatus).toBe('idle');
  });

  it('commits tool-result runtime state via reducer patch', () => {
    const nextTools: ToolStatus[] = [
      {
        name: 'shell',
        status: 'completed',
        updatedAt: Date.now(),
      },
    ];
    const patch = reduceRuntimeOverlay(buildRuntimeState() as never, {
      type: 'tool_result_committed',
      pendingToolImages: [{
        fileName: 'result.png',
        mimeType: 'image/png',
        fileSize: 42,
        preview: 'data:image/png;base64,abc',
      }],
      streamingTools: nextTools,
    });

    expect(patch.runPhase).toBe('waiting_tool');
    expect(patch.pendingFinal).toBe(true);
    expect(patch.streamingTools).toBe(nextTools);
    expect(patch.pendingToolImages).toHaveLength(1);
    expect(patch.streamingMessage).toBeNull();
  });

  it('queues stream delta into runtime source and keeps tool-only delta from replacing current view', () => {
    const currentStream = { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    const state = buildRuntimeState({
      runPhase: 'submitted',
      error: 'stale',
      streamingMessage: currentStream,
      streamRuntime: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        chunks: ['hello'],
        rawChars: 5,
        displayedChars: 5,
        status: 'streaming',
        rafId: null,
      },
    });

    const patch = reduceRuntimeOverlay(state as never, {
      type: 'stream_delta_queued',
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      text: 'hello world',
      updates: [],
    });
    const next = patch === state ? state : { ...state, ...patch };

    expect(next.runPhase).toBe('streaming');
    expect(next.error).toBeNull();
    expect(next.streamingMessage).toEqual(currentStream);
    expect(next.streamRuntime).toMatchObject({
      rawChars: 11,
      displayedChars: 5,
    });
  });

  it('clears event error and resets approval status after final refresh when no pending approvals', () => {
    const state = buildRuntimeState({
      error: 'boom',
      approvalStatus: 'awaiting_approval',
    });

    const clearedErrorPatch = reduceRuntimeOverlay(state as never, { type: 'event_error_cleared' });
    const afterError = clearedErrorPatch === state ? state : { ...state, ...clearedErrorPatch };
    expect(afterError.error).toBeNull();

    const approvalPatch = reduceRuntimeOverlay(afterError as never, {
      type: 'final_history_refresh_requested',
      hasPendingApprovals: false,
    });
    const afterApproval = approvalPatch === afterError ? afterError : { ...afterError, ...approvalPatch };
    expect(afterApproval.approvalStatus).toBe('idle');
  });
});

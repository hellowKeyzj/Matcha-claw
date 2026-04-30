import { describe, expect, it } from 'vitest';
import { reduceSessionRuntime } from '@/stores/chat/runtime-state-reducer';
import type { ChatSessionRuntimeState, ToolStatus } from '@/stores/chat/types';

function buildRuntimeState(
  partial: Partial<ChatSessionRuntimeState> = {},
): ChatSessionRuntimeState {
  return {
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingMessageId: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
    ...partial,
  };
}

describe('chat runtime overlay reducer', () => {
  it('restores runtime and forces waiting_tool while approvals exist', () => {
    const snapshot = buildRuntimeState({
      sending: true,
      runPhase: 'streaming',
      approvalStatus: 'idle',
      activeRunId: 'run-1',
    });

    const patch = reduceSessionRuntime(snapshot, {
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
    const snapshot = buildRuntimeState({
      runPhase: 'done',
      approvalStatus: 'idle',
    });

    const patch = reduceSessionRuntime(snapshot, {
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
    const patch = reduceSessionRuntime(buildRuntimeState({
      streamingMessageId: 'assistant-1',
    }), {
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
    expect(patch.streamingMessageId).toBeNull();
  });

  it('queues stream delta into the active streaming message id', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'submitted',
      lastUserMessageAt: 1_700_000_000_000,
      streamingMessageId: 'assistant-1',
    });

    const patch = reduceSessionRuntime(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      messageId: 'assistant-1',
      updates: [],
    });

    expect(patch.runPhase).toBe('streaming');
    expect(patch.streamingMessageId ?? state.streamingMessageId).toBe('assistant-1');
  });

  it('adopts a new stream message id when delta first binds', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
    });

    const patch = reduceSessionRuntime(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      messageId: 'assistant-1',
      updates: [],
    });

    expect(patch.streamingMessageId).toBe('assistant-1');
  });

  it('keeps existing active message id when a tool-only delta arrives', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      streamingMessageId: 'assistant-1',
    });

    const patch = reduceSessionRuntime(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      messageId: 'assistant-1',
      updates: [{
        name: 'shell',
        status: 'running',
        updatedAt: Date.now(),
      }],
    });

    expect(patch.streamingMessageId ?? state.streamingMessageId).toBe('assistant-1');
    expect(patch.streamingTools).toHaveLength(1);
  });

  it('clears the active streaming message id immediately when final assistant message is committed', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      streamingMessageId: 'assistant-1',
    });

    const patch = reduceSessionRuntime(state, {
      type: 'final_message_committed',
      hasOutput: true,
      toolOnly: false,
      streamingTools: [],
    });

    expect(patch.streamingMessageId).toBeNull();
    expect(patch.sending).toBe(false);
    expect(patch.activeRunId).toBeNull();
    expect(patch.pendingFinal).toBe(false);
    expect(patch.runPhase).toBe('done');
  });

  it('clears pending user when history confirms a final assistant message', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      pendingFinal: true,
      runPhase: 'finalizing',
      pendingUserMessage: {
        clientMessageId: 'user-local-1',
        createdAtMs: 1_700_000_000_000,
        message: {
          id: 'user-local-1',
          role: 'user',
          content: 'hello',
          timestamp: 1_700_000_000,
        },
      },
    });

    const patch = reduceSessionRuntime(state, {
      type: 'history_snapshot',
      hasRecentAssistantActivity: false,
      hasRecentFinalAssistantMessage: true,
    });

    expect(patch.sending).toBe(false);
    expect(patch.activeRunId).toBeNull();
    expect(patch.pendingFinal).toBe(false);
    expect(patch.runPhase).toBe('done');
    expect(patch.pendingUserMessage).toBeNull();
  });

  it('does not let a lingering active stream id block final history settlement', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      pendingFinal: true,
      runPhase: 'finalizing',
      streamingMessageId: 'assistant-1',
      pendingUserMessage: {
        clientMessageId: 'user-local-1',
        createdAtMs: 1_700_000_000_000,
        message: {
          id: 'user-local-1',
          role: 'user',
          content: 'hello',
          timestamp: 1_700_000_000,
        },
      },
    });

    const patch = reduceSessionRuntime(state, {
      type: 'history_snapshot',
      hasRecentAssistantActivity: false,
      hasRecentFinalAssistantMessage: true,
    });

    expect(patch.sending).toBe(false);
    expect(patch.activeRunId).toBeNull();
    expect(patch.pendingFinal).toBe(false);
    expect(patch.runPhase).toBe('done');
    expect(patch.pendingUserMessage).toBeNull();
    expect(patch.streamingMessageId).toBeNull();
  });

});

import { describe, expect, it } from 'vitest';
import { reduceRuntimeOverlay } from '@/stores/chat/overlay-reducer';
import { createAssistantOverlay } from '@/stores/chat/stream-overlay-message';
import type { ChatSessionRuntimeState, ToolStatus } from '@/stores/chat/types';

function buildRuntimeState(
  partial: Partial<ChatSessionRuntimeState> = {},
): ChatSessionRuntimeState {
  return {
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    assistantOverlay: null,
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

    const patch = reduceRuntimeOverlay(snapshot, {
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

    const patch = reduceRuntimeOverlay(snapshot, {
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
    const patch = reduceRuntimeOverlay(buildRuntimeState({
      assistantOverlay: createAssistantOverlay({
        runId: 'run-1',
        messageId: 'assistant-1',
        committedText: 'hello',
        targetText: 'hello world',
      }),
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
    expect(patch.assistantOverlay).toBeNull();
  });

  it('queues stream delta into assistant overlay without rewinding committed text', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'submitted',
      lastUserMessageAt: 1_700_000_000_000,
      assistantOverlay: createAssistantOverlay({
        runId: 'run-1',
        messageId: 'assistant-1',
        sourceMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1_700_000_000,
        },
        committedText: 'hello',
        targetText: 'hello',
        status: 'streaming',
      }),
    });

    const patch = reduceRuntimeOverlay(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      text: 'hello world',
      textMode: 'snapshot',
      messageId: 'assistant-1',
      updates: [],
    });

    expect(patch.runPhase).toBe('streaming');
    expect(patch.assistantOverlay).toMatchObject({
      messageId: 'assistant-1',
      committedText: 'hello',
      targetText: 'hello world',
      status: 'streaming',
    });
  });

  it('appends monotonic delta chunks without treating them as full snapshot replacement', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      assistantOverlay: createAssistantOverlay({
        runId: 'run-1',
        messageId: 'assistant-1',
        sourceMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1_700_000_000,
        },
        committedText: 'hello',
        targetText: 'hello',
        status: 'streaming',
      }),
    });

    const patch = reduceRuntimeOverlay(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      text: ' world',
      textMode: 'append',
      messageId: 'assistant-1',
      updates: [],
    });

    expect(patch.assistantOverlay).toMatchObject({
      messageId: 'assistant-1',
      committedText: 'hello',
      targetText: 'hello world',
      status: 'streaming',
    });
  });

  it('keeps existing visible text when a tool-only delta carries no renderable assistant text', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      assistantOverlay: createAssistantOverlay({
        runId: 'run-1',
        messageId: 'assistant-1',
        sourceMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello',
          timestamp: 1_700_000_000,
        },
        committedText: 'hello',
        targetText: 'hello',
        status: 'streaming',
      }),
    });

    const patch = reduceRuntimeOverlay(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      text: '',
      textMode: 'keep',
      messageId: 'assistant-1',
      updates: [{
        name: 'shell',
        status: 'running',
        updatedAt: Date.now(),
      }],
    });

    expect(patch.assistantOverlay).toMatchObject({
      targetText: 'hello',
      committedText: 'hello',
    });
    expect(patch.streamingTools).toHaveLength(1);
  });

  it('clears assistant overlay immediately when final assistant message is committed', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      assistantOverlay: createAssistantOverlay({
        runId: 'run-1',
        messageId: 'assistant-1',
        sourceMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello world',
          timestamp: 1_700_000_000,
        },
        committedText: 'hello',
        targetText: 'hello world',
        status: 'streaming',
      }),
    });

    const patch = reduceRuntimeOverlay(state, {
      type: 'final_message_committed',
      hasOutput: true,
      toolOnly: false,
      streamingTools: [],
    });

    expect(patch.assistantOverlay).toBeNull();
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

    const patch = reduceRuntimeOverlay(state, {
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

  it('does not let a lingering overlay block final history settlement', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      pendingFinal: true,
      runPhase: 'finalizing',
      assistantOverlay: createAssistantOverlay({
        runId: 'run-1',
        messageId: 'assistant-1',
        sourceMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello world',
          timestamp: 1_700_000_000,
        },
        committedText: 'hello world',
        targetText: 'hello world',
        status: 'finalizing',
      }),
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

    const patch = reduceRuntimeOverlay(state, {
      type: 'history_snapshot',
      hasRecentAssistantActivity: false,
      hasRecentFinalAssistantMessage: true,
    });

    expect(patch.sending).toBe(false);
    expect(patch.activeRunId).toBeNull();
    expect(patch.pendingFinal).toBe(false);
    expect(patch.runPhase).toBe('done');
    expect(patch.pendingUserMessage).toBeNull();
    expect(patch.assistantOverlay).toBeNull();
  });

  it('clears approval wait flag after final history refresh when no pending approvals', () => {
    const state = buildRuntimeState({
      approvalStatus: 'awaiting_approval',
    });

    const patch = reduceRuntimeOverlay(state, {
      type: 'final_history_refresh_requested',
      hasPendingApprovals: false,
    });

    expect(patch.approvalStatus).toBe('idle');
  });
});

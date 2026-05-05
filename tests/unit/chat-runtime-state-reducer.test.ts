import { describe, expect, it } from 'vitest';
import { reduceSessionRuntime } from '@/stores/chat/runtime-state-reducer';
import type { ChatSessionRuntimeState } from '@/stores/chat/types';

function buildRuntimeState(
  partial: Partial<ChatSessionRuntimeState> = {},
): ChatSessionRuntimeState {
  return {
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    pendingFinal: false,
    lastUserMessageAt: null,
    ...partial,
  };
}

describe('chat runtime state reducer', () => {
  it('restores runtime and forces waiting_tool while approvals exist', () => {
    const snapshot = buildRuntimeState({
      sending: true,
      runPhase: 'streaming',
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
  });

  it('restores original runPhase when no pending approvals', () => {
    const snapshot = buildRuntimeState({
      runPhase: 'done',
    });

    const patch = reduceSessionRuntime(snapshot, {
      type: 'session_runtime_restored',
      targetRuntime: snapshot,
      currentPendingApprovals: 0,
    });

    expect(patch.runPhase).toBe('done');
  });

  it('commits tool-result runtime state via reducer patch', () => {
    const patch = reduceSessionRuntime(buildRuntimeState({
      activeTurnItemKey: 'assistant-1',
    }), {
      type: 'tool_result_committed',
    });

    expect(patch.runPhase).toBe('waiting_tool');
    expect(patch.pendingFinal).toBe(true);
    expect(patch.activeTurnItemKey).toBeNull();
  });

  it('queues stream delta into the active streaming anchor', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'submitted',
      lastUserMessageAt: 1_700_000_000_000,
      activeTurnItemKey: 'assistant-1',
    });

    const patch = reduceSessionRuntime(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      anchorKey: 'assistant-1',
    });

    expect(patch.runPhase).toBe('streaming');
    expect(patch.activeTurnItemKey ?? state.activeTurnItemKey).toBe('assistant-1');
  });

  it('adopts a new stream anchor when delta first binds', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
    });

    const patch = reduceSessionRuntime(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      anchorKey: 'assistant-1',
    });

    expect(patch.activeTurnItemKey).toBe('assistant-1');
  });

  it('keeps existing active anchor when a tool-only delta arrives', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      activeTurnItemKey: 'assistant-1',
    });

    const patch = reduceSessionRuntime(state, {
      type: 'stream_delta_queued',
      runId: 'run-1',
      anchorKey: 'assistant-1',
    });

    expect(patch.activeTurnItemKey ?? state.activeTurnItemKey).toBe('assistant-1');
  });

  it('clears the active streaming anchor immediately when final assistant message is committed', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming',
      lastUserMessageAt: 1_700_000_000_000,
      activeTurnItemKey: 'assistant-1',
    });

    const patch = reduceSessionRuntime(state, {
      type: 'final_message_committed',
      hasOutput: true,
      toolOnly: false,
    });

    expect(patch.activeTurnItemKey).toBeNull();
    expect(patch.sending).toBe(false);
    expect(patch.activeRunId).toBeNull();
    expect(patch.pendingFinal).toBe(false);
    expect(patch.runPhase).toBe('done');
  });

  it('settles the active run when history confirms a final assistant message', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      pendingFinal: true,
      runPhase: 'finalizing',
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
  });

  it('keeps the current stream anchor available when history settles the run', () => {
    const state = buildRuntimeState({
      sending: true,
      activeRunId: 'run-1',
      pendingFinal: true,
      runPhase: 'finalizing',
      activeTurnItemKey: 'assistant-1',
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
    expect(patch.activeTurnItemKey ?? state.activeTurnItemKey).toBe('assistant-1');
  });

});

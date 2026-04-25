import type {
  ApprovalStatus,
  AttachedFileMeta,
  ChatSessionRuntimeState,
  PendingUserMessageOverlay,
  RawMessage,
  StreamRuntimeStatus,
  ToolStatus,
} from './types';
import { upsertToolStatuses } from './event-helpers';
import { hasActiveStreamingRun } from './runtime-stream-state';
import { createAssistantOverlay, resolveOverlaySourceMessage } from './stream-overlay-message';

type RuntimeStateLike = ChatSessionRuntimeState;

interface RuntimeRunStartedAction {
  type: 'run_started';
  runId?: string | null;
}

interface RuntimeSendSubmittedAction {
  type: 'send_submitted';
  nowMs: number;
  pendingUserMessage: PendingUserMessageOverlay;
}

interface RuntimeSendRunBoundAction {
  type: 'send_run_bound';
  runId: string | null | undefined;
}

interface RuntimeSendWaitingApprovalAction {
  type: 'send_waiting_approval';
}

interface RuntimeSendFailedAction {
  type: 'send_failed';
  error: string;
  approvalStatus?: ApprovalStatus;
  clearRun?: boolean;
}

interface RuntimePendingApprovalsSyncedAction {
  type: 'pending_approvals_synced';
  currentPendingCount: number;
  nextActiveRunId: string | null;
}

interface RuntimeApprovalRequestedAction {
  type: 'approval_requested';
  isCurrentSession: boolean;
  runId?: string;
}

interface RuntimeApprovalResolvedAction {
  type: 'approval_resolved';
  stillPendingCurrent: boolean;
  abortedCurrentByDeny: boolean;
}

interface RuntimeHistorySnapshotAction {
  type: 'history_snapshot';
  hasRecentAssistantActivity: boolean;
  hasRecentFinalAssistantMessage: boolean;
}

interface RuntimeClearErrorAction {
  type: 'clear_error';
}

interface RuntimeSessionRuntimeRestoredAction {
  type: 'session_runtime_restored';
  targetRuntime: ChatSessionRuntimeState;
  currentPendingApprovals: number;
}

interface RuntimeToolResultCommittedAction {
  type: 'tool_result_committed';
  pendingToolImages: AttachedFileMeta[];
  streamingTools: ToolStatus[];
}

interface RuntimeDeltaReceivedAction {
  type: 'delta_received';
}

interface RuntimeStreamDeltaQueuedAction {
  type: 'stream_delta_queued';
  runId: string;
  text: string;
  textMode: 'append' | 'snapshot' | 'keep';
  messageId?: string | null;
  message?: RawMessage | null;
  updates?: ToolStatus[];
}

interface RuntimeStreamViewAdvancedAction {
  type: 'stream_view_advanced';
  committedText: string;
  status: StreamRuntimeStatus;
  rafId: number | null;
}

interface RuntimeStreamSchedulerUpdatedAction {
  type: 'stream_scheduler_updated';
  rafId: number | null;
}

interface RuntimeEventErrorClearedAction {
  type: 'event_error_cleared';
}

interface RuntimeFinalHistoryRefreshRequestedAction {
  type: 'final_history_refresh_requested';
  hasPendingApprovals: boolean;
}

interface RuntimeRunAbortedAction {
  type: 'run_aborted';
}

interface RuntimeEventErrorAction {
  type: 'event_error';
  error: string;
}

interface RuntimeErrorRecoveryTimeoutAction {
  type: 'error_recovery_timeout';
}

interface RuntimeFinalWithoutMessageAction {
  type: 'final_without_message';
  completedSignal: boolean;
}

interface RuntimeFinalMessageCommittedAction {
  type: 'final_message_committed';
  hasOutput: boolean;
  toolOnly: boolean;
  streamingTools: ToolStatus[];
}

export type RuntimeOverlayAction =
  | RuntimeRunStartedAction
  | RuntimeSendSubmittedAction
  | RuntimeSendRunBoundAction
  | RuntimeSendWaitingApprovalAction
  | RuntimeSendFailedAction
  | RuntimePendingApprovalsSyncedAction
  | RuntimeApprovalRequestedAction
  | RuntimeApprovalResolvedAction
  | RuntimeHistorySnapshotAction
  | RuntimeClearErrorAction
  | RuntimeSessionRuntimeRestoredAction
  | RuntimeToolResultCommittedAction
  | RuntimeDeltaReceivedAction
  | RuntimeStreamDeltaQueuedAction
  | RuntimeStreamViewAdvancedAction
  | RuntimeStreamSchedulerUpdatedAction
  | RuntimeEventErrorClearedAction
  | RuntimeFinalHistoryRefreshRequestedAction
  | RuntimeRunAbortedAction
  | RuntimeEventErrorAction
  | RuntimeErrorRecoveryTimeoutAction
  | RuntimeFinalWithoutMessageAction
  | RuntimeFinalMessageCommittedAction;

function normalizeRunId(runId: string | null | undefined): string {
  return typeof runId === 'string' ? runId.trim() : '';
}

function resolveOverlayMessageId(runId: string, messageId?: string | null, currentMessageId?: string | null): string {
  const candidate = typeof messageId === 'string' && messageId.trim()
    ? messageId.trim()
    : (typeof currentMessageId === 'string' && currentMessageId.trim() ? currentMessageId.trim() : '');
  return candidate || `stream:${runId}`;
}

function appendMonotonicText(currentText: string, incomingText: string): string {
  if (!incomingText) {
    return currentText;
  }
  if (!currentText) {
    return incomingText;
  }
  if (incomingText.startsWith(currentText)) {
    return incomingText;
  }
  if (currentText.startsWith(incomingText)) {
    return currentText;
  }

  const maxOverlap = Math.min(currentText.length, incomingText.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (currentText.endsWith(incomingText.slice(0, size))) {
      return `${currentText}${incomingText.slice(size)}`;
    }
  }

  return `${currentText}${incomingText}`;
}

function resolveNextOverlayTargetText(
  currentOverlay: ChatSessionRuntimeState['assistantOverlay'],
  input: Pick<RuntimeStreamDeltaQueuedAction, 'text' | 'textMode'>,
): string {
  const currentTargetText = currentOverlay?.targetText ?? '';
  switch (input.textMode) {
    case 'keep':
      return currentTargetText;
    case 'snapshot':
      return input.text.length >= currentTargetText.length
        ? input.text
        : currentTargetText;
    case 'append':
      return appendMonotonicText(currentTargetText, input.text);
    default:
      return currentTargetText;
  }
}

function upsertAssistantOverlay(
  state: RuntimeStateLike,
  input: {
    runId: string;
    text: string;
    textMode: RuntimeStreamDeltaQueuedAction['textMode'];
    messageId?: string | null;
    message?: RawMessage | null;
    status: StreamRuntimeStatus;
  },
) {
  const currentOverlay = (
    state.assistantOverlay
    && state.assistantOverlay.runId === input.runId
  )
    ? state.assistantOverlay
    : null;
  const resolvedMessageId = resolveOverlayMessageId(
    input.runId,
    input.messageId,
    currentOverlay?.messageId ?? null,
  );
  const targetText = resolveNextOverlayTargetText(currentOverlay, input);
  if (!currentOverlay && targetText.length === 0) {
    return null;
  }
  const committedText = currentOverlay
    ? currentOverlay.committedText.slice(0, targetText.length)
    : '';
  const sourceMessage = resolveOverlaySourceMessage({
    previousMessage: currentOverlay?.sourceMessage ?? null,
    incomingMessage: input.message ?? null,
    messageId: resolvedMessageId,
    targetText,
    lastUserMessageAt: state.lastUserMessageAt,
  });

  return createAssistantOverlay({
    runId: input.runId,
    messageId: resolvedMessageId,
    sourceMessage,
    committedText,
    targetText,
    status: input.status,
    rafId: currentOverlay?.rafId ?? null,
  });
}

export function reduceRuntimeOverlay(
  state: RuntimeStateLike,
  action: RuntimeOverlayAction,
): Partial<ChatSessionRuntimeState> | RuntimeStateLike {
  switch (action.type) {
    case 'run_started': {
      const normalizedRunId = normalizeRunId(action.runId);
      if (!normalizedRunId || state.sending) {
        return state;
      }
      return {
        sending: true,
        activeRunId: normalizedRunId,
        runPhase: 'submitted',
      };
    }

    case 'send_submitted': {
      return {
        sending: true,
        runPhase: 'submitted',
        pendingUserMessage: action.pendingUserMessage,
        assistantOverlay: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: action.nowMs,
        approvalStatus: 'idle',
      };
    }

    case 'send_run_bound': {
      const normalizedRunId = normalizeRunId(action.runId);
      if (!normalizedRunId || state.activeRunId === normalizedRunId) {
        return state;
      }
      return {
        activeRunId: normalizedRunId,
        runPhase: 'submitted',
      };
    }

    case 'send_waiting_approval': {
      return {
        sending: true,
        pendingFinal: true,
        runPhase: 'waiting_tool',
        approvalStatus: 'awaiting_approval',
      };
    }

    case 'send_failed': {
      return {
        sending: false,
        runPhase: 'error',
        pendingUserMessage: null,
        assistantOverlay: action.clearRun ? null : state.assistantOverlay,
        approvalStatus: action.approvalStatus ?? 'idle',
        ...(action.clearRun
          ? {
              activeRunId: null,
              lastUserMessageAt: null,
              streamingTools: [],
              pendingFinal: false,
            }
          : {}),
      };
    }

    case 'pending_approvals_synced': {
      const hasCurrentPending = action.currentPendingCount > 0;
      return {
        approvalStatus: hasCurrentPending ? 'awaiting_approval' : 'idle',
        sending: hasCurrentPending ? true : state.sending,
        pendingFinal: hasCurrentPending ? true : state.pendingFinal,
        runPhase: hasCurrentPending ? 'waiting_tool' : state.runPhase,
        activeRunId: action.nextActiveRunId,
      };
    }

    case 'approval_requested': {
      if (!action.isCurrentSession) {
        return {};
      }
      return {
        approvalStatus: 'awaiting_approval',
        sending: true,
        pendingFinal: true,
        runPhase: 'waiting_tool',
        assistantOverlay: null,
        streamingTools: [],
        activeRunId: action.runId
          ? (state.activeRunId ?? action.runId)
          : state.activeRunId,
      };
    }

    case 'approval_resolved': {
      if (action.abortedCurrentByDeny) {
        return {
          approvalStatus: action.stillPendingCurrent ? 'awaiting_approval' : 'idle',
          pendingFinal: false,
          sending: false,
          activeRunId: null,
          runPhase: 'aborted',
        };
      }
      return {
        approvalStatus: action.stillPendingCurrent ? 'awaiting_approval' : 'idle',
        runPhase: action.stillPendingCurrent ? 'waiting_tool' : state.runPhase,
      };
    }

    case 'history_snapshot': {
      if (hasActiveStreamingRun(state)) {
        return state;
      }

      const patch: Partial<ChatSessionRuntimeState> = {};
      let changed = false;

      if (action.hasRecentAssistantActivity && state.sending && !state.pendingFinal) {
        patch.pendingFinal = true;
        patch.runPhase = 'waiting_tool';
        changed = true;
      }

      if (action.hasRecentFinalAssistantMessage && (
        state.sending
        || state.activeRunId != null
        || state.pendingFinal
        || state.pendingUserMessage != null
      )) {
        patch.sending = false;
        patch.activeRunId = null;
        patch.pendingFinal = false;
        patch.runPhase = 'done';
        patch.assistantOverlay = null;
        patch.pendingUserMessage = null;
        changed = true;
      }

      return changed ? patch : state;
    }

    case 'clear_error': {
      return (state.runPhase === 'error' && !state.sending && !state.pendingFinal)
        ? { runPhase: 'idle' }
        : state;
    }

    case 'session_runtime_restored': {
      const waitingApproval = action.currentPendingApprovals > 0;
      return {
        sending: action.targetRuntime.sending,
        pendingUserMessage: action.targetRuntime.pendingUserMessage ?? null,
        assistantOverlay: action.targetRuntime.assistantOverlay,
        streamingTools: action.targetRuntime.streamingTools,
        activeRunId: action.targetRuntime.activeRunId,
        runPhase: waitingApproval ? 'waiting_tool' : action.targetRuntime.runPhase,
        pendingFinal: action.targetRuntime.pendingFinal,
        lastUserMessageAt: action.targetRuntime.lastUserMessageAt,
        pendingToolImages: action.targetRuntime.pendingToolImages,
        approvalStatus: waitingApproval ? 'awaiting_approval' : action.targetRuntime.approvalStatus,
      };
    }

    case 'tool_result_committed': {
      return {
        assistantOverlay: null,
        pendingFinal: true,
        runPhase: 'waiting_tool',
        pendingToolImages: action.pendingToolImages,
        streamingTools: action.streamingTools,
      };
    }

    case 'delta_received': {
      if (state.runPhase === 'streaming') {
        return state;
      }
      return {
        runPhase: 'streaming',
      };
    }

    case 'stream_delta_queued': {
      const deltaPatch = reduceRuntimeOverlay(state, { type: 'delta_received' });
      const updates = action.updates ?? [];
      const nextStreamingTools = updates.length > 0
        ? upsertToolStatuses(state.streamingTools, updates)
        : state.streamingTools;
      const normalizedRunId = normalizeRunId(action.runId);
      const nextOverlay = upsertAssistantOverlay(state, {
        runId: normalizedRunId || (state.activeRunId ?? ''),
        text: action.text,
        textMode: action.textMode,
        messageId: action.messageId,
        message: action.message,
        status: 'streaming',
      });
      const changedOverlay = state.assistantOverlay !== nextOverlay;
      const changedTools = nextStreamingTools !== state.streamingTools;
      if (deltaPatch === state && !changedOverlay && !changedTools) {
        return state;
      }
      return {
        ...(deltaPatch === state ? {} : deltaPatch),
        ...(changedOverlay ? { assistantOverlay: nextOverlay } : {}),
        ...(changedTools ? { streamingTools: nextStreamingTools } : {}),
      };
    }

    case 'stream_view_advanced': {
      if (!state.assistantOverlay) {
        return state;
      }
      if (
        state.assistantOverlay.committedText === action.committedText
        && state.assistantOverlay.status === action.status
        && state.assistantOverlay.rafId === action.rafId
      ) {
        return state;
      }
      return {
        assistantOverlay: {
          ...state.assistantOverlay,
          committedText: action.committedText,
          status: action.status,
          rafId: action.rafId,
        },
      };
    }

    case 'stream_scheduler_updated': {
      if (!state.assistantOverlay || state.assistantOverlay.rafId === action.rafId) {
        return state;
      }
      return {
        assistantOverlay: {
          ...state.assistantOverlay,
          rafId: action.rafId,
        },
      };
    }

    case 'event_error_cleared': {
      return state;
    }

    case 'final_history_refresh_requested': {
      if (action.hasPendingApprovals || state.approvalStatus === 'idle') {
        return state;
      }
      return {
        approvalStatus: 'idle',
      };
    }

    case 'run_aborted': {
      return {
        sending: false,
        activeRunId: null,
        runPhase: 'aborted',
        pendingUserMessage: null,
        assistantOverlay: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        approvalStatus: 'idle',
      };
    }

    case 'event_error': {
      return {
        runPhase: 'error',
        pendingUserMessage: null,
        assistantOverlay: null,
        streamingTools: [],
        pendingFinal: false,
        pendingToolImages: [],
        approvalStatus: 'idle',
      };
    }

    case 'error_recovery_timeout': {
      return {
        sending: false,
        activeRunId: null,
        runPhase: 'error',
        pendingUserMessage: null,
        lastUserMessageAt: null,
      };
    }

    case 'final_without_message': {
      if (action.completedSignal) {
        return {
          sending: false,
          activeRunId: null,
          runPhase: 'done',
          assistantOverlay: null,
          pendingFinal: false,
        };
      }
      return {
        runPhase: 'finalizing',
        ...(state.assistantOverlay
          ? {
              assistantOverlay: {
                ...state.assistantOverlay,
                status: 'finalizing' as const,
              },
            }
          : {}),
        pendingFinal: true,
        sending: state.sending,
        activeRunId: state.activeRunId,
      };
    }

    case 'final_message_committed': {
      const patch: Partial<ChatSessionRuntimeState> = {
        assistantOverlay: null,
        streamingTools: action.streamingTools,
        pendingToolImages: [],
      };

      if (action.toolOnly) {
        patch.pendingFinal = true;
        patch.runPhase = 'waiting_tool';
        return patch;
      }

      patch.sending = action.hasOutput ? false : state.sending;
      patch.activeRunId = action.hasOutput ? null : state.activeRunId;
      patch.pendingFinal = action.hasOutput ? false : true;
      patch.runPhase = action.hasOutput ? 'done' : 'finalizing';
      if (action.hasOutput) {
        patch.pendingUserMessage = null;
      }
      return patch;
    }

    default: {
      return state;
    }
  }
}

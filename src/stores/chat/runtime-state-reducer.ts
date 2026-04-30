import type {
  ApprovalStatus,
  AttachedFileMeta,
  ChatSessionRuntimeState,
  PendingUserMessageOverlay,
  ToolStatus,
} from './types';
import { upsertToolStatuses } from './event-helpers';
import { hasActiveStreamingRun } from './runtime-stream-state';

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
  messageId: string;
  updates?: ToolStatus[];
}

interface RuntimeEventErrorClearedAction {
  type: 'event_error_cleared';
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

export type RuntimeStateAction =
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
  | RuntimeEventErrorClearedAction
  | RuntimeRunAbortedAction
  | RuntimeEventErrorAction
  | RuntimeErrorRecoveryTimeoutAction
  | RuntimeFinalWithoutMessageAction
  | RuntimeFinalMessageCommittedAction;

function normalizeRunId(runId: string | null | undefined): string {
  return typeof runId === 'string' ? runId.trim() : '';
}

export function reduceSessionRuntime(
  state: RuntimeStateLike,
  action: RuntimeStateAction,
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
        streamingMessageId: null,
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
        streamingMessageId: action.clearRun ? null : state.streamingMessageId,
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
        streamingMessageId: null,
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
      const patch: Partial<ChatSessionRuntimeState> = {};
      let changed = false;

      if (action.hasRecentFinalAssistantMessage && (
        state.sending
        || state.activeRunId != null
        || state.pendingFinal
        || state.pendingUserMessage != null
        || state.streamingMessageId != null
      )) {
        patch.sending = false;
        patch.activeRunId = null;
        patch.pendingFinal = false;
        patch.runPhase = 'done';
        patch.streamingMessageId = null;
        patch.pendingUserMessage = null;
        changed = true;
      }

      if (changed) {
        return patch;
      }

      if (hasActiveStreamingRun(state)) {
        return state;
      }

      if (action.hasRecentAssistantActivity && state.sending && !state.pendingFinal) {
        patch.pendingFinal = true;
        patch.runPhase = 'waiting_tool';
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
        streamingMessageId: action.targetRuntime.streamingMessageId,
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
        streamingMessageId: null,
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
      const deltaPatch = reduceSessionRuntime(state, { type: 'delta_received' });
      const updates = action.updates ?? [];
      const nextStreamingTools = updates.length > 0
        ? upsertToolStatuses(state.streamingTools, updates)
        : state.streamingTools;
      const normalizedRunId = normalizeRunId(action.runId);
      const nextStreamingMessageId = action.messageId.trim() || state.streamingMessageId;
      const changedMessageId = nextStreamingMessageId !== state.streamingMessageId;
      const changedTools = nextStreamingTools !== state.streamingTools;
      const changedRun = normalizedRunId && normalizedRunId !== state.activeRunId;
      if (deltaPatch === state && !changedMessageId && !changedTools && !changedRun) {
        return state;
      }
      return {
        ...(deltaPatch === state ? {} : deltaPatch),
        ...(changedMessageId ? { streamingMessageId: nextStreamingMessageId } : {}),
        ...(changedTools ? { streamingTools: nextStreamingTools } : {}),
        ...(changedRun ? { activeRunId: normalizedRunId } : {}),
      };
    }

    case 'event_error_cleared': {
      return state;
    }

    case 'run_aborted': {
      return {
        sending: false,
        activeRunId: null,
        runPhase: 'aborted',
        pendingUserMessage: null,
        streamingMessageId: null,
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
        streamingMessageId: null,
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
          pendingFinal: false,
        };
      }
      return {
        runPhase: 'finalizing',
        pendingFinal: true,
        sending: state.sending,
        activeRunId: state.activeRunId,
      };
    }

    case 'final_message_committed': {
      const patch: Partial<ChatSessionRuntimeState> = {
        streamingMessageId: null,
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

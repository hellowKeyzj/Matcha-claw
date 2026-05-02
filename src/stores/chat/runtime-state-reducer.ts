import type {
  ChatSessionRuntimeState,
} from './types';
import { hasActiveStreamingRun } from './runtime-stream-state';

type RuntimeStateLike = ChatSessionRuntimeState;

interface RuntimeRunStartedAction {
  type: 'run_started';
  runId?: string | null;
}

interface RuntimeSendSubmittedAction {
  type: 'send_submitted';
  nowMs: number;
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
}

interface RuntimeDeltaReceivedAction {
  type: 'delta_received';
}

interface RuntimeStreamDeltaQueuedAction {
  type: 'stream_delta_queued';
  runId: string;
  messageId: string;
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
        streamingMessageId: null,
        pendingFinal: false,
        lastUserMessageAt: action.nowMs,
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
      };
    }

    case 'send_failed': {
      return {
        sending: false,
        runPhase: 'error',
        streamingMessageId: action.clearRun ? null : state.streamingMessageId,
        ...(action.clearRun
          ? {
              activeRunId: null,
              lastUserMessageAt: null,
              pendingFinal: false,
            }
          : {}),
      };
    }

    case 'pending_approvals_synced': {
      const hasCurrentPending = action.currentPendingCount > 0;
      return {
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
        sending: true,
        pendingFinal: true,
        runPhase: 'waiting_tool',
        streamingMessageId: null,
        activeRunId: action.runId
          ? (state.activeRunId ?? action.runId)
          : state.activeRunId,
      };
    }

    case 'approval_resolved': {
      if (action.abortedCurrentByDeny) {
        return {
          pendingFinal: false,
          sending: false,
          activeRunId: null,
          runPhase: 'aborted',
        };
      }
      return {
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
      )) {
        patch.sending = false;
        patch.activeRunId = null;
        patch.pendingFinal = false;
        patch.runPhase = 'done';
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
        streamingMessageId: action.targetRuntime.streamingMessageId,
        activeRunId: action.targetRuntime.activeRunId,
        runPhase: waitingApproval ? 'waiting_tool' : action.targetRuntime.runPhase,
        pendingFinal: action.targetRuntime.pendingFinal,
        lastUserMessageAt: action.targetRuntime.lastUserMessageAt,
      };
    }

    case 'tool_result_committed': {
      return {
        streamingMessageId: null,
        pendingFinal: true,
        runPhase: 'waiting_tool',
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
      const normalizedRunId = normalizeRunId(action.runId);
      const nextStreamingMessageId = action.messageId.trim() || state.streamingMessageId;
      const changedMessageId = nextStreamingMessageId !== state.streamingMessageId;
      const changedRun = normalizedRunId && normalizedRunId !== state.activeRunId;
      if (deltaPatch === state && !changedMessageId && !changedRun) {
        return state;
      }
      return {
        ...(deltaPatch === state ? {} : deltaPatch),
        ...(changedMessageId ? { streamingMessageId: nextStreamingMessageId } : {}),
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
        streamingMessageId: null,
        pendingFinal: false,
        lastUserMessageAt: null,
      };
    }

    case 'event_error': {
        return {
          runPhase: 'error',
          streamingMessageId: null,
        pendingFinal: false,
      };
    }

    case 'error_recovery_timeout': {
      return {
        sending: false,
        activeRunId: null,
        runPhase: 'error',
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
      return patch;
    }

    default: {
      return state;
    }
  }
}

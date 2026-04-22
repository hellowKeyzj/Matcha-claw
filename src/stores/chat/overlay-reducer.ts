import type {
  ActiveStreamRuntime,
  ApprovalStatus,
  AttachedFileMeta,
  ChatStoreState,
  RawMessage,
  SessionRuntimeSnapshot,
  StreamRuntimeStatus,
  ToolStatus,
} from './types';
import {
  upsertToolStatuses,
} from './event-helpers';

type RuntimeStateLike = ChatStoreState;

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
  targetRuntime: SessionRuntimeSnapshot;
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
  sessionKey: string;
  runId: string;
  text: string;
  updates?: ToolStatus[];
}

interface RuntimeStreamViewAdvancedAction {
  type: 'stream_view_advanced';
  message: RawMessage | null;
  displayedChars: number;
  status: StreamRuntimeStatus;
  rafId: number | null;
}

interface RuntimeStreamFinalQueuedAction {
  type: 'stream_final_queued';
  sessionKey: string;
  runId: string;
  text: string;
  updates?: ToolStatus[];
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
  messages?: RawMessage[];
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
  | RuntimeStreamFinalQueuedAction
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

function createStreamRuntime(sessionKey: string, runId: string): ActiveStreamRuntime {
  return {
    sessionKey,
    runId,
    chunks: [],
    rawChars: 0,
    displayedChars: 0,
    status: 'streaming',
    rafId: null,
  };
}

function joinChunks(chunks: string[]): string {
  if (chunks.length === 0) {
    return '';
  }
  if (chunks.length === 1) {
    return chunks[0] ?? '';
  }
  return chunks.join('');
}

function appendStreamText(runtime: ActiveStreamRuntime, nextText: string): ActiveStreamRuntime {
  const currentText = joinChunks(runtime.chunks);
  if (!nextText) {
    return runtime;
  }
  if (nextText === currentText) {
    return runtime;
  }
  if (nextText.startsWith(currentText)) {
    const suffix = nextText.slice(currentText.length);
    if (!suffix) {
      return runtime;
    }
    return {
      ...runtime,
      chunks: [...runtime.chunks, suffix],
      rawChars: nextText.length,
    };
  }
  return {
    ...runtime,
    chunks: [nextText],
    rawChars: nextText.length,
    displayedChars: Math.min(runtime.displayedChars, nextText.length),
  };
}

export function reduceRuntimeOverlay(
  state: RuntimeStateLike,
  action: RuntimeOverlayAction,
): Partial<ChatStoreState> | RuntimeStateLike {
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
        error: null,
      };
    }

    case 'send_submitted': {
      return {
        sending: true,
        runPhase: 'submitted',
        error: null,
        streamingMessage: null,
        streamRuntime: null,
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
        error: null,
        sending: true,
        pendingFinal: true,
        runPhase: 'waiting_tool',
        approvalStatus: 'awaiting_approval',
      };
    }

    case 'send_failed': {
      return {
        error: action.error,
        sending: false,
        runPhase: 'error',
        streamRuntime: action.clearRun ? null : state.streamRuntime,
        approvalStatus: action.approvalStatus ?? 'idle',
        ...(action.clearRun
          ? {
            activeRunId: null,
            streamingMessage: null,
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
        // Entering approval wait should clear stream placeholders so UI renders approval actions immediately.
        streamingMessage: null,
        streamRuntime: null,
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
      const patch: Partial<ChatStoreState> = {};
      let changed = false;

      if (action.hasRecentAssistantActivity && state.sending && !state.pendingFinal) {
        patch.pendingFinal = true;
        patch.runPhase = 'waiting_tool';
        changed = true;
      }

      if (action.hasRecentFinalAssistantMessage && (state.sending || state.activeRunId != null || state.pendingFinal)) {
        patch.sending = false;
        patch.activeRunId = null;
        patch.pendingFinal = false;
        patch.runPhase = 'done';
        patch.streamingMessage = null;
        patch.streamRuntime = null;
        changed = true;
      }

      return changed ? patch : state;
    }

    case 'clear_error': {
      return {
        error: null,
        ...((state.runPhase === 'error' && !state.sending && !state.pendingFinal)
          ? { runPhase: 'idle' as const }
          : {}),
      };
    }

    case 'session_runtime_restored': {
      const waitingApproval = action.currentPendingApprovals > 0;
      return {
        sending: action.targetRuntime.sending,
        streamingMessage: action.targetRuntime.streamingMessage,
        streamRuntime: action.targetRuntime.streamRuntime,
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
        streamingMessage: null,
        streamRuntime: null,
        pendingFinal: true,
        runPhase: 'waiting_tool',
        pendingToolImages: action.pendingToolImages,
        streamingTools: action.streamingTools,
      };
    }

    case 'delta_received': {
      const patch: Partial<ChatStoreState> = {};
      let changed = false;
      if (state.runPhase !== 'streaming') {
        patch.runPhase = 'streaming';
        changed = true;
      }
      if (state.error) {
        patch.error = null;
        changed = true;
      }
      return changed ? patch : state;
    }

    case 'stream_delta_queued': {
      const deltaPatch = reduceRuntimeOverlay(state, { type: 'delta_received' });
      const updates = action.updates ?? [];
      const nextStreamingTools = updates.length > 0
        ? upsertToolStatuses(state.streamingTools, updates)
        : state.streamingTools;
      const baseRuntime = (
        state.streamRuntime
        && state.streamRuntime.sessionKey === action.sessionKey
        && state.streamRuntime.runId === action.runId
      )
        ? state.streamRuntime
        : createStreamRuntime(action.sessionKey, action.runId);
      const nextRuntime = appendStreamText({
        ...baseRuntime,
        status: 'streaming',
      }, action.text);
      const changedRuntime = (
        state.streamRuntime !== nextRuntime
        && (
          state.streamRuntime == null
          || state.streamRuntime.rawChars !== nextRuntime.rawChars
          || state.streamRuntime.chunks !== nextRuntime.chunks
          || state.streamRuntime.status !== nextRuntime.status
        )
      );
      const changedTools = nextStreamingTools !== state.streamingTools;
      if (deltaPatch === state && !changedRuntime && !changedTools) {
        return state;
      }
      return {
        ...(deltaPatch === state ? {} : deltaPatch),
        ...(changedRuntime ? { streamRuntime: nextRuntime } : {}),
        ...(changedTools ? { streamingTools: nextStreamingTools } : {}),
      };
    }

    case 'stream_view_advanced': {
      if (!state.streamRuntime) {
        return state;
      }
      return {
        streamingMessage: action.message,
        streamRuntime: {
          ...state.streamRuntime,
          displayedChars: action.displayedChars,
          status: action.status,
          rafId: action.rafId,
        },
      };
    }

    case 'stream_final_queued': {
      const updates = action.updates ?? [];
      const nextStreamingTools = updates.length > 0
        ? upsertToolStatuses(state.streamingTools, updates)
        : state.streamingTools;
      const baseRuntime = (
        state.streamRuntime
        && state.streamRuntime.sessionKey === action.sessionKey
        && state.streamRuntime.runId === action.runId
      )
        ? state.streamRuntime
        : createStreamRuntime(action.sessionKey, action.runId);
      const nextRuntime = {
        ...baseRuntime,
        chunks: action.text ? [action.text] : [],
        rawChars: action.text.length,
        displayedChars: Math.min(baseRuntime.displayedChars, action.text.length),
        status: 'draining' as const,
      };
      return {
        streamRuntime: nextRuntime,
        ...(nextStreamingTools !== state.streamingTools ? { streamingTools: nextStreamingTools } : {}),
      };
    }

    case 'stream_scheduler_updated': {
      if (!state.streamRuntime || state.streamRuntime.rafId === action.rafId) {
        return state;
      }
      return {
        streamRuntime: {
          ...state.streamRuntime,
          rafId: action.rafId,
        },
      };
    }

    case 'event_error_cleared': {
      if (!state.error) {
        return state;
      }
      return { error: null };
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
        streamingMessage: null,
        streamRuntime: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        approvalStatus: 'idle',
      };
    }

    case 'event_error': {
      return {
        error: action.error,
        runPhase: 'error',
        streamingMessage: null,
        streamRuntime: null,
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
        lastUserMessageAt: null,
      };
    }

    case 'final_without_message': {
      if (action.completedSignal) {
        return {
          sending: false,
          activeRunId: null,
          runPhase: 'done',
          streamingMessage: null,
          streamRuntime: null,
          pendingFinal: false,
        };
      }
      return {
        runPhase: 'finalizing',
        ...(state.streamRuntime
          ? {
              streamRuntime: {
                ...state.streamRuntime,
                status: 'finalizing' as const,
              },
            }
          : {
              streamingMessage: null,
            }),
        pendingFinal: true,
        sending: state.sending,
        activeRunId: state.activeRunId,
      };
    }

    case 'final_message_committed': {
      const patch: Partial<ChatStoreState> = {
        streamingMessage: null,
        streamRuntime: null,
        streamingTools: action.streamingTools,
        pendingToolImages: [],
        ...(action.messages ? { messages: action.messages } : {}),
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

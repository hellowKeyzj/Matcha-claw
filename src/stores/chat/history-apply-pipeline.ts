import {
  isInternalMessage,
  resolveSessionLabelFromMessages,
} from './message-helpers';
import {
  hasPendingPreviewLoads,
  hydrateAttachedFilesFromCache,
  loadMissingPreviews,
} from './attachment-helpers';
import {
  reconcileOptimisticUserInHistory,
} from './finalize-helpers';
import { trackUiTiming } from '@/lib/telemetry';
import { isToolResultRole } from './event-helpers';
import {
  finishChatRunTelemetry,
  maybeTrackFinalToHistoryVisible,
} from './telemetry';
import { clearHistoryPoll } from './timers';
import {
  buildHistoryApplyPatch,
  buildHistoryPreviewHydrationPatch,
  resolveHistoryActivityFlags,
} from './history-apply-helpers';
import { normalizeHistoryMessages } from './history-normalizer-worker-client';
import {
  buildRenderMessagesFingerprint,
  buildQuickRawHistoryFingerprint,
  nowMs,
  toMs,
} from './store-state-helpers';
import {
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState, RawMessage } from './types';

const HISTORY_STAGE_FIRST_PAINT_THRESHOLD = 120;
const HISTORY_STAGE_FIRST_PAINT_LIMIT = 48;
const HISTORY_STAGE_FIRST_PAINT_DELAY_MS = 24;

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateApplyLoadedMessagesInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  requestedSessionKey: string;
  quiet: boolean;
  abortSignal: AbortSignal;
  shouldAbortHistoryProcessing: () => boolean;
  optimisticUserReconcileWindowMs: number;
}

export function createApplyLoadedMessagesPipeline(
  input: CreateApplyLoadedMessagesInput,
): (rawMessages: RawMessage[], thinkingLevel: string | null) => Promise<void> {
  const {
    set,
    get,
    historyRuntime,
    requestedSessionKey,
    quiet,
    abortSignal,
    shouldAbortHistoryProcessing,
    optimisticUserReconcileWindowMs,
  } = input;

  return async (rawMessages: RawMessage[], thinkingLevel: string | null) => {
    const applyStartedAt = nowMs();
    let outcome: 'applied' | 'quick_skip' | 'aborted' = 'applied';
    let stageFirstPaintTimer: ReturnType<typeof setTimeout> | null = null;
    let didStageFirstPaint = false;
    const clearStageFirstPaintTimer = () => {
      if (stageFirstPaintTimer != null) {
        clearTimeout(stageFirstPaintTimer);
        stageFirstPaintTimer = null;
      }
    };
    try {
      const quickFingerprint = buildQuickRawHistoryFingerprint(rawMessages, thinkingLevel);
      const previousQuickFingerprint = historyRuntime.historyQuickFingerprintBySession.get(requestedSessionKey) ?? null;
      const currentStateForQuickPath = get();
      const hasReadySnapshot = (
        Boolean(currentStateForQuickPath.sessionReadyByKey[requestedSessionKey])
        || currentStateForQuickPath.snapshotReady
      );
      const canSkipWithQuickFingerprint = (
        previousQuickFingerprint === quickFingerprint
        && currentStateForQuickPath.currentSessionKey === requestedSessionKey
        && (currentStateForQuickPath.messages.length > 0 || hasReadySnapshot)
        && currentStateForQuickPath.thinkingLevel === thinkingLevel
      );
      if (canSkipWithQuickFingerprint) {
        outcome = 'quick_skip';
        if (!historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)) {
          historyRuntime.historyRenderFingerprintBySession.set(
            requestedSessionKey,
            buildRenderMessagesFingerprint(currentStateForQuickPath.messages),
          );
        }
        if (!quiet && (currentStateForQuickPath.initialLoading || currentStateForQuickPath.refreshing)) {
          set((state) => {
            const alreadyReady = Boolean(state.sessionReadyByKey[requestedSessionKey]);
            if (alreadyReady) {
              return { initialLoading: false, refreshing: false, snapshotReady: true };
            }
            return {
              initialLoading: false,
              refreshing: false,
              snapshotReady: true,
              sessionReadyByKey: {
                ...state.sessionReadyByKey,
                [requestedSessionKey]: true,
              },
            };
          });
        } else if (!currentStateForQuickPath.sessionReadyByKey[requestedSessionKey]) {
          set((state) => ({
            sessionReadyByKey: {
              ...state.sessionReadyByKey,
              [requestedSessionKey]: true,
            },
          }));
        }
        return;
      }
      historyRuntime.historyQuickFingerprintBySession.set(requestedSessionKey, quickFingerprint);

      if (shouldAbortHistoryProcessing()) {
        outcome = 'aborted';
        return;
      }
      throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);

      const stageFirstPaintIfNeeded = () => {
        if (didStageFirstPaint) {
          return;
        }
        if (abortSignal.aborted || shouldAbortHistoryProcessing()) {
          return;
        }
        if (get().currentSessionKey !== requestedSessionKey) {
          return;
        }
        const provisionalTail: RawMessage[] = [];
        for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
          const current = rawMessages[index];
          if (isToolResultRole(current.role) || isInternalMessage(current)) {
            continue;
          }
          provisionalTail.push(current);
          if (provisionalTail.length >= HISTORY_STAGE_FIRST_PAINT_LIMIT) {
            break;
          }
        }
        provisionalTail.reverse();
        if (provisionalTail.length === 0) {
          return;
        }
        didStageFirstPaint = true;
        const provisionalLastMsg = provisionalTail[provisionalTail.length - 1];
        const provisionalLastAt = provisionalLastMsg?.timestamp ? toMs(provisionalLastMsg.timestamp) : null;
        const provisionalLabel = requestedSessionKey.endsWith(':main')
          ? ''
          : resolveSessionLabelFromMessages(provisionalTail);
        set((state) => {
          if (state.currentSessionKey !== requestedSessionKey) {
            return state;
          }
          if (state.messages.length > 0) {
            return state;
          }
          return {
            messages: provisionalTail,
            snapshotReady: true,
            initialLoading: false,
            refreshing: false,
            thinkingLevel,
            ...(provisionalLabel && state.sessionLabels[requestedSessionKey] !== provisionalLabel
              ? {
                  sessionLabels: {
                    ...state.sessionLabels,
                    [requestedSessionKey]: provisionalLabel,
                  },
                }
              : {}),
            ...(provisionalLastAt != null && state.sessionLastActivity[requestedSessionKey] !== provisionalLastAt
              ? {
                  sessionLastActivity: {
                    ...state.sessionLastActivity,
                    [requestedSessionKey]: provisionalLastAt,
                  },
                }
              : {}),
            sessionReadyByKey: state.sessionReadyByKey[requestedSessionKey]
              ? state.sessionReadyByKey
              : {
                  ...state.sessionReadyByKey,
                  [requestedSessionKey]: true,
                },
          };
        });
      };
      const shouldStageFirstPaint = (
        !quiet
        &&
        get().messages.length === 0
        && rawMessages.length > HISTORY_STAGE_FIRST_PAINT_THRESHOLD
      );
      if (shouldStageFirstPaint) {
        stageFirstPaintTimer = setTimeout(() => {
          stageFirstPaintTimer = null;
          stageFirstPaintIfNeeded();
        }, HISTORY_STAGE_FIRST_PAINT_DELAY_MS);
      }

      const normalizeStartedAt = nowMs();
      const normalizedMessages = await normalizeHistoryMessages(rawMessages, { abortSignal });
      clearStageFirstPaintTimer();
      trackUiTiming('chat.history_apply_normalize', Math.max(0, nowMs() - normalizeStartedAt), {
        sessionKey: requestedSessionKey,
        quiet,
        rows: rawMessages.length,
      });
      if (shouldAbortHistoryProcessing()) {
        outcome = 'aborted';
        return;
      }
      throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);
      const enrichedMessages = hydrateAttachedFilesFromCache(normalizedMessages);
      if (shouldAbortHistoryProcessing()) {
        outcome = 'aborted';
        return;
      }
      throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);

      let finalMessages = enrichedMessages;
      const runtimeState = get();
      const userMsgAt = runtimeState.lastUserMessageAt;
      if (runtimeState.sending && userMsgAt) {
        finalMessages = reconcileOptimisticUserInHistory({
          historyMessages: enrichedMessages,
          currentMessages: runtimeState.messages,
          lastUserMessageAt: userMsgAt,
          windowMs: optimisticUserReconcileWindowMs,
        });
      }
      if (shouldAbortHistoryProcessing()) {
        outcome = 'aborted';
        return;
      }
      throwIfHistoryLoadAborted(abortSignal, shouldAbortHistoryProcessing);

      const isMainSession = requestedSessionKey.endsWith(':main');
      const resolvedLabel = !isMainSession
        ? resolveSessionLabelFromMessages(finalMessages)
        : '';
      const lastMsg = finalMessages[finalMessages.length - 1];
      const lastAt = lastMsg?.timestamp ? toMs(lastMsg.timestamp) : null;
      const renderFingerprint = buildRenderMessagesFingerprint(finalMessages);
      const previousRenderFingerprint = historyRuntime.historyRenderFingerprintBySession.get(requestedSessionKey) ?? null;

      const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();
      const historyActivityFlags = resolveHistoryActivityFlags({
        normalizedMessages,
        isSendingNow,
        pendingFinal,
        lastUserMessageAt,
      });

      const patchStartedAt = nowMs();
      let didMessageListChange = false;
      set((state) => {
        const applyPatchResult = buildHistoryApplyPatch(state, {
          requestedSessionKey,
          finalMessages,
          thinkingLevel,
          resolvedLabel,
          lastAt,
          previousRenderFingerprint,
          renderFingerprint,
          flags: historyActivityFlags,
        });
        didMessageListChange = applyPatchResult.didMessageListChange;
        return applyPatchResult.patch ?? state;
      });
      trackUiTiming('chat.history_apply_patch', Math.max(0, nowMs() - patchStartedAt), {
        sessionKey: requestedSessionKey,
        quiet,
        rows: finalMessages.length,
        changed: didMessageListChange,
      });
      historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);

      if (historyActivityFlags.hasRecentFinalAssistantMessage) {
        maybeTrackFinalToHistoryVisible(requestedSessionKey, {
          rowCount: finalMessages.length,
          changed: didMessageListChange,
        });
        finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
        clearHistoryPoll();
      }

      if (didMessageListChange && hasPendingPreviewLoads(finalMessages)) {
        void loadMissingPreviews(finalMessages).then((updated) => {
          if (!updated) {
            return;
          }
          if (abortSignal.aborted || shouldAbortHistoryProcessing()) {
            return;
          }
          set((state) => {
            return buildHistoryPreviewHydrationPatch(
              state,
              requestedSessionKey,
              finalMessages,
            );
          });
        });
      }
    } catch (error) {
      clearStageFirstPaintTimer();
      if (isHistoryLoadAbortError(error)) {
        outcome = 'aborted';
      }
      throw error;
    } finally {
      clearStageFirstPaintTimer();
      trackUiTiming('chat.history_apply_total', Math.max(0, nowMs() - applyStartedAt), {
        sessionKey: requestedSessionKey,
        quiet,
        outcome,
        rawRows: rawMessages.length,
      });
    }
  };
}




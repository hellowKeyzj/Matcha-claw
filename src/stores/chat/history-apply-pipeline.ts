import {
  resolveSessionLabelFromMessages,
} from './message-helpers';
import { prewarmAssistantMarkdownBodies } from '@/lib/chat-markdown-body';
import { EMPTY_EXECUTION_GRAPHS } from '@/pages/Chat/exec-graph-types';
import { prewarmStaticRowsForMessages } from '@/pages/Chat/chat-rows-cache';
import {
  hasPendingPreviewLoads,
  hydrateAttachedFilesFromCache,
  loadMissingPreviews,
} from './attachment-helpers';
import {
  reconcileCommittedCurrentTurnWithHistory,
  reconcileLatestAssistantInHistory,
  reconcilePendingUserWithHistory,
} from './finalize-helpers';
import { trackUiTiming } from '@/lib/telemetry';
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
  getSessionRuntime,
  getSessionTranscript,
  nowMs,
  patchSessionMeta,
  toMs,
} from './store-state-helpers';
import {
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadMode,
  ChatHistoryLoadScope,
  ChatStoreState,
  RawMessage,
} from './types';
import { projectLiveThreadMessages } from '@/pages/Chat/live-thread-projection';

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
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  abortSignal: AbortSignal;
  shouldAbortHistoryProcessing: () => boolean;
  optimisticUserReconcileWindowMs?: number;
}

export function createApplyLoadedMessagesPipeline(
  input: CreateApplyLoadedMessagesInput,
): (rawMessages: RawMessage[], thinkingLevel: string | null) => Promise<void> {
  const {
    set,
    get,
    historyRuntime,
    requestedSessionKey,
    mode,
    scope,
    abortSignal,
    shouldAbortHistoryProcessing,
  } = input;
  const isForeground = scope === 'foreground';

  return async (rawMessages: RawMessage[], thinkingLevel: string | null) => {
    const applyStartedAt = nowMs();
    let outcome: 'applied' | 'quick_skip' | 'aborted' = 'applied';
    try {
      const quickFingerprint = buildQuickRawHistoryFingerprint(rawMessages, thinkingLevel);
      const previousQuickFingerprint = historyRuntime.historyQuickFingerprintBySession.get(requestedSessionKey) ?? null;
      const currentStateForQuickPath = get();
      const currentTranscript = getSessionTranscript(currentStateForQuickPath, requestedSessionKey);
      const currentMeta = currentStateForQuickPath.sessionsByKey[requestedSessionKey]?.meta;
      const hasReadySnapshot = Boolean(currentMeta?.ready)
        || (currentStateForQuickPath.currentSessionKey === requestedSessionKey && currentStateForQuickPath.snapshotReady);
      const canSkipWithQuickFingerprint = (
        previousQuickFingerprint === quickFingerprint
        && (currentTranscript.length > 0 || hasReadySnapshot)
        && (currentMeta?.thinkingLevel ?? null) === thinkingLevel
      );
      if (canSkipWithQuickFingerprint) {
        outcome = 'quick_skip';
        if (!historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)) {
          historyRuntime.historyRenderFingerprintBySession.set(
            requestedSessionKey,
            buildRenderMessagesFingerprint(currentTranscript),
          );
        }
        if (isForeground && (currentStateForQuickPath.initialLoading || currentStateForQuickPath.refreshing)) {
          set((state) => {
            if (state.sessionsByKey[requestedSessionKey]?.meta.ready) {
              return { initialLoading: false, refreshing: false, snapshotReady: true };
            }
            return {
              initialLoading: false,
              refreshing: false,
              snapshotReady: true,
              sessionsByKey: patchSessionMeta(state, requestedSessionKey, { ready: true }),
            };
          });
        } else if (!currentMeta?.ready) {
          set((state) => ({
            sessionsByKey: patchSessionMeta(state, requestedSessionKey, { ready: true }),
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

      const normalizeStartedAt = nowMs();
      const normalizedMessages = await normalizeHistoryMessages(rawMessages, { abortSignal });
      trackUiTiming('chat.history_apply_normalize', Math.max(0, nowMs() - normalizeStartedAt), {
        sessionKey: requestedSessionKey,
        mode,
        scope,
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
      let nextPendingUserMessage = null;
      const runtimeState = get();
      const currentRuntime = getSessionRuntime(runtimeState, requestedSessionKey);
      if (runtimeState.currentSessionKey === requestedSessionKey) {
        const pendingUserReconcile = reconcilePendingUserWithHistory({
          historyMessages: enrichedMessages,
          pendingUserMessage: currentRuntime.pendingUserMessage ?? null,
        });
        finalMessages = pendingUserReconcile.historyMessages;
        nextPendingUserMessage = pendingUserReconcile.pendingUserMessage;
      }
      if (runtimeState.currentSessionKey === requestedSessionKey) {
        finalMessages = reconcileLatestAssistantInHistory({
          historyMessages: finalMessages,
          currentMessages: getSessionTranscript(runtimeState, requestedSessionKey),
        });
      }
      if (runtimeState.currentSessionKey === requestedSessionKey) {
        finalMessages = reconcileCommittedCurrentTurnWithHistory({
          historyMessages: finalMessages,
          currentMessages: getSessionTranscript(runtimeState, requestedSessionKey),
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

      const activityRuntimeState = get();
      const activityRuntime = getSessionRuntime(activityRuntimeState, requestedSessionKey);
      const shouldResolveHistoryActivity = (
        isForeground
        && activityRuntimeState.currentSessionKey === requestedSessionKey
      );
      const historyActivityFlags = shouldResolveHistoryActivity
        ? resolveHistoryActivityFlags({
            normalizedMessages,
            isSendingNow: activityRuntime.sending,
            pendingFinal: activityRuntime.pendingFinal,
            lastUserMessageAt: activityRuntime.lastUserMessageAt,
          })
        : {
            hasRecentAssistantActivity: false,
            hasRecentFinalAssistantMessage: false,
          };

      const patchStartedAt = nowMs();
      let didMessageListChange = false;
      set((state) => {
        const applyPatchResult = buildHistoryApplyPatch(state, {
          requestedSessionKey,
          scope,
          finalMessages,
          thinkingLevel,
          resolvedLabel,
          lastAt,
          previousRenderFingerprint,
          renderFingerprint,
          pendingUserMessage: nextPendingUserMessage,
          flags: historyActivityFlags,
        });
        didMessageListChange = applyPatchResult.didMessageListChange;
        return applyPatchResult.patch ?? state;
      });
      trackUiTiming('chat.history_apply_patch', Math.max(0, nowMs() - patchStartedAt), {
        sessionKey: requestedSessionKey,
        mode,
        scope,
        rows: finalMessages.length,
        changed: didMessageListChange,
      });
      historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);
      const liveMessages = projectLiveThreadMessages(finalMessages).messages;
      prewarmAssistantMarkdownBodies(liveMessages, 'settled');
      prewarmStaticRowsForMessages(requestedSessionKey, liveMessages, EMPTY_EXECUTION_GRAPHS);

      if (isForeground && historyActivityFlags.hasRecentFinalAssistantMessage) {
        maybeTrackFinalToHistoryVisible(requestedSessionKey, {
          rowCount: finalMessages.length,
          changed: didMessageListChange,
        });
        finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
        clearHistoryPoll();
      }

      if ((didMessageListChange || scope === 'background') && hasPendingPreviewLoads(finalMessages)) {
        void loadMissingPreviews(finalMessages).then((updated) => {
          if (!updated) {
            return;
          }
          if (abortSignal.aborted || shouldAbortHistoryProcessing()) {
            return;
          }
          set((state) => buildHistoryPreviewHydrationPatch(
            state,
            requestedSessionKey,
            finalMessages,
          ));
        });
      }
    } catch (error) {
      if (isHistoryLoadAbortError(error)) {
        outcome = 'aborted';
      }
      throw error;
    } finally {
      trackUiTiming('chat.history_apply_total', Math.max(0, nowMs() - applyStartedAt), {
        sessionKey: requestedSessionKey,
        mode,
        scope,
        outcome,
        rawRows: rawMessages.length,
      });
    }
  };
}

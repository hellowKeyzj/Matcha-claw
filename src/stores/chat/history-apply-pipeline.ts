import {
  resolveSessionLabelFromMessages,
  normalizeAssistantFinalTextForDedup,
} from './message-helpers';
import { prewarmAssistantMarkdownBodies } from '@/lib/chat-markdown-body';
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
  getSessionMessages,
  getSessionRuntime,
  getSessionViewportState,
  isSessionHistoryReady,
  nowMs,
  patchSessionMeta,
  toMs,
} from './store-state-helpers';
import {
  isHistoryLoadAbortError,
  throwIfHistoryLoadAborted,
} from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type { HistoryWindowResult } from './history-fetch-helpers';
import type {
  ChatHistoryLoadMode,
  ChatHistoryLoadScope,
  ChatStoreState,
  RawMessage,
} from './types';
import {
  findCurrentStreamingMessage,
  upsertMessageById,
} from './streaming-message';

function reconcileStreamingMessageWithHistory(input: {
  historyMessages: RawMessage[];
  currentMessages: RawMessage[];
  streamingMessageId: string | null;
  keepLocalStreamingMessage: boolean;
}): RawMessage[] {
  const {
    historyMessages,
    currentMessages,
    streamingMessageId,
    keepLocalStreamingMessage,
  } = input;
  const currentStreamingMessage = findCurrentStreamingMessage(currentMessages, streamingMessageId);
  if (!currentStreamingMessage) {
    return historyMessages;
  }

  const currentStreamingId = typeof currentStreamingMessage.id === 'string'
    ? currentStreamingMessage.id.trim()
    : '';
  const currentStreamingText = normalizeAssistantFinalTextForDedup(currentStreamingMessage.content);
  const matchedHistoryIndex = historyMessages.findIndex((message) => (
    message.role === 'assistant'
    && (
      (currentStreamingId && message.id === currentStreamingId)
      || (
        currentStreamingText.length > 0
        && normalizeAssistantFinalTextForDedup(message.content) === currentStreamingText
      )
    )
  ));

  if (matchedHistoryIndex >= 0) {
    const mergedMessages = [...historyMessages];
    mergedMessages[matchedHistoryIndex] = {
      ...currentStreamingMessage,
      ...historyMessages[matchedHistoryIndex],
      id: currentStreamingId || historyMessages[matchedHistoryIndex]?.id,
      streaming: false,
      _attachedFiles: historyMessages[matchedHistoryIndex]?._attachedFiles ?? currentStreamingMessage._attachedFiles,
    };
    return mergedMessages;
  }

  if (!keepLocalStreamingMessage) {
    return historyMessages;
  }

  return upsertMessageById(historyMessages, currentStreamingMessage);
}

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
}

export function createApplyLoadedMessagesPipeline(
  input: CreateApplyLoadedMessagesInput,
): {
  (window: HistoryWindowResult): Promise<void>;
  (
    rawMessages: RawMessage[],
    thinkingLevel: string | null,
    window?: Partial<HistoryWindowResult>,
  ): Promise<void>;
} {
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

  return async (
    windowOrRawMessages: HistoryWindowResult | RawMessage[],
    thinkingLevel?: string | null,
    partialWindow?: Partial<HistoryWindowResult>,
  ) => {
    const window = Array.isArray(windowOrRawMessages)
      ? {
          rawMessages: windowOrRawMessages,
          canonicalRawMessages: partialWindow?.canonicalRawMessages ?? windowOrRawMessages,
          thinkingLevel: thinkingLevel ?? null,
          totalMessageCount: partialWindow?.totalMessageCount ?? windowOrRawMessages.length,
          windowStartOffset: partialWindow?.windowStartOffset ?? 0,
          windowEndOffset: partialWindow?.windowEndOffset ?? windowOrRawMessages.length,
          hasMore: partialWindow?.hasMore ?? false,
          hasNewer: partialWindow?.hasNewer ?? false,
          isAtLatest: partialWindow?.isAtLatest ?? true,
        } satisfies HistoryWindowResult
      : windowOrRawMessages;
    const applyStartedAt = nowMs();
    const canonicalRawMessages = window.canonicalRawMessages ?? window.rawMessages;
    let outcome: 'applied' | 'quick_skip' | 'aborted' = 'applied';
    try {
      const quickFingerprint = buildQuickRawHistoryFingerprint(canonicalRawMessages, window.thinkingLevel);
      const previousQuickFingerprint = historyRuntime.historyQuickFingerprintBySession.get(requestedSessionKey) ?? null;
      const currentStateForQuickPath = get();
      const currentMessages = getSessionMessages(currentStateForQuickPath, requestedSessionKey);
      const currentMeta = currentStateForQuickPath.loadedSessions[requestedSessionKey]?.meta;
      const canSkipWithQuickFingerprint = (
        previousQuickFingerprint === quickFingerprint
        && (currentMessages.length > 0 || isSessionHistoryReady(currentMeta?.historyStatus))
        && (currentMeta?.thinkingLevel ?? null) === window.thinkingLevel
      );
      if (canSkipWithQuickFingerprint) {
        outcome = 'quick_skip';
        if (!historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)) {
          const currentViewport = getSessionViewportState(currentStateForQuickPath, requestedSessionKey);
          historyRuntime.historyRenderFingerprintBySession.set(
            requestedSessionKey,
            buildRenderMessagesFingerprint(currentViewport.messages),
          );
        }
        if (!isSessionHistoryReady(currentMeta?.historyStatus)) {
          set((state) => ({
            loadedSessions: patchSessionMeta(state, requestedSessionKey, { historyStatus: 'ready' }),
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
      const normalizedMessages = await normalizeHistoryMessages(canonicalRawMessages, { abortSignal });
      trackUiTiming('chat.history_apply_normalize', Math.max(0, nowMs() - normalizeStartedAt), {
        sessionKey: requestedSessionKey,
        mode,
        scope,
        rows: canonicalRawMessages.length,
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
          currentMessages: getSessionMessages(runtimeState, requestedSessionKey),
        });
      }
      if (runtimeState.currentSessionKey === requestedSessionKey) {
        finalMessages = reconcileCommittedCurrentTurnWithHistory({
          historyMessages: finalMessages,
          currentMessages: getSessionMessages(runtimeState, requestedSessionKey),
        });
      }
      if (runtimeState.currentSessionKey === requestedSessionKey) {
        finalMessages = reconcileStreamingMessageWithHistory({
          historyMessages: finalMessages,
          currentMessages: getSessionMessages(runtimeState, requestedSessionKey),
          streamingMessageId: currentRuntime.streamingMessageId,
          keepLocalStreamingMessage: currentRuntime.sending || currentRuntime.pendingFinal || currentRuntime.activeRunId != null,
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
      const canonicalWindowLength = Math.max(
        0,
        (window.canonicalRawMessages ?? window.rawMessages).length,
      );
      const reconciledWindowDelta = finalMessages.length - canonicalWindowLength;
      const viewportWindowStart = Math.min(Math.max(window.windowStartOffset, 0), finalMessages.length);
      const viewportWindowEnd = Math.min(
        Math.max(window.windowEndOffset + Math.max(reconciledWindowDelta, 0), viewportWindowStart),
        finalMessages.length,
      );
      const viewportMessages = finalMessages.slice(viewportWindowStart, viewportWindowEnd);
      const renderFingerprint = buildRenderMessagesFingerprint(viewportMessages);
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
          viewportMessages,
          thinkingLevel: window.thinkingLevel,
          totalMessageCount: window.totalMessageCount,
          windowStartOffset: viewportWindowStart,
          windowEndOffset: viewportWindowEnd,
          hasMore: window.hasMore,
          hasNewer: window.hasNewer,
          isAtLatest: window.isAtLatest,
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
        rows: viewportMessages.length,
        changed: didMessageListChange,
      });
      historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);
      prewarmAssistantMarkdownBodies(viewportMessages);
      prewarmStaticRowsForMessages(requestedSessionKey, viewportMessages);

      if (isForeground && historyActivityFlags.hasRecentFinalAssistantMessage) {
        finishChatRunTelemetry(requestedSessionKey, 'completed', { stage: 'history_applied' });
        clearHistoryPoll();
      }

      if ((didMessageListChange || scope === 'background') && hasPendingPreviewLoads(viewportMessages)) {
        void loadMissingPreviews(viewportMessages).then((updated) => {
          if (!updated) {
            return;
          }
          if (abortSignal.aborted || shouldAbortHistoryProcessing()) {
            return;
          }
          set((state) => buildHistoryPreviewHydrationPatch(
            state,
            requestedSessionKey,
            viewportMessages,
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
        rawRows: canonicalRawMessages.length,
      });
    }
  };
}


import { forwardRef, startTransition, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { selectStreamingRenderMessage } from '@/stores/chat/stream-overlay-message';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { buildChatAutoFollowSignal } from '../chat-auto-follow';
import { buildChatRenderItems } from '../chat-render-items';
import { useChatFirstPaint } from '../useFirstPaint';
import { useChatRenderItems } from '../chat-render-items';
import { useChatRealtimePerfMetrics } from '../useChatPerf';
import { useChatListCtl } from '../useChatListCtl';
import { useChatView } from '../useChatView';
import { projectLiveThreadMessages } from '../live-thread-projection';
import { appendRuntimeChatRows } from '../chat-row-model';
import { getOrBuildStaticRowsCacheEntry } from '../chat-rows-cache';
import { useRowsPipeline } from '../useRowsPipeline';
import {
  peekChatThreadRenderSnapshot,
  rememberChatThreadRenderSnapshot,
  type ChatThreadRenderSnapshot,
} from '../chat-thread-snapshot-cache';
import { ChatList } from './ChatList';

const MAX_MOUNTED_THREAD_HOSTS = 20;
const EMPTY_MESSAGES: RawMessage[] = [];
const EMPTY_EXECUTION_GRAPHS: [] = [];
const EMPTY_STREAMING_TOOLS: Array<{
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
  updatedAt: number;
}> = [];

type ReadProjection = 'live' | 'history';

interface ThreadAgent {
  id: string;
  name?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ChatThreadPaneProps {
  isActive: boolean;
  currentSessionKey: string;
  liveSessionHostKeys: string[];
  readProjection: ReadProjection;
  historyMessages: RawMessage[];
  historyLoading: boolean;
  historyTransitionPending: boolean;
  agents: ThreadAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  showThinking: boolean;
  userAvatarDataUrl: string | null;
  onEnterHistory: () => void;
  viewFullHistoryLabel: string;
  jumpToBottomLabel: string;
}

export interface ChatThreadPaneHandle {
  prepareCurrentLiveBottomAlign: () => void;
}

interface ChatSessionThreadHostProps {
  sessionKey: string;
  enabled: boolean;
  visible: boolean;
  currentSessionKey: string;
  readProjection: ReadProjection;
  historyMessages: RawMessage[];
  historyLoading: boolean;
  historyTransitionPending: boolean;
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  agents: ThreadAgent[];
  showThinking: boolean;
  userAvatarDataUrl: string | null;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  onEnterHistory: () => void;
  viewFullHistoryLabel: string;
  jumpToBottomLabel: string;
  onRegisterPrepareLiveBottomAlign: (sessionKey: string, prepare: (() => void) | null) => void;
}

function buildFallbackRenderSnapshot(input: {
  scopeKey: string;
  rowSessionKey: string;
  canonicalMessages: RawMessage[];
  projectionMessages: RawMessage[];
  isHistoryProjection: boolean;
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  pendingUserMessage: RawMessage | null;
  streamingMessage: unknown | null;
  streamingTools: typeof EMPTY_STREAMING_TOOLS;
  streamingTimestamp: number;
  currentSessionReady: boolean;
  currentSessionHasActivity: boolean;
  initialLoading: boolean;
  historyLoading: boolean;
}): ChatThreadRenderSnapshot {
  const rowSourceMessages = input.isHistoryProjection
    ? input.projectionMessages
    : projectLiveThreadMessages(input.canonicalMessages).messages;
  const staticRows = getOrBuildStaticRowsCacheEntry(
    input.rowSessionKey,
    rowSourceMessages,
    EMPTY_EXECUTION_GRAPHS,
  ).rows;
  const chatRows = appendRuntimeChatRows({
    sessionKey: input.rowSessionKey,
    baseRows: staticRows,
    sending: input.sending,
    pendingFinal: input.pendingFinal,
    waitingApproval: input.waitingApproval,
    showThinking: input.showThinking,
    pendingUserMessage: input.pendingUserMessage,
    streamingMessage: input.streamingMessage,
    streamingTools: input.streamingTools,
    streamingTimestamp: input.streamingTimestamp,
  });
  const chatItems = buildChatRenderItems(chatRows);
  const hasRenderableRows = chatRows.length > 0;
  const waitingForSessionSnapshot = !input.sending && !hasRenderableRows && !input.currentSessionReady;
  const likelyFreshSession = (
    waitingForSessionSnapshot
    && !input.currentSessionHasActivity
    && /^agent:[^:]+:session-\d{8,16}$/i.test(input.rowSessionKey)
  );
  const showBlockingLoading = input.isHistoryProjection
    ? input.historyLoading
    : waitingForSessionSnapshot && !likelyFreshSession && input.initialLoading;
  const isEmptyState = input.isHistoryProjection
    ? !input.historyLoading && chatRows.length === 0
    : !showBlockingLoading && !input.sending && chatRows.length === 0 && (input.currentSessionReady || likelyFreshSession);

  return {
    scopeKey: input.scopeKey,
    chatRows,
    chatItems,
    suppressedToolCardRowKeys: new Set<string>(),
    hiddenHistoryCount: input.isHistoryProjection ? 0 : projectLiveThreadMessages(input.canonicalMessages).hiddenRenderableCount,
    showBlockingLoading,
    isEmptyState,
    rowSliceCostMs: 0,
    runtimeRowsCostMs: 0,
  };
}

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? 'main';
}

function mergeMountedSessionKeys(
  previous: string[],
  nextKey: string,
  currentSessionKey: string,
): string[] {
  if (previous.includes(nextKey)) {
    return previous;
  }

  const next = [...previous, nextKey];
  while (next.length > MAX_MOUNTED_THREAD_HOSTS) {
    const removeIndex = next.findIndex((sessionKey) => sessionKey !== currentSessionKey && sessionKey !== nextKey);
    if (removeIndex < 0) {
      break;
    }
    next.splice(removeIndex, 1);
  }
  return next;
}

interface ChatSessionThreadLiveBindingProps {
  scopeKey: string;
  rowSessionKey: string;
  canonicalMessages: RawMessage[];
  projectionMessages: RawMessage[];
  isHistoryProjection: boolean;
  agents: ThreadAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  pendingUserMessage: RawMessage | null;
  streamingMessage: unknown | null;
  streamingTools: typeof EMPTY_STREAMING_TOOLS;
  streamingTimestamp: number;
  currentSessionReady: boolean;
  currentSessionHasActivity: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  historyLoading: boolean;
  onSnapshot: (snapshot: ChatThreadRenderSnapshot) => void;
}

function ChatSessionThreadLiveBinding({
  scopeKey,
  rowSessionKey,
  canonicalMessages,
  projectionMessages,
  isHistoryProjection,
  agents,
  isGatewayRunning,
  gatewayRpc,
  sending,
  pendingFinal,
  waitingApproval,
  showThinking,
  pendingUserMessage,
  streamingMessage,
  streamingTools,
  streamingTimestamp,
  currentSessionReady,
  currentSessionHasActivity,
  initialLoading,
  refreshing,
  mutating,
  historyLoading,
  onSnapshot,
}: ChatSessionThreadLiveBindingProps) {
  const sessionPipelineCostRef = useRef({
    sessionKey: scopeKey,
    rowSliceMs: 0,
    staticRowsMs: 0,
    runtimeRowsMs: 0,
  });

  useEffect(() => {
    sessionPipelineCostRef.current = {
      sessionKey: scopeKey,
      rowSliceMs: 0,
      staticRowsMs: 0,
      runtimeRowsMs: 0,
    };
  }, [scopeKey]);

  const {
    chatRows,
    suppressedToolCardRowKeys,
    hiddenHistoryCount,
    rowSliceCostMs,
    runtimeRowsCostMs,
  } = useRowsPipeline({
    projectionScopeKey: scopeKey,
    rowSessionKey,
    canonicalMessages,
    projectionMessages,
    isHistoryProjection,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    pendingUserMessage,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
    sessionPipelineCostRef,
  });
  const chatItems = useChatRenderItems(scopeKey, chatRows);
  const liveView = useChatView({
    currentSessionKey: rowSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    rowCount: chatRows.length,
    sending,
    initialLoading,
    refreshing,
    mutating,
  });
  const showBlockingLoading = isHistoryProjection ? historyLoading : liveView.showBlockingLoading;
  const isEmptyState = isHistoryProjection
    ? !historyLoading && chatRows.length === 0
    : liveView.isEmptyState;

  useEffect(() => {
    onSnapshot({
      scopeKey,
      chatRows,
      chatItems,
      suppressedToolCardRowKeys,
      hiddenHistoryCount,
      showBlockingLoading,
      isEmptyState,
      rowSliceCostMs,
      runtimeRowsCostMs,
    });
  }, [
    chatItems,
    chatRows,
    hiddenHistoryCount,
    isEmptyState,
    onSnapshot,
    rowSliceCostMs,
    runtimeRowsCostMs,
    scopeKey,
    showBlockingLoading,
    suppressedToolCardRowKeys,
  ]);

  return null;
}

function ChatSessionThreadHost({
    sessionKey,
    enabled,
    visible,
    currentSessionKey,
    readProjection,
    historyMessages,
    historyLoading,
    historyTransitionPending,
    isGatewayRunning,
    gatewayRpc,
    agents,
    showThinking,
    userAvatarDataUrl,
    initialLoading,
    refreshing,
    mutating,
    onEnterHistory,
    viewFullHistoryLabel,
    jumpToBottomLabel,
    onRegisterPrepareLiveBottomAlign,
  }: ChatSessionThreadHostProps) {
  const sessionRecord = useChatStore((state) => state.sessionsByKey[sessionKey]);
  const canonicalMessages = sessionRecord?.transcript ?? EMPTY_MESSAGES;
  const sessionMeta = sessionRecord?.meta;
  const sessionRuntime = sessionRecord?.runtime;

  const assistantAgentId = useMemo(() => parseAgentIdFromSessionKey(sessionKey), [sessionKey]);
  const assistantAgent = useMemo(
    () => agents.find((agent) => agent.id === assistantAgentId),
    [agents, assistantAgentId],
  );

  const projectionScopeKey = `${sessionKey}::${readProjection}`;
  const liveScopeKey = `${sessionKey}::live`;
  const scrollActivationKey = visible ? projectionScopeKey : `${sessionKey}::hidden`;
  const isHistoryProjection = readProjection === 'history';
  const projectionMessages = isHistoryProjection ? historyMessages : canonicalMessages;
  const runtimeStreamingTools = isHistoryProjection ? EMPTY_STREAMING_TOOLS : (sessionRuntime?.streamingTools ?? EMPTY_STREAMING_TOOLS);
  const runtimeSending = isHistoryProjection ? false : Boolean(sessionRuntime?.sending);
  const runtimePendingFinal = isHistoryProjection ? false : Boolean(sessionRuntime?.pendingFinal);
  const runtimeWaitingApproval = isHistoryProjection ? false : sessionRuntime?.approvalStatus === 'awaiting_approval';
  const runtimePendingUserMessage = isHistoryProjection ? null : sessionRuntime?.pendingUserMessage?.message ?? null;
  const runtimeStreamingMessage = isHistoryProjection ? null : selectStreamingRenderMessage({
    assistantOverlay: sessionRuntime?.assistantOverlay ?? null,
    lastUserMessageAt: sessionRuntime?.lastUserMessageAt ?? null,
    streamingTools: runtimeStreamingTools,
  });
  const streamingTimestamp = sessionRuntime?.lastUserMessageAt != null ? (sessionRuntime.lastUserMessageAt / 1000) : 0;
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const markScrollActivityRef = useRef<() => void>(() => {});
  const sessionPipelineCostRef = useRef({
    sessionKey: projectionScopeKey,
    rowSliceMs: 0,
    staticRowsMs: 0,
    runtimeRowsMs: 0,
  });
  const snapshotScopeKey = enabled ? projectionScopeKey : liveScopeKey;
  const [renderSnapshot, setRenderSnapshot] = useState<ChatThreadRenderSnapshot>(() => (
    peekChatThreadRenderSnapshot(snapshotScopeKey) ?? buildFallbackRenderSnapshot({
      scopeKey: snapshotScopeKey,
      rowSessionKey: sessionKey,
      canonicalMessages,
      projectionMessages,
      isHistoryProjection,
      sending: runtimeSending,
      pendingFinal: runtimePendingFinal,
      waitingApproval: runtimeWaitingApproval,
      showThinking,
      pendingUserMessage: runtimePendingUserMessage,
      streamingMessage: runtimeStreamingMessage,
      streamingTools: runtimeStreamingTools,
      streamingTimestamp,
      currentSessionReady: Boolean(sessionMeta?.ready),
      currentSessionHasActivity: typeof sessionMeta?.lastActivityAt === 'number',
      initialLoading,
      historyLoading,
    })
  ));

  useEffect(() => {
    const cached = peekChatThreadRenderSnapshot(snapshotScopeKey);
    const nextSnapshot = cached ?? buildFallbackRenderSnapshot({
      scopeKey: snapshotScopeKey,
      rowSessionKey: sessionKey,
      canonicalMessages,
      projectionMessages,
      isHistoryProjection,
      sending: runtimeSending,
      pendingFinal: runtimePendingFinal,
      waitingApproval: runtimeWaitingApproval,
      showThinking,
      pendingUserMessage: runtimePendingUserMessage,
      streamingMessage: runtimeStreamingMessage,
      streamingTools: runtimeStreamingTools,
      streamingTimestamp,
      currentSessionReady: Boolean(sessionMeta?.ready),
      currentSessionHasActivity: typeof sessionMeta?.lastActivityAt === 'number',
      initialLoading,
      historyLoading,
    });
    setRenderSnapshot((previous) => (
      previous.scopeKey === nextSnapshot.scopeKey
      && previous.chatRows === nextSnapshot.chatRows
      && previous.chatItems === nextSnapshot.chatItems
      && previous.suppressedToolCardRowKeys === nextSnapshot.suppressedToolCardRowKeys
      && previous.hiddenHistoryCount === nextSnapshot.hiddenHistoryCount
      && previous.showBlockingLoading === nextSnapshot.showBlockingLoading
      && previous.isEmptyState === nextSnapshot.isEmptyState
      ? previous
      : nextSnapshot
    ));
  }, [
    canonicalMessages,
    historyLoading,
    initialLoading,
    isHistoryProjection,
    runtimePendingUserMessage,
    projectionMessages,
    runtimePendingFinal,
    runtimeSending,
    runtimeStreamingMessage,
    runtimeStreamingTools,
    runtimeWaitingApproval,
    sessionKey,
    sessionMeta?.lastActivityAt,
    sessionMeta?.ready,
    showThinking,
    snapshotScopeKey,
    streamingTimestamp,
  ]);

  useEffect(() => {
    sessionPipelineCostRef.current = {
      sessionKey: projectionScopeKey,
      rowSliceMs: renderSnapshot.rowSliceCostMs,
      staticRowsMs: 0,
      runtimeRowsMs: renderSnapshot.runtimeRowsCostMs,
    };
  }, [projectionScopeKey, renderSnapshot.rowSliceCostMs, renderSnapshot.runtimeRowsCostMs]);

  const handleSnapshot = useCallback((snapshot: ChatThreadRenderSnapshot) => {
    rememberChatThreadRenderSnapshot(snapshot);
    setRenderSnapshot((previous) => {
      if (
        previous.scopeKey === snapshot.scopeKey
        && previous.chatRows === snapshot.chatRows
        && previous.chatItems === snapshot.chatItems
        && previous.suppressedToolCardRowKeys === snapshot.suppressedToolCardRowKeys
        && previous.hiddenHistoryCount === snapshot.hiddenHistoryCount
        && previous.showBlockingLoading === snapshot.showBlockingLoading
        && previous.isEmptyState === snapshot.isEmptyState
        && previous.rowSliceCostMs === snapshot.rowSliceCostMs
        && previous.runtimeRowsCostMs === snapshot.runtimeRowsCostMs
      ) {
        return previous;
      }
      return snapshot;
    });
  }, []);

  const chatRows = renderSnapshot.chatRows;

  const autoFollowSignal = isHistoryProjection
    ? `${projectionScopeKey}|history`
    : buildChatAutoFollowSignal(chatRows);
  const tailActivityOpen = !isHistoryProjection && (
    runtimeSending
    || runtimePendingFinal
    || runtimePendingUserMessage != null
    || runtimeStreamingMessage != null
    || runtimeStreamingTools.length > 0
  );

  const {
    markScrollActivity,
  } = useChatRealtimePerfMetrics({
    enabled,
    currentSessionKey: projectionScopeKey,
    sending: runtimeSending,
    streamingMessage: runtimeStreamingMessage,
    streamingTools: runtimeStreamingTools,
    runtimeRowsCostMs: renderSnapshot.runtimeRowsCostMs,
    chatRowRenderSignal: chatRows,
  });
  markScrollActivityRef.current = markScrollActivity;

  const {
    handleViewportPointerDown,
    handleViewportTouchMove,
    handleViewportWheel,
    handleViewportScroll,
    jumpToBottom,
    isBottomLocked,
    scrollToRowKey,
    prepareScopeAnchorRestore,
    prepareScopeBottomAlign,
  } = useChatListCtl({
    enabled,
    scrollScopeKey: projectionScopeKey,
    scrollActivationKey,
    scrollResetKey: sessionKey,
    autoFollowSignal,
    scopeRestorePending: isHistoryProjection && historyTransitionPending,
    tailActivityOpen,
    messagesViewportRef,
    messageContentRef,
    markScrollActivity: () => markScrollActivityRef.current(),
  });

  useEffect(() => {
    onRegisterPrepareLiveBottomAlign(sessionKey, () => {
      prepareScopeBottomAlign(`${sessionKey}::live`);
    });
    return () => {
      onRegisterPrepareLiveBottomAlign(sessionKey, null);
    };
  }, [onRegisterPrepareLiveBottomAlign, prepareScopeBottomAlign, sessionKey]);

  useChatFirstPaint({
    enabled,
    currentSessionKey: projectionScopeKey,
    rowCount: chatRows.length,
    isEmptyState: renderSnapshot.isEmptyState,
    showBlockingLoading: renderSnapshot.showBlockingLoading,
    rowSliceCostMs: renderSnapshot.rowSliceCostMs,
    sessionPipelineCostRef,
  });

  const handleViewHistory = useCallback(() => {
    prepareScopeAnchorRestore(`${sessionKey}::history`);
    onEnterHistory();
  }, [onEnterHistory, prepareScopeAnchorRestore, sessionKey]);

  return (
    <div className={cn('absolute inset-0 flex min-h-0', !visible && 'hidden')}>
      {enabled && (
        <ChatSessionThreadLiveBinding
          scopeKey={projectionScopeKey}
          rowSessionKey={sessionKey}
          canonicalMessages={canonicalMessages}
          projectionMessages={projectionMessages}
          isHistoryProjection={isHistoryProjection}
          agents={agents}
          isGatewayRunning={isGatewayRunning}
          gatewayRpc={gatewayRpc}
          sending={runtimeSending}
          pendingFinal={runtimePendingFinal}
          waitingApproval={runtimeWaitingApproval}
          showThinking={showThinking}
          pendingUserMessage={runtimePendingUserMessage}
          streamingMessage={runtimeStreamingMessage}
          streamingTools={runtimeStreamingTools}
          streamingTimestamp={streamingTimestamp}
          currentSessionReady={Boolean(sessionMeta?.ready)}
          currentSessionHasActivity={typeof sessionMeta?.lastActivityAt === 'number'}
          initialLoading={initialLoading}
          refreshing={refreshing}
          mutating={mutating}
          historyLoading={historyLoading}
          onSnapshot={handleSnapshot}
        />
      )}
      <ChatList
        messagesViewportRef={messagesViewportRef}
        messageContentRef={messageContentRef}
        isEmptyState={renderSnapshot.isEmptyState}
        showBlockingLoading={renderSnapshot.showBlockingLoading}
        onPointerDown={handleViewportPointerDown}
        onScroll={handleViewportScroll}
        onTouchMove={handleViewportTouchMove}
        onWheel={handleViewportWheel}
        items={renderSnapshot.chatItems}
        showHistoryEntry={!isHistoryProjection && sessionKey === currentSessionKey && renderSnapshot.hiddenHistoryCount > 0}
        onViewHistory={handleViewHistory}
        viewFullHistoryLabel={viewFullHistoryLabel}
        showJumpToBottom={!renderSnapshot.isEmptyState && !renderSnapshot.showBlockingLoading && !isBottomLocked}
        onJumpToBottom={jumpToBottom}
        jumpToBottomLabel={jumpToBottomLabel}
        showThinking={showThinking}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgent?.name || assistantAgentId}
        assistantAvatarSeed={assistantAgent?.avatarSeed}
        assistantAvatarStyle={assistantAgent?.avatarStyle}
        userAvatarImageUrl={userAvatarDataUrl}
        suppressedToolCardRowKeys={renderSnapshot.suppressedToolCardRowKeys}
        onJumpToRowKey={scrollToRowKey}
      />
    </div>
  );
}

export const ChatThreadPane = forwardRef<ChatThreadPaneHandle, ChatThreadPaneProps>(function ChatThreadPane(
  {
    isActive,
    currentSessionKey,
    liveSessionHostKeys,
    readProjection,
    historyMessages,
    historyLoading,
    historyTransitionPending,
    agents,
    isGatewayRunning,
    gatewayRpc,
    initialLoading,
    refreshing,
    mutating,
    showThinking,
    userAvatarDataUrl,
    onEnterHistory,
    viewFullHistoryLabel,
    jumpToBottomLabel,
  },
  ref,
) {
  const [mountedSessionKeys, setMountedSessionKeys] = useState<string[]>(() => [currentSessionKey]);
  const prepareLiveBottomAlignBySessionRef = useRef(new Map<string, () => void>());

  useEffect(() => {
    setMountedSessionKeys((previous) => mergeMountedSessionKeys(previous, currentSessionKey, currentSessionKey));
  }, [currentSessionKey]);

  useEffect(() => {
    const liveSessionHostKeySet = new Set(liveSessionHostKeys);
    setMountedSessionKeys((previous) => previous.filter((sessionKey) => (
      sessionKey === currentSessionKey || liveSessionHostKeySet.has(sessionKey)
    )));
  }, [currentSessionKey, liveSessionHostKeys]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    let cancelled = false;
    let cancelIdleTask: (() => void) | null = null;
    const pendingSessionKeys = liveSessionHostKeys.filter((sessionKey) => !mountedSessionKeys.includes(sessionKey));
    let nextIndex = 0;

    const scheduleNext = () => {
      if (cancelled || nextIndex >= pendingSessionKeys.length) {
        return;
      }
      cancelIdleTask = scheduleIdleReady(() => {
        if (cancelled) {
          return;
        }
        const nextSessionKey = pendingSessionKeys[nextIndex];
        if (!nextSessionKey) {
          return;
        }
        nextIndex += 1;
        startTransition(() => {
          setMountedSessionKeys((previous) => mergeMountedSessionKeys(previous, nextSessionKey, currentSessionKey));
        });
        scheduleNext();
      }, {
        idleTimeoutMs: 240,
        fallbackDelayMs: 90,
      });
    };

    scheduleNext();
    return () => {
      cancelled = true;
      cancelIdleTask?.();
    };
  }, [currentSessionKey, isActive, liveSessionHostKeys, mountedSessionKeys]);

  const handleRegisterPrepareLiveBottomAlign = useCallback((sessionKey: string, prepare: (() => void) | null) => {
    const registry = prepareLiveBottomAlignBySessionRef.current;
    if (prepare) {
      registry.set(sessionKey, prepare);
      return;
    }
    registry.delete(sessionKey);
  }, []);

  useImperativeHandle(ref, () => ({
    prepareCurrentLiveBottomAlign: () => {
      prepareLiveBottomAlignBySessionRef.current.get(currentSessionKey)?.();
    },
  }), [currentSessionKey]);

  const stableAgents = useMemo(
    () => agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      avatarSeed: agent.avatarSeed,
      avatarStyle: agent.avatarStyle,
    })),
    [agents],
  );

  return (
    <div className="relative min-h-0 flex-1">
      {mountedSessionKeys.map((sessionKey) => {
        const visible = sessionKey === currentSessionKey;
        return (
          <ChatSessionThreadHost
            key={sessionKey}
            sessionKey={sessionKey}
            enabled={isActive && visible}
            visible={visible}
            currentSessionKey={currentSessionKey}
            readProjection={visible ? readProjection : 'live'}
            historyMessages={visible && readProjection === 'history' ? historyMessages : []}
            historyLoading={visible && readProjection === 'history' ? historyLoading : false}
            historyTransitionPending={visible && readProjection === 'history' ? historyTransitionPending : false}
            isGatewayRunning={isGatewayRunning}
            gatewayRpc={gatewayRpc}
            agents={stableAgents}
            showThinking={showThinking}
            userAvatarDataUrl={userAvatarDataUrl}
            initialLoading={visible ? initialLoading : false}
            refreshing={visible ? refreshing : false}
            mutating={visible ? mutating : false}
            onEnterHistory={onEnterHistory}
            viewFullHistoryLabel={viewFullHistoryLabel}
            jumpToBottomLabel={jumpToBottomLabel}
            onRegisterPrepareLiveBottomAlign={handleRegisterPrepareLiveBottomAlign}
          />
        );
      })}
    </div>
  );
});

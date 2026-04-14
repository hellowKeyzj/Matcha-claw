/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { selectChatPageState } from '@/stores/chat/selectors';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ChatInput } from './ChatInput';
import { TaskInboxPanel } from './components/TaskInboxPanel';
import { AgentSkillConfigDialog, type AgentSkillOption } from './components/AgentSkillConfigDialog';
import { WelcomeScreen } from './components/ChatStates';
import { ChatRowItem } from './components/ChatRowItem';
import { ChatHeaderBar } from './components/ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner } from './components/ChatRuntimeDock';
import { VerticalPaneResizer } from '@/components/layout/VerticalPaneResizer';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { trackUiTiming } from '@/lib/telemetry';
import {
  appendRuntimeChatRows,
  appendMessageRows,
  buildStaticChatRowsWithMeta,
  canAppendMessageList,
  isRenderableChatMessage,
  type ChatRow,
  type ExecutionGraphData,
} from './chat-row-model';
import { useChatScrollOrchestrator } from './useChatScrollOrchestrator';
import { useMinLoading } from './useMinLoading';
import { useTaskInboxLayout } from './useTaskInboxLayout';
import { useExecutionGraphs } from './useExecutionGraphs';

const CHAT_STICKY_BOTTOM_THRESHOLD_PX = 120;
const CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX = 168;
const CHAT_VIRTUAL_OVERSCAN = 8;
const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
const EMPTY_MESSAGES: RawMessage[] = [];
const NEW_SESSION_KEY_PATTERN = /^agent:[^:]+:session-\d{8,16}$/i;
const STATIC_ROWS_CACHE_MAX_SESSIONS = 20;
const CHAT_FIRST_PAINT_RENDERABLE_LIMIT = 8;
const SESSION_RENDER_WINDOW_MAX_SESSIONS = 40;
const SESSION_RENDER_WINDOW_EXPAND_STEP = 24;
const SESSION_RENDER_WINDOW_TOP_THRESHOLD_PX = 12;
const SESSION_RENDER_WINDOW_REARM_THRESHOLD_PX = 180;
const SESSION_RENDER_WINDOW_EXPAND_DEBOUNCE_MS = 140;
const HISTORY_IDLE_LOAD_TIMEOUT_MS = 1000;

interface SessionStaticRowsCache {
  messagesRef: RawMessage[];
  executionGraphsRef: ExecutionGraphData[];
  rows: ChatRow[];
  renderableCount: number;
}

const globalStaticRowsCache = new Map<string, SessionStaticRowsCache>();
const globalSessionRenderableWindowLimit = new Map<string, number>();
const globalRenderWindowSliceCache = new WeakMap<RawMessage[], Map<number, RenderWindowSliceResult>>();

type IdleTaskHandle = number | ReturnType<typeof setTimeout>;

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function roundTiming(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function scheduleIdleTask(task: () => void, timeoutMs = HISTORY_IDLE_LOAD_TIMEOUT_MS): IdleTaskHandle {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      return win.requestIdleCallback(() => task(), { timeout: timeoutMs });
    }
  }
  return setTimeout(task, 80);
}

function cancelIdleTask(handle: IdleTaskHandle): void {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.cancelIdleCallback === 'function' && typeof handle === 'number') {
      win.cancelIdleCallback(handle);
      return;
    }
  }
  clearTimeout(handle);
}

function getSessionRenderableWindowLimit(sessionKey: string): number {
  const cached = globalSessionRenderableWindowLimit.get(sessionKey);
  if (typeof cached === 'number' && Number.isFinite(cached) && cached >= CHAT_FIRST_PAINT_RENDERABLE_LIMIT) {
    return cached;
  }
  return CHAT_FIRST_PAINT_RENDERABLE_LIMIT;
}

function updateSessionRenderableWindowLimit(sessionKey: string, nextLimit: number): void {
  const normalized = Math.max(CHAT_FIRST_PAINT_RENDERABLE_LIMIT, Math.floor(nextLimit));
  if (globalSessionRenderableWindowLimit.has(sessionKey)) {
    globalSessionRenderableWindowLimit.delete(sessionKey);
  }
  globalSessionRenderableWindowLimit.set(sessionKey, normalized);
  while (globalSessionRenderableWindowLimit.size > SESSION_RENDER_WINDOW_MAX_SESSIONS) {
    const oldestKey = globalSessionRenderableWindowLimit.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    globalSessionRenderableWindowLimit.delete(oldestKey);
  }
}

interface RenderWindowSliceResult {
  messages: RawMessage[];
  hasOlderRenderableMessages: boolean;
}

type PrependWindowTxn =
  | { phase: 'idle' }
  | {
    phase: 'scheduled';
    id: number;
    sessionKey: string;
    rowKey: string;
    rowOffsetPx: number;
    previousScrollTop: number;
    previousScrollHeight: number;
  };

function sliceMessagesForFirstPaint(
  messages: RawMessage[],
  renderableLimit: number,
): RenderWindowSliceResult {
  if (messages.length === 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  let renderableCount = 0;
  let startIndex = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isRenderableChatMessage(messages[index])) {
      continue;
    }
    renderableCount += 1;
    if (renderableCount >= renderableLimit) {
      startIndex = index;
      break;
    }
  }
  if (startIndex <= 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  let hasOlderRenderableMessages = false;
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    if (!isRenderableChatMessage(messages[index])) {
      continue;
    }
    hasOlderRenderableMessages = true;
    break;
  }
  return {
    messages: messages.slice(startIndex),
    hasOlderRenderableMessages,
  };
}

function getCachedRenderWindowSlice(
  messages: RawMessage[],
  renderableLimit: number,
): RenderWindowSliceResult {
  if (messages.length === 0) {
    return { messages, hasOlderRenderableMessages: false };
  }
  const normalizedLimit = Math.max(1, Math.floor(renderableLimit));
  const byLimit = globalRenderWindowSliceCache.get(messages);
  const cached = byLimit?.get(normalizedLimit);
  if (cached) {
    return cached;
  }
  const computed = sliceMessagesForFirstPaint(messages, normalizedLimit);
  if (byLimit) {
    byLimit.set(normalizedLimit, computed);
  } else {
    globalRenderWindowSliceCache.set(messages, new Map([[normalizedLimit, computed]]));
  }
  return computed;
}

function rememberSessionStaticRowsCache(sessionKey: string, cache: SessionStaticRowsCache): void {
  if (globalStaticRowsCache.has(sessionKey)) {
    globalStaticRowsCache.delete(sessionKey);
  }
  globalStaticRowsCache.set(sessionKey, cache);
  while (globalStaticRowsCache.size > STATIC_ROWS_CACHE_MAX_SESSIONS) {
    const oldestKey = globalStaticRowsCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    globalStaticRowsCache.delete(oldestKey);
  }
}

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? 'main';
}

function resolveAgentEmoji(explicitEmoji: string | undefined, isDefault: boolean): string {
  if (explicitEmoji && explicitEmoji.trim()) {
    return explicitEmoji;
  }
  return isDefault ? '⚙️' : '🤖';
}

export function Chat() {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((s) => s.status);
  const gatewayRpc = useGatewayStore((s) => s.rpc);
  const isGatewayRunning = gatewayStatus.state === 'running';

  const {
    messages,
    initialLoading,
    refreshing,
    mutating,
    sending,
    error,
    showThinking,
    streamingMessage,
    streamingTools,
    pendingFinal,
    approvalStatus,
    currentPendingApprovals,
    resolveApproval,
    loadHistory,
    loadSessions,
    switchSession,
    openAgentConversation,
    currentSessionKey,
    currentSessionReady,
    currentSessionHasActivity,
    sendMessage,
    abortRun,
    clearError,
    cleanupEmptySession,
  } = useChatStore(useShallow(selectChatPageState));
  const agents = useSubagentsStore((s) => s.agents);
  const loadAgents = useSubagentsStore((s) => s.loadAgents);
  const updateAgent = useSubagentsStore((s) => s.updateAgent);
  const skills = useSkillsStore((s) => s.skills);
  const skillsSnapshotReady = useSkillsStore((s) => s.snapshotReady);
  const skillsInitialLoading = useSkillsStore((s) => s.initialLoading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const userAvatarDataUrl = useSettingsStore((s) => s.userAvatarDataUrl);

  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const [streamingTimestamp, setStreamingTimestamp] = useState<number>(0);
  const initialHistoryIdleHandleRef = useRef<IdleTaskHandle | null>(null);
  const {
    taskInboxCollapsed,
    setTaskInboxCollapsed,
    taskInboxWidth,
    startTaskInboxResize,
    taskInboxResizerWidth,
  } = useTaskInboxLayout(chatLayoutRef);
  const [skillConfigOpen, setSkillConfigOpen] = useState(false);
  const [skillConfigSaving, setSkillConfigSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [, setRenderWindowVersion] = useState(0);
  const sessionWindowBudgetInitializedRef = useRef<string | null>(null);
  const expandWindowArmedRef = useRef(true);
  const expandWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prependWindowTxnRef = useRef<PrependWindowTxn>({ phase: 'idle' });
  const prependWindowTxnSeqRef = useRef(0);
  const sessionFirstPaintRef = useRef<{
    sessionKey: string;
    startedAt: number;
    reported: boolean;
  } | null>(null);
  const sessionPipelineCostRef = useRef<{
    sessionKey: string;
    rowSliceMs: number;
    staticRowsMs: number;
    runtimeRowsMs: number;
  }>({
    sessionKey: currentSessionKey,
    rowSliceMs: 0,
    staticRowsMs: 0,
    runtimeRowsMs: 0,
  });

  // Load data when gateway is running.
  // When the store already holds messages for this session (i.e. the user
  // is navigating *back* to Chat), use quiet mode so the existing messages
  // stay visible while fresh data loads in the background.  This avoids
  // an unnecessary messages → spinner → messages flicker.
  useEffect(() => {
    if (!isGatewayRunning) return;
    let cancelled = false;
    const hasExistingMessages = useChatStore.getState().messages.length > 0;
    const params = new URLSearchParams(location.search);
    const sessionParam = params.get('session')?.trim() ?? '';
    const agentParam = params.get('agent')?.trim() ?? '';
    if (sessionParam) {
      switchSession(sessionParam);
      navigate('/', { replace: true });
    } else if (agentParam) {
      openAgentConversation(agentParam);
      navigate('/', { replace: true });
    }
    (async () => {
      const subagentsState = useSubagentsStore.getState();
      const shouldLoadAgents = (
        !subagentsState.snapshotReady
        || subagentsState.agents.length === 0
        || !subagentsState.lastLoadedAt
        || (Date.now() - subagentsState.lastLoadedAt) > SUBAGENTS_SNAPSHOT_TTL_MS
      );
      if (shouldLoadAgents) {
        await loadAgents();
      }
      await loadSessions();
      if (cancelled) return;
      if (sessionParam || agentParam) {
        return;
      }
      if (hasExistingMessages) {
        initialHistoryIdleHandleRef.current = scheduleIdleTask(() => {
          initialHistoryIdleHandleRef.current = null;
          if (cancelled) {
            return;
          }
          void loadHistory(true);
        });
        return;
      }
      await loadHistory(false);
    })();
    return () => {
      cancelled = true;
      if (initialHistoryIdleHandleRef.current != null) {
        cancelIdleTask(initialHistoryIdleHandleRef.current);
        initialHistoryIdleHandleRef.current = null;
      }
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession, isGatewayRunning, loadAgents, loadHistory, loadSessions, location.search, navigate, openAgentConversation, switchSession]);

  // Update timestamp when sending starts
  useEffect(() => {
    if (sending && streamingTimestamp === 0) {
      setStreamingTimestamp(Date.now() / 1000);
    } else if (!sending && streamingTimestamp !== 0) {
      setStreamingTimestamp(0);
    }
  }, [sending, streamingTimestamp]);

  const waitingApproval = approvalStatus === 'awaiting_approval';
  const isSessionWindowBudgetFirstPass = sessionWindowBudgetInitializedRef.current !== currentSessionKey;
  const sessionRenderableWindowLimit = isSessionWindowBudgetFirstPass
    ? CHAT_FIRST_PAINT_RENDERABLE_LIMIT
    : getSessionRenderableWindowLimit(currentSessionKey);
  const renderWindowSlice = useMemo(
    () => {
      const startedAt = nowMs();
      const slice = getCachedRenderWindowSlice(messages, sessionRenderableWindowLimit);
      const cost = sessionPipelineCostRef.current;
      if (cost.sessionKey === currentSessionKey) {
        cost.rowSliceMs += Math.max(0, nowMs() - startedAt);
      }
      return slice;
    },
    [currentSessionKey, messages, sessionRenderableWindowLimit],
  );
  const rowSourceMessages = renderWindowSlice.messages;
  const hasOlderRenderableRows = renderWindowSlice.hasOlderRenderableMessages;

  const deferredMessages = useDeferredValue(messages);
  const deferredSessionKey = useDeferredValue(currentSessionKey);
  const executionGraphInputReady = deferredSessionKey === currentSessionKey && deferredMessages === messages;
  const { executionGraphs, suppressedToolCardRowKeys } = useExecutionGraphs({
    messages: executionGraphInputReady ? rowSourceMessages : EMPTY_MESSAGES,
    currentSessionKey,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    showThinking,
    streamingMessage,
    streamingTools,
  });

  const staticChatRows = useMemo(
    () => {
      const startedAt = nowMs();
      const previousCache = globalStaticRowsCache.get(currentSessionKey);
      if (
        previousCache
        && previousCache.messagesRef === rowSourceMessages
        && previousCache.executionGraphsRef === executionGraphs
      ) {
        const cost = sessionPipelineCostRef.current;
        if (cost.sessionKey === currentSessionKey) {
          cost.staticRowsMs += Math.max(0, nowMs() - startedAt);
        }
        return previousCache.rows;
      }

      let rows: ChatRow[];
      let renderableCount: number;
      const canIncrementalAppend = Boolean(
        previousCache
        && previousCache.executionGraphsRef === executionGraphs
        && canAppendMessageList(previousCache.messagesRef, rowSourceMessages),
      );
      if (canIncrementalAppend && previousCache) {
        const appended = appendMessageRows(
          currentSessionKey,
          previousCache.rows,
          rowSourceMessages,
          previousCache.messagesRef.length,
          previousCache.renderableCount,
        );
        rows = appended.rows;
        renderableCount = appended.renderableCount;
      } else {
        const built = buildStaticChatRowsWithMeta({
          sessionKey: currentSessionKey,
          messages: rowSourceMessages,
          executionGraphs,
        });
        rows = built.rows;
        renderableCount = built.renderableCount;
      }

      rememberSessionStaticRowsCache(currentSessionKey, {
        messagesRef: rowSourceMessages,
        executionGraphsRef: executionGraphs,
        rows,
        renderableCount,
      });
      const cost = sessionPipelineCostRef.current;
      if (cost.sessionKey === currentSessionKey) {
        cost.staticRowsMs += Math.max(0, nowMs() - startedAt);
      }
      return rows;
    },
    [currentSessionKey, executionGraphs, rowSourceMessages],
  );
  const chatRows = useMemo(
    () => {
      const startedAt = nowMs();
      const rows = appendRuntimeChatRows({
        sessionKey: currentSessionKey,
        baseRows: staticChatRows,
        sending,
        pendingFinal,
        waitingApproval,
        showThinking,
        streamingMessage,
        streamingTools,
        streamingTimestamp,
      });
      const cost = sessionPipelineCostRef.current;
      if (cost.sessionKey === currentSessionKey) {
        cost.runtimeRowsMs += Math.max(0, nowMs() - startedAt);
      }
      return rows;
    },
    [
      currentSessionKey,
      pendingFinal,
      sending,
      showThinking,
      staticChatRows,
      streamingMessage,
      streamingTimestamp,
      streamingTools,
      waitingApproval,
    ],
  );
  const hasRenderableRows = chatRows.length > 0;
  const waitingForSessionSnapshot = !sending && !hasRenderableRows && !currentSessionReady;
  const isColdInitialLoad = initialLoading && !sending;
  const loadingVisible = useMinLoading(waitingForSessionSnapshot || isColdInitialLoad, isColdInitialLoad ? 450 : 0);
  const likelyFreshSession = (
    waitingForSessionSnapshot
    && !currentSessionHasActivity
    && NEW_SESSION_KEY_PATTERN.test(currentSessionKey)
  );
  const showBlockingLoading = waitingForSessionSnapshot && !likelyFreshSession && loadingVisible;
  const showBackgroundStatus = !showBlockingLoading && (refreshing || mutating);
  const isEmptyState = !showBlockingLoading && !sending && chatRows.length === 0 && (currentSessionReady || likelyFreshSession);

  useEffect(() => {
    const now = nowMs();
    sessionFirstPaintRef.current = {
      sessionKey: currentSessionKey,
      startedAt: now,
      reported: false,
    };
    sessionPipelineCostRef.current = {
      sessionKey: currentSessionKey,
      rowSliceMs: 0,
      staticRowsMs: 0,
      runtimeRowsMs: 0,
    };
  }, [currentSessionKey]);

  useEffect(() => {
    const tracker = sessionFirstPaintRef.current;
    if (!tracker || tracker.reported || tracker.sessionKey !== currentSessionKey) {
      return;
    }
    const hasFirstPaint = !showBlockingLoading && (chatRows.length > 0 || isEmptyState);
    if (!hasFirstPaint) {
      return;
    }
    const now = nowMs();
    tracker.reported = true;
    const pipelineCost = sessionPipelineCostRef.current;
    trackUiTiming('chat.session_first_paint', Math.max(0, now - tracker.startedAt), {
      sessionKey: currentSessionKey,
      rowCount: chatRows.length,
      emptyState: isEmptyState,
      rowSliceMs: pipelineCost.sessionKey === currentSessionKey ? roundTiming(pipelineCost.rowSliceMs) : 0,
      staticRowsMs: pipelineCost.sessionKey === currentSessionKey ? roundTiming(pipelineCost.staticRowsMs) : 0,
      runtimeRowsMs: pipelineCost.sessionKey === currentSessionKey ? roundTiming(pipelineCost.runtimeRowsMs) : 0,
      richRenderDeferred: false,
    });
  }, [chatRows.length, currentSessionKey, isEmptyState, showBlockingLoading]);

  const {
    handleViewportPointerDown,
    handleViewportScroll,
    handleViewportTouchMove,
    handleViewportWheel,
    handleVirtualizerChange,
    scrollState,
  } = useChatScrollOrchestrator({
    currentSessionKey,
    rows: chatRows,
    viewportRef: messagesViewportRef,
    contentRef: messageContentRef,
    stickyBottomThresholdPx: CHAT_STICKY_BOTTOM_THRESHOLD_PX,
  });
  useEffect(() => {
    return () => {
      if (expandWindowTimerRef.current != null) {
        clearTimeout(expandWindowTimerRef.current);
        expandWindowTimerRef.current = null;
      }
      globalSessionRenderableWindowLimit.clear();
      sessionWindowBudgetInitializedRef.current = null;
      prependWindowTxnRef.current = { phase: 'idle' };
    };
  }, []);

  useEffect(() => {
    sessionWindowBudgetInitializedRef.current = currentSessionKey;
    updateSessionRenderableWindowLimit(currentSessionKey, CHAT_FIRST_PAINT_RENDERABLE_LIMIT);
    expandWindowArmedRef.current = true;
    if (expandWindowTimerRef.current != null) {
      clearTimeout(expandWindowTimerRef.current);
      expandWindowTimerRef.current = null;
    }
    prependWindowTxnRef.current = { phase: 'idle' };
  }, [currentSessionKey]);

  const messageVirtualizer = useVirtualizer({
    count: chatRows.length,
    getScrollElement: () => messagesViewportRef.current,
    estimateSize: () => CHAT_VIRTUAL_ESTIMATE_HEIGHT_PX,
    overscan: CHAT_VIRTUAL_OVERSCAN,
    getItemKey: (index) => chatRows[index]?.key ?? `idx:${index}`,
    onChange: (instance) => {
      handleVirtualizerChange(instance);
    },
  });
  const virtualMessageItems = messageVirtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const txn = prependWindowTxnRef.current;
    if (txn.phase !== 'scheduled' || txn.sessionKey !== currentSessionKey) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    if (scrollState.mode !== 'detached' || scrollState.command.type !== 'none') {
      prependWindowTxnRef.current = { phase: 'idle' };
      return;
    }

    const targetIndex = chatRows.findIndex((row) => row.key === txn.rowKey);
    if (targetIndex >= 0) {
      messageVirtualizer.scrollToIndex(targetIndex, { align: 'start' });
    }

    let anchorElement: HTMLDivElement | null = null;
    const rowElements = viewport.querySelectorAll<HTMLDivElement>('[data-chat-row-key]');
    for (const element of rowElements) {
      if (element.dataset.chatRowKey === txn.rowKey) {
        anchorElement = element;
        break;
      }
    }

    if (anchorElement) {
      const viewportTop = viewport.getBoundingClientRect().top;
      const currentRowTop = anchorElement.getBoundingClientRect().top - viewportTop;
      const desiredRowTop = -txn.rowOffsetPx;
      const delta = currentRowTop - desiredRowTop;
      if (Math.abs(delta) > 0.5) {
        viewport.scrollTop += delta;
      }
      prependWindowTxnRef.current = { phase: 'idle' };
      return;
    }

    const totalHeightDelta = viewport.scrollHeight - txn.previousScrollHeight;
    if (Number.isFinite(totalHeightDelta) && Math.abs(totalHeightDelta) > 0.5) {
      viewport.scrollTop = Math.max(0, txn.previousScrollTop + totalHeightDelta);
    }
    prependWindowTxnRef.current = { phase: 'idle' };
  }, [chatRows, currentSessionKey, messageVirtualizer, scrollState.command.type, scrollState.mode]);

  const maybeExpandRenderableWindow = useCallback(() => {
    if (scrollState.mode !== 'detached' || scrollState.command.type !== 'none') {
      return;
    }
    if (!hasOlderRenderableRows) {
      return;
    }
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      return;
    }
    if (viewport.scrollTop > SESSION_RENDER_WINDOW_REARM_THRESHOLD_PX) {
      expandWindowArmedRef.current = true;
      if (expandWindowTimerRef.current != null) {
        clearTimeout(expandWindowTimerRef.current);
        expandWindowTimerRef.current = null;
      }
      return;
    }
    if (viewport.scrollTop > SESSION_RENDER_WINDOW_TOP_THRESHOLD_PX) {
      return;
    }
    if (!expandWindowArmedRef.current) {
      return;
    }
    if (expandWindowTimerRef.current != null) {
      clearTimeout(expandWindowTimerRef.current);
    }
    const sessionKeyAtSchedule = currentSessionKey;
    expandWindowTimerRef.current = setTimeout(() => {
      expandWindowTimerRef.current = null;
      const activeViewport = messagesViewportRef.current;
      if (!activeViewport || activeViewport.scrollTop > SESSION_RENDER_WINDOW_TOP_THRESHOLD_PX) {
        return;
      }
      if (useChatStore.getState().currentSessionKey !== sessionKeyAtSchedule || !expandWindowArmedRef.current) {
        return;
      }
      const visibleItems = messageVirtualizer.getVirtualItems();
      let anchorItem = visibleItems.find((item) => (
        item.start <= activeViewport.scrollTop
        && (item.start + item.size) > activeViewport.scrollTop
      ));
      if (!anchorItem) {
        anchorItem = visibleItems[0];
      }
      const anchorRow = anchorItem ? chatRows[anchorItem.index] : undefined;
      const anchorRowKey = anchorRow?.key ?? null;
      if (anchorRowKey) {
        prependWindowTxnSeqRef.current += 1;
        prependWindowTxnRef.current = {
          phase: 'scheduled',
          id: prependWindowTxnSeqRef.current,
          sessionKey: sessionKeyAtSchedule,
          rowKey: anchorRowKey,
          rowOffsetPx: Math.max(0, activeViewport.scrollTop - (anchorItem?.start ?? activeViewport.scrollTop)),
          previousScrollTop: activeViewport.scrollTop,
          previousScrollHeight: activeViewport.scrollHeight,
        };
      } else {
        prependWindowTxnRef.current = { phase: 'idle' };
      }
      const currentLimit = getSessionRenderableWindowLimit(sessionKeyAtSchedule);
      updateSessionRenderableWindowLimit(sessionKeyAtSchedule, currentLimit + SESSION_RENDER_WINDOW_EXPAND_STEP);
      expandWindowArmedRef.current = false;
      setRenderWindowVersion((value) => value + 1);
    }, SESSION_RENDER_WINDOW_EXPAND_DEBOUNCE_MS);
  }, [
    chatRows,
    currentSessionKey,
    hasOlderRenderableRows,
    messageVirtualizer,
    scrollState.command.type,
    scrollState.mode,
  ]);
  const handleViewportScrollWithWindowing = useCallback(() => {
    handleViewportScroll();
    maybeExpandRenderableWindow();
  }, [handleViewportScroll, maybeExpandRenderableWindow]);

  const scrollToRowKey = useCallback((rowKey?: string) => {
    if (!rowKey) {
      return;
    }
    const targetIndex = chatRows.findIndex((row) => row.key === rowKey);
    if (targetIndex < 0) {
      return;
    }
    messageVirtualizer.scrollToIndex(targetIndex, { align: 'start' });
  }, [chatRows, messageVirtualizer]);
  const currentAgentId = parseAgentIdFromSessionKey(currentSessionKey);
  const currentAgent = agents.find((item) => item.id === currentAgentId);
  const availableSkillOptions = useMemo<AgentSkillOption[]>(
    () => skills
      .filter((skill) => skill.enabled !== false && skill.eligible !== false)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        icon: skill.icon,
      })),
    [skills],
  );
  const availableSkillIds = useMemo(
    () => availableSkillOptions.map((skill) => skill.id),
    [availableSkillOptions],
  );
  const availableSkillSet = useMemo(
    () => new Set(availableSkillIds),
    [availableSkillIds],
  );
  const assistantAvatarEmoji = resolveAgentEmoji(
    currentAgent?.identityEmoji ?? currentAgent?.identity?.emoji,
    Boolean(currentAgent?.isDefault),
  );
  const openSkillConfigDialog = useCallback(() => {
    if (!currentAgent) {
      return;
    }
    setSkillConfigOpen(true);
    if (!skillsSnapshotReady && !skillsInitialLoading) {
      void fetchSkills();
    }
  }, [currentAgent, fetchSkills, skillsInitialLoading, skillsSnapshotReady]);

  useEffect(() => {
    if (!skillConfigOpen || !currentAgent) {
      return;
    }
    const currentSkills = Array.isArray(currentAgent.skills)
      ? currentAgent.skills
      : availableSkillIds;
    const normalized = Array.from(new Set(currentSkills.filter((id) => availableSkillSet.has(id))));
    setSelectedSkillIds(normalized);
  }, [availableSkillIds, availableSkillSet, currentAgent, skillConfigOpen]);

  const handleSaveSkillConfig = useCallback(async () => {
    if (!currentAgent) {
      return;
    }
    setSkillConfigSaving(true);
    try {
      await updateAgent({
        agentId: currentAgent.id,
        name: currentAgent.name || currentAgent.id,
        workspace: currentAgent.workspace ?? '',
        model: currentAgent.model,
        skills: selectedSkillIds,
      });
      setSkillConfigOpen(false);
    } finally {
      setSkillConfigSaving(false);
    }
  }, [currentAgent, selectedSkillIds, updateAgent]);

  // Gateway not running
  if (!isGatewayRunning) {
    return (
      <div className="flex h-[calc(100vh-8rem)] flex-col items-center justify-center text-center p-8">
        <AlertCircle className="h-12 w-12 text-yellow-500 mb-4" />
        <h2 className="text-xl font-semibold mb-2">{t('gatewayNotRunning')}</h2>
        <p className="text-muted-foreground max-w-md">
          {t('gatewayRequired')}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={chatLayoutRef}
      className={cn(
        'grid h-full min-h-0 grid-cols-1 overflow-hidden xl:[grid-template-columns:minmax(0,1fr)_var(--task-inbox-resizer-width)_var(--task-inbox-width)]',
        taskInboxCollapsed ? 'xl:[grid-template-columns:minmax(0,1fr)_52px]' : '',
      )}
      style={{
        ['--task-inbox-width' as string]: `${taskInboxWidth}px`,
        ['--task-inbox-resizer-width' as string]: `${taskInboxResizerWidth}px`,
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
        <ChatHeaderBar
          showBackgroundStatus={showBackgroundStatus}
          refreshing={refreshing}
          hasCurrentAgent={Boolean(currentAgent)}
          onOpenSkillConfig={openSkillConfigDialog}
          skillConfigLabel={t('toolbar.skillConfig')}
          statusRefreshingLabel={t('status.refreshing')}
          statusMutatingLabel={t('status.mutating')}
        />

        <div className="relative min-h-0 flex-1">
          <div
            ref={messagesViewportRef}
            className={cn(
              'h-full overflow-y-auto px-4 py-4 md:px-6',
              isEmptyState && 'px-6 py-10 md:px-10 md:py-14',
            )}
            onPointerDownCapture={handleViewportPointerDown}
            onScroll={handleViewportScrollWithWindowing}
            onTouchMoveCapture={handleViewportTouchMove}
            onWheelCapture={handleViewportWheel}
          >
            <div className={cn('mx-auto max-w-4xl', isEmptyState && 'flex min-h-full max-w-5xl items-start justify-center')}>
              {showBlockingLoading ? (
                <div className="flex h-full items-center justify-center py-20">
                  <LoadingSpinner size="lg" />
                </div>
              ) : isEmptyState ? (
                <WelcomeScreen />
              ) : (
                <div
                  ref={messageContentRef}
                  className="relative w-full"
                  style={{ height: messageVirtualizer.getTotalSize() }}
                >
                  {virtualMessageItems.map((virtualItem) => {
                    const row = chatRows[virtualItem.index];
                    if (!row) {
                      return null;
                    }
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        data-chat-row-key={row.key}
                        ref={messageVirtualizer.measureElement}
                        className="absolute left-0 top-0 w-full pb-4"
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <ChatRowItem
                          row={row}
                          showThinking={showThinking}
                          assistantAvatarEmoji={assistantAvatarEmoji}
                          userAvatarImageUrl={userAvatarDataUrl}
                          suppressedToolCardRowKeys={suppressedToolCardRowKeys}
                          onJumpToRowKey={scrollToRowKey}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {error && (
          <ChatErrorBanner
            error={error}
            dismissLabel={t('common:actions.dismiss')}
            onDismiss={clearError}
          />
        )}

        {waitingApproval && (
          <ChatApprovalDock
            waitingLabel={t('approval.waitingLabel')}
            approvals={currentPendingApprovals}
            onResolve={(id, decision) => void resolveApproval(id, decision)}
          />
        )}

        <ChatInput
          layout={isEmptyState ? 'hero' : 'dock'}
          onSend={sendMessage}
          onStop={abortRun}
          disabled={!isGatewayRunning}
          sending={sending}
          approvalWaiting={waitingApproval}
        />

        <AgentSkillConfigDialog
          open={skillConfigOpen}
          title={t('skillConfigDialog.titleWithAgent', { agent: currentAgent?.name || currentAgentId })}
          skillOptions={availableSkillOptions}
          skillsLoading={!skillsSnapshotReady && skillsInitialLoading}
          selectedSkillIds={selectedSkillIds}
          submitting={skillConfigSaving}
          onToggleSkill={(skillId, checked) => {
            setSelectedSkillIds((prev) => {
              if (checked) {
                if (prev.includes(skillId)) {
                  return prev;
                }
                return [...prev, skillId];
              }
              return prev.filter((id) => id !== skillId);
            });
          }}
          onClose={() => setSkillConfigOpen(false)}
          onSubmit={() => {
            void handleSaveSkillConfig();
          }}
        />
      </div>

      {!taskInboxCollapsed && (
        <VerticalPaneResizer
          testId="chat-right-resizer"
          className="hidden xl:block"
          onMouseDown={startTaskInboxResize}
          ariaLabel="Resize task inbox"
          variant="subtle-border"
        />
      )}

      <TaskInboxPanel
        collapsed={taskInboxCollapsed}
        onToggleCollapse={() => setTaskInboxCollapsed((prev) => !prev)}
      />
    </div>
  );
}

export default Chat;

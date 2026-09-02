import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useChatStore } from '@/stores/chat';
import { isSessionRuntimeEndpointReady, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { hasSessionCatalogLoaded } from '@/stores/chat/session-helpers';
import { buildRuntimeScopeKey, sameRuntimeEndpointScope } from '@/stores/chat/session-identity';
import { getSessionItemCount } from '@/stores/chat/store-state-helpers';
import { useSubagentsStore } from '@/stores/subagents';
import type { ChatHistoryLoadRequest } from '@/stores/chat/types';

const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
const SESSION_CATALOG_TTL_MS = 15_000;
const HISTORY_IDLE_LOAD_TIMEOUT_MS = 1000;
const RESOURCE_RETRY_DELAY_MS = 1500;
const RESOURCE_RETRY_MAX_ATTEMPTS = 2;
const SESSION_RUNTIME_EVENT_REFRESH_DELAY_MS = 120;

type IdleTaskHandle = number | ReturnType<typeof setTimeout>;

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

function sortedSessionRuntimeEndpointScopeKeys(): string[] {
  return useRuntimeEndpointsStore.getState().endpoints
    .filter(isSessionRuntimeEndpointReady)
    .map((endpoint) => buildRuntimeScopeKey(endpoint.endpointRef))
    .sort();
}

function sameRuntimeEndpointScopeKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function hasReadySessionRuntimeCatalog(): boolean {
  const catalog = useChatStore.getState().sessionRuntimeCatalog;
  return catalog.status === 'ready'
    && catalog.endpoints.length > 0
    && catalog.defaultSessionPromptScope != null;
}

function shouldRefreshSessionRuntimeCatalog(): boolean {
  const catalog = useChatStore.getState().sessionRuntimeCatalog;
  if (!hasReadySessionRuntimeCatalog()) {
    return true;
  }
  if (useRuntimeEndpointsStore.getState().status !== 'ready') {
    return false;
  }
  return !sameRuntimeEndpointScopeKeys(
    sortedSessionRuntimeEndpointScopeKeys(),
    catalog.endpoints.map((endpoint) => buildRuntimeScopeKey(endpoint.endpoint)).sort(),
  );
}

function shouldLoadSubagentsSnapshot(): boolean {
  const { agentsResource } = useSubagentsStore.getState();
  return !agentsResource.hasLoadedOnce
    || agentsResource.data.length === 0
    || !agentsResource.lastLoadedAt
    || (Date.now() - agentsResource.lastLoadedAt) > SUBAGENTS_SNAPSHOT_TTL_MS;
}

function shouldLoadSidebarAgentCatalog(): boolean {
  const catalog = useChatStore.getState().sessionRuntimeCatalog;
  return catalog.status === 'ready'
    && catalog.endpoints.some((endpoint) => endpoint.agentCatalog.source === 'subagent-management');
}

function shouldLoadSelectedSidebarAgentCatalog(): boolean {
  const state = useChatStore.getState();
  const endpoint = state.currentConversation?.endpoint
    ?? state.sessionRuntimeCatalog.defaultSessionPromptScope?.endpoint
    ?? null;
  if (!endpoint || state.sessionRuntimeCatalog.status !== 'ready') {
    return false;
  }
  return state.sessionRuntimeCatalog.endpoints.some((target) => (
    target.agentCatalog.source === 'subagent-management'
    && sameRuntimeEndpointScope(target.endpoint, endpoint)
  ));
}

function shouldLoadSelectedSessionCatalog(): boolean {
  const state = useChatStore.getState();
  if (state.sessionCatalogStatus.status === 'loading') {
    return false;
  }
  if (state.sessionCatalogStatus.status === 'error') {
    return true;
  }
  const endpoint = state.currentConversation?.endpoint
    ?? state.sessionRuntimeCatalog.defaultSessionPromptScope?.endpoint
    ?? null;
  if (!endpoint || state.sessionRuntimeCatalog.status !== 'ready') {
    return !hasSessionCatalogLoaded(state);
  }
  const runtimeScopeKey = buildRuntimeScopeKey(endpoint);
  const loadedAt = state.sessionCatalogLoadedAtByRuntimeScopeKey[runtimeScopeKey];
  if (!loadedAt || (Date.now() - loadedAt) > SESSION_CATALOG_TTL_MS) {
    return true;
  }
  const loadedRevision = state.sessionCatalogLoadedRevisionByRuntimeScopeKey[runtimeScopeKey] ?? 0;
  const endpointRevision = useRuntimeEndpointsStore.getState().revisionByRuntimeScopeKey[runtimeScopeKey] ?? 0;
  return endpointRevision > loadedRevision;
}

function resolveSessionQueryTarget(sessionParam: string): string | null {
  const state = useChatStore.getState();
  for (const [recordKey, record] of Object.entries(state.loadedSessions)) {
    if (!record.meta.sessionIdentity) {
      continue;
    }
    if (recordKey === sessionParam
      || record.meta.sessionIdentity.sessionKey === sessionParam) {
      return recordKey;
    }
  }
  return null;
}

interface UseChatInitInput {
  isActive: boolean;
  locationSearch: string;
  navigate: NavigateFunction;
  switchSession: (sessionKey: string) => void;
  openAgentConversation: (agentId: string) => void;
  bootstrapSessionRuntime: () => Promise<void>;
  loadAgents: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  cleanupEmptySession: () => void;
}

export function useChatInit(input: UseChatInitInput): void {
  const {
    isActive,
    locationSearch,
    navigate,
    switchSession,
    openAgentConversation,
    bootstrapSessionRuntime,
    loadAgents,
    loadSessions,
    loadHistory,
    cleanupEmptySession,
  } = input;

  const initialHistoryIdleHandleRef = useRef<IdleTaskHandle | null>(null);
  const agentsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRuntimeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRuntimeEventRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRuntimeResourceEnsureScheduledRef = useRef(false);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let sessionRuntimeLoadInFlight = false;
    let sessionRuntimeNextEventRefreshAt = 0;
    const shouldRetryAgentsAfterLoad = () => {
      const { agentsResource } = useSubagentsStore.getState();
      return !agentsResource.hasLoadedOnce;
    };
    const shouldRetrySessionsAfterLoad = () => {
      return shouldLoadSelectedSessionCatalog();
    };
    const scheduleAgentsRetry = (attempt = 1) => {
      if (cancelled || attempt > RESOURCE_RETRY_MAX_ATTEMPTS) {
        return;
      }
      agentsRetryTimerRef.current = setTimeout(() => {
        if (cancelled) {
          return;
        }
        void loadAgents().finally(() => {
          if (shouldRetryAgentsAfterLoad()) {
            scheduleAgentsRetry(attempt + 1);
          }
        });
      }, RESOURCE_RETRY_DELAY_MS);
    };
    const scheduleSessionsRetry = (attempt = 1) => {
      if (cancelled || attempt > RESOURCE_RETRY_MAX_ATTEMPTS || sessionsRetryTimerRef.current) {
        return;
      }
      sessionsRetryTimerRef.current = setTimeout(() => {
        sessionsRetryTimerRef.current = null;
        if (cancelled) {
          return;
        }
        void loadSessions().finally(() => {
          if (shouldRetrySessionsAfterLoad()) {
            scheduleSessionsRetry(attempt + 1);
          }
        });
      }, RESOURCE_RETRY_DELAY_MS);
    };
    const params = new URLSearchParams(locationSearch);
    const sessionParam = params.get('session')?.trim() ?? '';
    const agentParam = params.get('agent')?.trim() ?? '';

    const runInitialLoad = async (sessionRuntimeAttempt = 0): Promise<void> => {
      if (cancelled || sessionRuntimeLoadInFlight) {
        return;
      }
      sessionRuntimeLoadInFlight = true;
      try {
        const shouldLoadAgents = shouldLoadSubagentsSnapshot();
        await bootstrapSessionRuntime();
        if (cancelled) {
          return;
        }
        if (useChatStore.getState().sessionRuntimeCatalog.status !== 'ready') {
          if (sessionRuntimeAttempt >= RESOURCE_RETRY_MAX_ATTEMPTS) {
            return;
          }
          sessionRuntimeRetryTimerRef.current = setTimeout(() => {
            sessionRuntimeRetryTimerRef.current = null;
            if (cancelled) {
              return;
            }
            void runInitialLoad(sessionRuntimeAttempt + 1);
          }, RESOURCE_RETRY_DELAY_MS);
          return;
        }
        const shouldLoadSidebarAgents = shouldLoadAgents && shouldLoadSidebarAgentCatalog();
        const agentsLoadTask = shouldLoadSidebarAgents ? loadAgents() : Promise.resolve();
        const shouldLoadSessions = shouldLoadSelectedSessionCatalog();
        const sessionsLoadTask = shouldLoadSessions ? loadSessions() : Promise.resolve();
        await Promise.all([agentsLoadTask, sessionsLoadTask]);
        if (cancelled) return;
        let switchedViaQueryParam = false;
        if (sessionParam) {
          const targetSessionKey = resolveSessionQueryTarget(sessionParam);
          if (targetSessionKey) {
            switchSession(targetSessionKey);
            navigate('/', { replace: true });
            switchedViaQueryParam = true;
          }
        }
        if (!switchedViaQueryParam && agentParam) {
          openAgentConversation(agentParam);
          navigate('/', { replace: true });
          switchedViaQueryParam = true;
        }
        if (shouldLoadSidebarAgents && shouldRetryAgentsAfterLoad()) {
          scheduleAgentsRetry();
        }
        if (shouldLoadSessions && shouldRetrySessionsAfterLoad()) {
          scheduleSessionsRetry();
        }
        if (switchedViaQueryParam) {
          return;
        }
        const currentChatState = useChatStore.getState();
        const currentConversation = currentChatState.currentConversation;
        if (currentConversation?.kind !== 'session' || !currentConversation.sessionRecordKey) {
          return;
        }
        const currentSessionRecord = currentChatState.loadedSessions[currentConversation.sessionRecordKey];
        const hasCurrentViewportSnapshot = (
          currentSessionRecord?.meta.historyStatus === 'ready'
          || getSessionItemCount(currentSessionRecord) > 0
        );
        if (hasCurrentViewportSnapshot) {
          initialHistoryIdleHandleRef.current = scheduleIdleTask(() => {
            initialHistoryIdleHandleRef.current = null;
            if (cancelled) {
              return;
            }
            const latestConversation = useChatStore.getState().currentConversation;
            if (latestConversation?.kind !== 'session' || !latestConversation.sessionRecordKey) {
              return;
            }
            void loadHistory({
              sessionKey: latestConversation.sessionRecordKey,
              mode: 'quiet',
              scope: 'foreground',
              reason: 'chat_init_snapshot_quiet_refresh',
            });
          });
          return;
        }
        await loadHistory({
          sessionKey: currentConversation.sessionRecordKey,
          mode: 'active',
          scope: 'foreground',
          reason: 'chat_init_cold_start',
        });
      } finally {
        sessionRuntimeLoadInFlight = false;
      }
    };

    const ensureSelectedRuntimeSidebarResources = async (): Promise<void> => {
      const agentsLoadTask = shouldLoadSubagentsSnapshot() && shouldLoadSelectedSidebarAgentCatalog()
        ? loadAgents()
        : Promise.resolve();
      const shouldLoadSessions = shouldLoadSelectedSessionCatalog();
      const sessionsLoadTask = shouldLoadSessions ? loadSessions() : Promise.resolve();
      await Promise.all([agentsLoadTask, sessionsLoadTask]);
      if (!cancelled && shouldLoadSessions && shouldRetrySessionsAfterLoad()) {
        scheduleSessionsRetry();
      }
    };

    const refreshSessionRuntimeCatalogFromEvent = async (): Promise<void> => {
      if (!hasReadySessionRuntimeCatalog()) {
        await runInitialLoad();
        return;
      }
      if (cancelled || sessionRuntimeLoadInFlight) {
        return;
      }
      sessionRuntimeLoadInFlight = true;
      try {
        await bootstrapSessionRuntime();
        if (cancelled) {
          return;
        }
        await ensureSelectedRuntimeSidebarResources();
      } finally {
        sessionRuntimeLoadInFlight = false;
      }
    };

    const scheduleSelectedRuntimeResourceEnsure = () => {
      if (cancelled || selectedRuntimeResourceEnsureScheduledRef.current) {
        return;
      }
      selectedRuntimeResourceEnsureScheduledRef.current = true;
      queueMicrotask(() => {
        selectedRuntimeResourceEnsureScheduledRef.current = false;
        if (cancelled || sessionRuntimeLoadInFlight) {
          return;
        }
        void ensureSelectedRuntimeSidebarResources();
      });
    };

    const scheduleSessionRuntimeEventRefresh = () => {
      const now = Date.now();
      if (cancelled
        || now < sessionRuntimeNextEventRefreshAt
        || sessionRuntimeEventRefreshTimerRef.current
        || (!shouldRefreshSessionRuntimeCatalog() && !shouldLoadSelectedSessionCatalog())) {
        return;
      }
      sessionRuntimeNextEventRefreshAt = now + RESOURCE_RETRY_DELAY_MS;
      sessionRuntimeEventRefreshTimerRef.current = setTimeout(() => {
        sessionRuntimeEventRefreshTimerRef.current = null;
        if (cancelled || sessionRuntimeLoadInFlight || (!shouldRefreshSessionRuntimeCatalog() && !shouldLoadSelectedSessionCatalog())) {
          return;
        }
        if (sessionRuntimeRetryTimerRef.current != null) {
          clearTimeout(sessionRuntimeRetryTimerRef.current);
          sessionRuntimeRetryTimerRef.current = null;
        }
        void refreshSessionRuntimeCatalogFromEvent();
      }, SESSION_RUNTIME_EVENT_REFRESH_DELAY_MS);
    };
    useRuntimeEndpointsStore.getState().init();
    const unsubscribeRuntimeEndpoints = useRuntimeEndpointsStore.subscribe((state, previousState) => {
      if (state.revision !== previousState.revision) {
        scheduleSessionRuntimeEventRefresh();
      }
    });
    const unsubscribeChatRuntimeSelection = useChatStore.subscribe((state, previousState) => {
      if (state.currentConversation?.runtimeScopeKey !== previousState.currentConversation?.runtimeScopeKey) {
        scheduleSelectedRuntimeResourceEnsure();
      }
    });
    void runInitialLoad();

    return () => {
      cancelled = true;
      if (initialHistoryIdleHandleRef.current != null) {
        cancelIdleTask(initialHistoryIdleHandleRef.current);
        initialHistoryIdleHandleRef.current = null;
      }
      if (agentsRetryTimerRef.current != null) {
        clearTimeout(agentsRetryTimerRef.current);
        agentsRetryTimerRef.current = null;
      }
      if (sessionsRetryTimerRef.current != null) {
        clearTimeout(sessionsRetryTimerRef.current);
        sessionsRetryTimerRef.current = null;
      }
      if (sessionRuntimeRetryTimerRef.current != null) {
        clearTimeout(sessionRuntimeRetryTimerRef.current);
        sessionRuntimeRetryTimerRef.current = null;
      }
      if (sessionRuntimeEventRefreshTimerRef.current != null) {
        clearTimeout(sessionRuntimeEventRefreshTimerRef.current);
        sessionRuntimeEventRefreshTimerRef.current = null;
      }
      selectedRuntimeResourceEnsureScheduledRef.current = false;
      unsubscribeRuntimeEndpoints();
      unsubscribeChatRuntimeSelection();
      cleanupEmptySession();
    };
  }, [
    bootstrapSessionRuntime,
    cleanupEmptySession,
    isActive,
    loadAgents,
    loadHistory,
    loadSessions,
    locationSearch,
    navigate,
    openAgentConversation,
    switchSession,
  ]);
}

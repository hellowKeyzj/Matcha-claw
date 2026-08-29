import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useChatStore } from '@/stores/chat';
import { isSessionRuntimeEndpointReady, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { hasSessionCatalogLoaded } from '@/stores/chat/session-helpers';
import { getSessionItemCount } from '@/stores/chat/store-state-helpers';
import { useSubagentsStore } from '@/stores/subagents';
import type { ChatHistoryLoadRequest } from '@/stores/chat/types';

const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
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

function sortedSessionRuntimeEndpointIds(): string[] {
  return useRuntimeEndpointsStore.getState().endpoints
    .filter(isSessionRuntimeEndpointReady)
    .map((endpoint) => endpoint.id)
    .sort();
}

function sameRuntimeEndpointIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function shouldRefreshSessionRuntimeCatalog(): boolean {
  const catalog = useChatStore.getState().sessionRuntimeCatalog;
  if (catalog.status !== 'ready'
    || catalog.endpoints.length === 0
    || catalog.defaultSessionPromptScope == null) {
    return true;
  }
  if (useRuntimeEndpointsStore.getState().status !== 'ready') {
    return false;
  }
  return !sameRuntimeEndpointIds(
    sortedSessionRuntimeEndpointIds(),
    catalog.endpoints.map((endpoint) => endpoint.endpointId).sort(),
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
      return !hasSessionCatalogLoaded(useChatStore.getState());
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
      if (cancelled || attempt > RESOURCE_RETRY_MAX_ATTEMPTS) {
        return;
      }
      sessionsRetryTimerRef.current = setTimeout(() => {
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
        const sessionsLoadTask = loadSessions();
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
        if (shouldRetrySessionsAfterLoad()) {
          scheduleSessionsRetry();
        }
        if (switchedViaQueryParam) {
          return;
        }
        const currentChatState = useChatStore.getState();
        if (!currentChatState.currentSessionKey) {
          return;
        }
        const currentSessionRecord = currentChatState.loadedSessions[currentChatState.currentSessionKey];
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
            void loadHistory({
              sessionKey: useChatStore.getState().currentSessionKey,
              mode: 'quiet',
              scope: 'foreground',
              reason: 'chat_init_snapshot_quiet_refresh',
            });
          });
          return;
        }
        await loadHistory({
          sessionKey: useChatStore.getState().currentSessionKey,
          mode: 'active',
          scope: 'foreground',
          reason: 'chat_init_cold_start',
        });
      } finally {
        sessionRuntimeLoadInFlight = false;
      }
    };

    const scheduleSessionRuntimeEventRefresh = () => {
      const now = Date.now();
      if (cancelled
        || now < sessionRuntimeNextEventRefreshAt
        || sessionRuntimeEventRefreshTimerRef.current
        || !shouldRefreshSessionRuntimeCatalog()) {
        return;
      }
      sessionRuntimeNextEventRefreshAt = now + RESOURCE_RETRY_DELAY_MS;
      sessionRuntimeEventRefreshTimerRef.current = setTimeout(() => {
        sessionRuntimeEventRefreshTimerRef.current = null;
        if (cancelled || sessionRuntimeLoadInFlight || !shouldRefreshSessionRuntimeCatalog()) {
          return;
        }
        if (sessionRuntimeRetryTimerRef.current != null) {
          clearTimeout(sessionRuntimeRetryTimerRef.current);
          sessionRuntimeRetryTimerRef.current = null;
        }
        void runInitialLoad();
      }, SESSION_RUNTIME_EVENT_REFRESH_DELAY_MS);
    };
    useRuntimeEndpointsStore.getState().init();
    const unsubscribeRuntimeEndpoints = useRuntimeEndpointsStore.subscribe((state, previousState) => {
      if (state.status !== previousState.status || state.endpoints !== previousState.endpoints) {
        scheduleSessionRuntimeEventRefresh();
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
      unsubscribeRuntimeEndpoints();
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

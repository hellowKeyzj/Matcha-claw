import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useChatStore } from '@/stores/chat';
import { hasSessionCatalogLoaded } from '@/stores/chat/session-helpers';
import { getSessionItemCount } from '@/stores/chat/store-state-helpers';
import { useSubagentsStore } from '@/stores/subagents';
import type { ChatHistoryLoadRequest } from '@/stores/chat/types';

const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
const HISTORY_IDLE_LOAD_TIMEOUT_MS = 1000;
const RESOURCE_RETRY_DELAY_MS = 1500;
const RESOURCE_RETRY_MAX_ATTEMPTS = 2;

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

interface UseChatInitInput {
  isActive: boolean;
  isGatewayRunning: boolean;
  locationSearch: string;
  navigate: NavigateFunction;
  switchSession: (sessionKey: string) => void;
  openAgentConversation: (agentId: string) => void;
  loadAgents: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  cleanupEmptySession: () => void;
}

export function useChatInit(input: UseChatInitInput): void {
  const {
    isActive,
    isGatewayRunning,
    locationSearch,
    navigate,
    switchSession,
    openAgentConversation,
    loadAgents,
    loadSessions,
    loadHistory,
    cleanupEmptySession,
  } = input;

  const initialHistoryIdleHandleRef = useRef<IdleTaskHandle | null>(null);
  const agentsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isActive || !isGatewayRunning) return;
    let cancelled = false;
    const scheduleAgentsRetry = (attempt = 1) => {
      if (cancelled || attempt > RESOURCE_RETRY_MAX_ATTEMPTS) {
        return;
      }
      agentsRetryTimerRef.current = setTimeout(() => {
        if (cancelled) {
          return;
        }
        void loadAgents().finally(() => {
          const { agentsResource } = useSubagentsStore.getState();
          if (!agentsResource.hasLoadedOnce) {
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
          if (!hasSessionCatalogLoaded(useChatStore.getState())) {
            scheduleSessionsRetry(attempt + 1);
          }
        });
      }, RESOURCE_RETRY_DELAY_MS);
    };
    const params = new URLSearchParams(locationSearch);
    const sessionParam = params.get('session')?.trim() ?? '';
    const agentParam = params.get('agent')?.trim() ?? '';
    const switchedViaQueryParam = Boolean(sessionParam || agentParam);
    if (sessionParam) {
      switchSession(sessionParam);
      navigate('/', { replace: true });
    } else if (agentParam) {
      openAgentConversation(agentParam);
      navigate('/', { replace: true });
    }

    (async () => {
      const subagentsState = useSubagentsStore.getState();
      const shouldRetryAgentsAfterLoad = () => {
        const { agentsResource } = useSubagentsStore.getState();
        return !agentsResource.hasLoadedOnce;
      };
      const shouldRetrySessionsAfterLoad = () => {
        return !hasSessionCatalogLoaded(useChatStore.getState());
      };
      const shouldLoadAgents = (
        !subagentsState.agentsResource.hasLoadedOnce
        || subagentsState.agentsResource.data.length === 0
        || !subagentsState.agentsResource.lastLoadedAt
        || (Date.now() - subagentsState.agentsResource.lastLoadedAt) > SUBAGENTS_SNAPSHOT_TTL_MS
      );
      const agentsLoadTask = shouldLoadAgents ? loadAgents() : Promise.resolve();
      const sessionsLoadTask = loadSessions();
      await Promise.all([agentsLoadTask, sessionsLoadTask]);
      if (shouldLoadAgents && shouldRetryAgentsAfterLoad()) {
        scheduleAgentsRetry();
      }
      if (shouldRetrySessionsAfterLoad()) {
        scheduleSessionsRetry();
      }
      if (cancelled) return;
      if (switchedViaQueryParam) {
        return;
      }
      const currentChatState = useChatStore.getState();
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
    })();

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
      cleanupEmptySession();
    };
  }, [
    cleanupEmptySession,
    isActive,
    isGatewayRunning,
    loadAgents,
    loadHistory,
    loadSessions,
    locationSearch,
    navigate,
    openAgentConversation,
    switchSession,
  ]);
}

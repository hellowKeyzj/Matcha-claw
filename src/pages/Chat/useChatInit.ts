import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useChatStore } from '@/stores/chat';
import { useSubagentsStore } from '@/stores/subagents';

const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
const HISTORY_IDLE_LOAD_TIMEOUT_MS = 1000;

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
  isGatewayRunning: boolean;
  locationSearch: string;
  navigate: NavigateFunction;
  switchSession: (sessionKey: string) => void;
  openAgentConversation: (agentId: string) => void;
  loadAgents: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadHistory: (quiet?: boolean) => Promise<void>;
  cleanupEmptySession: () => void;
}

export function useChatInit(input: UseChatInitInput): void {
  const {
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

  useEffect(() => {
    if (!isGatewayRunning) return;
    let cancelled = false;
    const hasExistingMessages = useChatStore.getState().messages.length > 0;
    const params = new URLSearchParams(locationSearch);
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
      cleanupEmptySession();
    };
  }, [
    cleanupEmptySession,
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

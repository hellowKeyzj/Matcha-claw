import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { trackUiEvent } from '@/lib/telemetry';
import { useChatStore } from '@/stores/chat';
import { useSubagentsStore } from '@/stores/subagents';
import type { ChatHistoryLoadRequest } from '@/stores/chat/types';

const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
const HISTORY_IDLE_LOAD_TIMEOUT_MS = 1000;
const HISTORY_PREWARM_MAX_SESSIONS = 6;

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

function collectSessionPrewarmTargets(limit: number): string[] {
  const state = useChatStore.getState();
  const currentSessionKey = state.currentSessionKey;
  const rankedSessionKeys = state.sessions
    .map((session) => session.key)
    .filter((sessionKey) => sessionKey && sessionKey !== currentSessionKey)
    .filter((sessionKey) => {
      if (state.sessionReadyByKey[sessionKey]) {
        return false;
      }
      const runtime = state.sessionRuntimeByKey[sessionKey];
      return !runtime || runtime.messages.length === 0;
    })
    .sort((leftKey, rightKey) => (
      (state.sessionLastActivity[rightKey] ?? 0) - (state.sessionLastActivity[leftKey] ?? 0)
    ));
  return rankedSessionKeys.slice(0, limit);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown_error';
}

interface UseChatInitInput {
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
  const historyPrewarmIdleHandleRef = useRef<IdleTaskHandle | null>(null);

  useEffect(() => {
    if (!isGatewayRunning) return;
    let cancelled = false;
    const scheduleSessionHistoryPrewarm = () => {
      const sessionKeys = collectSessionPrewarmTargets(HISTORY_PREWARM_MAX_SESSIONS);
      trackUiEvent('chat.history_prewarm_plan', {
        currentSessionKey: useChatStore.getState().currentSessionKey,
        targetCount: sessionKeys.length,
        targets: sessionKeys,
      });
      if (sessionKeys.length === 0) {
        return;
      }
      let cursor = 0;
      const runNext = () => {
        if (cancelled || cursor >= sessionKeys.length) {
          historyPrewarmIdleHandleRef.current = null;
          return;
        }
        const sessionKey = sessionKeys[cursor];
        const queueIndex = cursor + 1;
        cursor += 1;
        trackUiEvent('chat.history_prewarm_dispatch', {
          sessionKey,
          queueIndex,
          plannedCount: sessionKeys.length,
        });
        void loadHistory({
          sessionKey,
          mode: 'quiet',
          scope: 'background',
          reason: 'chat_init_session_prewarm',
        }).then(() => {
          trackUiEvent('chat.history_prewarm_done', {
            sessionKey,
            queueIndex,
            plannedCount: sessionKeys.length,
          });
        }).catch((error: unknown) => {
          trackUiEvent('chat.history_prewarm_failed', {
            sessionKey,
            queueIndex,
            plannedCount: sessionKeys.length,
            error: toErrorMessage(error),
          });
        });
        historyPrewarmIdleHandleRef.current = scheduleIdleTask(runNext, HISTORY_IDLE_LOAD_TIMEOUT_MS);
      };
      historyPrewarmIdleHandleRef.current = scheduleIdleTask(runNext, HISTORY_IDLE_LOAD_TIMEOUT_MS);
    };
    const hasExistingMessages = useChatStore.getState().messages.length > 0;
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
      if (switchedViaQueryParam) {
        scheduleSessionHistoryPrewarm();
        return;
      }
      if (hasExistingMessages) {
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
          scheduleSessionHistoryPrewarm();
        });
        return;
      }
      await loadHistory({
        sessionKey: useChatStore.getState().currentSessionKey,
        mode: 'active',
        scope: 'foreground',
        reason: 'chat_init_cold_start',
      });
      if (!cancelled) {
        scheduleSessionHistoryPrewarm();
      }
    })();

    return () => {
      cancelled = true;
      if (initialHistoryIdleHandleRef.current != null) {
        cancelIdleTask(initialHistoryIdleHandleRef.current);
        initialHistoryIdleHandleRef.current = null;
      }
      if (historyPrewarmIdleHandleRef.current != null) {
        cancelIdleTask(historyPrewarmIdleHandleRef.current);
        historyPrewarmIdleHandleRef.current = null;
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

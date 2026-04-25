import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { trackUiEvent } from '@/lib/telemetry';
import { useChatStore } from '@/stores/chat';
import {
  readSessionsFromState,
  resolveSessionActivityMs,
} from '@/stores/chat/session-helpers';
import { getSessionMeta, getSessionTranscript } from '@/stores/chat/store-state-helpers';
import { useSubagentsStore } from '@/stores/subagents';
import type { ChatHistoryLoadRequest } from '@/stores/chat/types';

const SUBAGENTS_SNAPSHOT_TTL_MS = 15_000;
const HISTORY_IDLE_LOAD_TIMEOUT_MS = 1000;
const HISTORY_PREWARM_MAX_SESSIONS = 6;
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

function collectSessionPrewarmTargets(limit: number): string[] {
  const state = useChatStore.getState();
  const currentSessionKey = state.currentSessionKey;
  const rankedSessionKeys = readSessionsFromState(state)
    .filter((session) => session.key && session.key !== currentSessionKey)
    .filter((session) => {
      const meta = getSessionMeta(state, session.key);
      if (meta.ready) {
        return false;
      }
      return getSessionTranscript(state, session.key).length === 0;
    })
    .sort((left, right) => (
      resolveSessionActivityMs(right, state.sessionsByKey) - resolveSessionActivityMs(left, state.sessionsByKey)
    ))
    .map((session) => session.key);
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
  const agentsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isGatewayRunning) return;
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
          const { sessionsResource } = useChatStore.getState();
          if (!sessionsResource.hasLoadedOnce) {
            scheduleSessionsRetry(attempt + 1);
          }
        });
      }, RESOURCE_RETRY_DELAY_MS);
    };
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
    const hasExistingMessages = getSessionTranscript(
      useChatStore.getState(),
      useChatStore.getState().currentSessionKey,
    ).length > 0;
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
        const { sessionsResource } = useChatStore.getState();
        return !sessionsResource.hasLoadedOnce;
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

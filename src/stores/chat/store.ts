/**
 * Chat State Store
 * Manages chat messages, sessions, streaming, and thinking state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from '../gateway';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import {
  normalizeApprovalDecision,
  normalizeApprovalTimestampMs,
  parseGatewayApprovalResponse,
  resolveApprovalSessionKey,
} from './approval-helpers';
import {
  buildTaskInboxBridgeState,
  getCanonicalPrefixFromSessions,
  isTrulyEmptyNonMainSession,
  normalizeTaskInboxSessionKey,
  parseSessionUpdatedAtMs,
  resolveCanonicalPrefixForAgent,
  resolvePreferredSessionKeyForAgent,
  resolveSessionThinkingLevelFromList,
  shouldKeepMissingCurrentSession,
} from './session-helpers';
import {
  createIntermediateToolTurnSnapshot,
  getMessageText,
  hasAssistantToolCall,
  isInternalMessage,
  isToolOnlyMessage,
  normalizeUserTextForReconcile,
  resolveSessionLabelFromMessages,
  sanitizeIntermediateToolFillerMessage,
} from './message-helpers';
import {
  cacheSendAttachments,
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  getToolCallFilePath,
  hasPendingPreviewLoads,
  hydrateAttachedFilesFromCache,
  loadMissingPreviews,
  makeAttachedFile,
} from './attachment-helpers';
import {
  clearPendingDeltaBatch,
  flushPendingDeltaBatch,
  queueDeltaForFrame,
} from './delta-frame-helpers';
import {
  collectToolUpdates,
  hasNonToolAssistantContent,
  isToolResultRole,
  upsertToolStatuses,
} from './runtime-event-helpers';
import { normalizeHistoryMessages } from './history-normalizer-worker-client';
import {
  buildRenderMessagesFingerprint,
  areSessionsEquivalent,
  buildHistoryFingerprint,
  buildQuickRawHistoryFingerprint,
  createEmptySessionRuntime,
  hasTimeoutSignal,
  isRecoverableChatSendTimeout,
  resolveSessionRuntime,
  snapshotCurrentSessionRuntime,
  toMs,
} from './store-state-helpers';
import {
  DEFAULT_CANONICAL_PREFIX,
  DEFAULT_SESSION_KEY,
  type ApprovalDecision,
  type ApprovalItem,
  type ApprovalStatus,
  type AttachedFileMeta,
  type ChatStoreState,
  type ChatSession,
  type ChatSendAttachment,
  type RawMessage,
  type SessionRuntimeSnapshot,
} from './types';

// ── Types ────────────────────────────────────────────────────────

// Module-level timestamp tracking the last chat event received.
// Used by the safety timeout to avoid false-positive "no response" errors
// during tool-use conversations where streamingMessage is temporarily cleared
// between tool-result finals and the next delta.
let _lastChatEventAt = 0;

function scheduleNextFrame(task: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => task());
    return;
  }
  setTimeout(task, 16);
}

function scheduleIdleTask(task: () => void, timeoutMs = 1000): void {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(() => task(), { timeout: timeoutMs });
      return;
    }
  }
  setTimeout(task, 80);
}

// Timer for fallback history polling during active sends.
// If no streaming events arrive within a few seconds, we periodically
// poll chat.history to surface intermediate tool-call turns.
let _historyPollTimer: ReturnType<typeof setTimeout> | null = null;
const CHAT_HISTORY_FULL_LIMIT = 200;
const CHAT_HISTORY_ACTIVE_PROBE_LIMIT = 10;
const CHAT_HISTORY_QUIET_PROBE_LIMIT = 64;
const CHAT_HISTORY_QUIET_FULL_LIMIT = 120;
const CHAT_HISTORY_LOADING_TIMEOUT_MS = 15_000;
const OPTIMISTIC_USER_RECONCILE_WINDOW_MS = 15_000;
const SESSION_RUNTIME_CACHE_MAX_SESSIONS = 48;
let _historyLoadRunId = 0;
let _mutatingCounter = 0;
const _historyFingerprintBySession = new Map<string, string>();
const _historyProbeFingerprintBySession = new Map<string, string>();
const _historyQuickFingerprintBySession = new Map<string, string>();
const _historyRenderFingerprintBySession = new Map<string, string>();

// Timer for delayed error finalization. When the Gateway reports a mid-stream
// error (e.g. "terminated"), it may retry internally and recover. We wait
// before committing the error to give the recovery path a chance.
let _errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

type ToolSnapshotTxnState =
  | { phase: 'idle' }
  | {
    phase: 'armed';
    sessionKey: string;
    runId: string;
    streamKey: string;
  };

let _toolSnapshotTxnState: ToolSnapshotTxnState = { phase: 'idle' };

function clearErrorRecoveryTimer(): void {
  if (_errorRecoveryTimer) {
    clearTimeout(_errorRecoveryTimer);
    _errorRecoveryTimer = null;
  }
}

function clearHistoryPoll(): void {
  if (_historyPollTimer) {
    clearTimeout(_historyPollTimer);
    _historyPollTimer = null;
  }
}

function resetToolSnapshotTxnState(): void {
  _toolSnapshotTxnState = { phase: 'idle' };
}

function resolveAssistantToolStreamKey(message: RawMessage | null | undefined): string {
  if (!message) {
    return '';
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const toolBlockIds = (blocks as Array<Record<string, unknown>>)
    .filter((block) => (
      block
      && typeof block === 'object'
      && (block.type === 'tool_use' || block.type === 'toolCall')
    ))
    .map((block) => (typeof block.id === 'string' ? block.id : ''))
    .filter(Boolean)
    .join(',');
  if (typeof message.id === 'string' && message.id.trim()) {
    return `${message.id}|${toolBlockIds}`;
  }
  return `assistant|${toolBlockIds}|${getMessageText(message.content).trim().slice(0, 120)}`;
}

function armToolSnapshotTxnState(
  sessionKey: string,
  runId: string,
  message: unknown,
): void {
  const msg = (message && typeof message === 'object') ? message as RawMessage : null;
  if (!msg) {
    return;
  }
  const role = typeof msg.role === 'string' ? msg.role : 'assistant';
  if (role !== 'assistant' || !hasAssistantToolCall(msg)) {
    return;
  }
  _toolSnapshotTxnState = {
    phase: 'armed',
    sessionKey,
    runId: runId.trim(),
    streamKey: resolveAssistantToolStreamKey(msg),
  };
}

function consumeToolSnapshotTxnState(
  sessionKey: string,
  runId: string,
  currentStream: RawMessage | null,
): boolean {
  if (_toolSnapshotTxnState.phase !== 'armed') {
    return false;
  }
  const armed = _toolSnapshotTxnState;
  const sameSession = armed.sessionKey === sessionKey;
  const normalizedRunId = runId.trim();
  const sameRun = (
    !armed.runId
    || !normalizedRunId
    || armed.runId === normalizedRunId
  );
  const hasToolCall = hasAssistantToolCall(currentStream ?? undefined);
  const streamKeyMatches = currentStream
    ? resolveAssistantToolStreamKey(currentStream) === armed.streamKey
    : false;
  const canCommit = sameSession && sameRun && hasToolCall && streamKeyMatches;
  resetToolSnapshotTxnState();
  return canCommit;
}

function normalizeAssistantFinalTextForDedup(content: unknown): string {
  return getMessageText(content)
    .replace(/^\s*(?:\[\[reply_to_[a-z0-9:_-]+\]\]\s*)+/ig, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function beginGlobalMutating(set: (next: Partial<ChatStoreState>) => void): void {
  _mutatingCounter += 1;
  if (_mutatingCounter === 1) {
    set({ mutating: true });
  }
}

function finishGlobalMutating(set: (next: Partial<ChatStoreState>) => void): void {
  _mutatingCounter = Math.max(0, _mutatingCounter - 1);
  if (_mutatingCounter === 0) {
    set({ mutating: false });
  }
}

function touchSessionRuntimeSnapshot(
  runtimeByKey: Record<string, SessionRuntimeSnapshot>,
  sessionKey: string,
  snapshot?: SessionRuntimeSnapshot,
): void {
  if (!sessionKey) {
    return;
  }
  const value = snapshot ?? runtimeByKey[sessionKey];
  if (!value) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(runtimeByKey, sessionKey)) {
    delete runtimeByKey[sessionKey];
  }
  runtimeByKey[sessionKey] = value;
}

function trimSessionRuntimeSnapshots(
  runtimeByKey: Record<string, SessionRuntimeSnapshot>,
  keepSessionKeys: string[],
): void {
  const keys = Object.keys(runtimeByKey);
  if (keys.length <= SESSION_RUNTIME_CACHE_MAX_SESSIONS) {
    return;
  }

  const keepSet = new Set(keepSessionKeys.filter((key) => typeof key === 'string' && key.trim().length > 0));
  for (const [sessionKey, runtime] of Object.entries(runtimeByKey)) {
    if (runtime?.sending) {
      keepSet.add(sessionKey);
    }
  }

  let overflow = keys.length - SESSION_RUNTIME_CACHE_MAX_SESSIONS;
  for (const sessionKey of keys) {
    if (overflow <= 0) {
      break;
    }
    if (keepSet.has(sessionKey)) {
      continue;
    }
    delete runtimeByKey[sessionKey];
    overflow -= 1;
  }

  if (overflow <= 0) {
    return;
  }

  const hardKeepSet = new Set(keepSessionKeys.filter((key) => typeof key === 'string' && key.trim().length > 0));
  for (const sessionKey of Object.keys(runtimeByKey)) {
    if (overflow <= 0) {
      break;
    }
    if (hardKeepSet.has(sessionKey)) {
      continue;
    }
    delete runtimeByKey[sessionKey];
    overflow -= 1;
  }
}

async function loadCronFallbackMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const payload = await hostApiFetch<unknown>(buildCronSessionHistoryPath(sessionKey, limit));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid cron session history payload: expected object');
    }
    const record = payload as Record<string, unknown>;
    if (!Array.isArray(record.messages)) {
      throw new Error('Invalid cron session history payload: expected messages[]');
    }
    const response: { messages: RawMessage[] } = {
      messages: record.messages as RawMessage[],
    };
    return response.messages;
  } catch (error) {
    console.warn('Failed to load cron fallback history:', error);
    return [];
  }
}

// ── Store ────────────────────────────────────────────────────────

export const useChatStore = create<ChatStoreState>((set, get) => ({
  messages: [],
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  error: null,

  sending: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
  approvalStatus: 'idle',
  pendingApprovalsBySession: {},

  sessions: [],
  currentSessionKey: DEFAULT_SESSION_KEY,
  sessionLabels: {},
  sessionLastActivity: {},
  sessionReadyByKey: {},
  sessionRuntimeByKey: {},

  showThinking: true,
  thinkingLevel: null,

  // ── Load sessions via sessions.list ──

  loadSessions: async () => {
    try {
      const data = await useGatewayStore.getState().rpc<Record<string, unknown>>('sessions.list', {});
      if (data) {
        const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
        const sessions: ChatSession[] = rawSessions.map((s: Record<string, unknown>) => ({
          key: String(s.key || ''),
          label: s.label ? String(s.label) : undefined,
          displayName: s.displayName ? String(s.displayName) : undefined,
          thinkingLevel: s.thinkingLevel ? String(s.thinkingLevel) : undefined,
          model: s.model ? String(s.model) : undefined,
          updatedAt: parseSessionUpdatedAtMs(s.updatedAt),
        })).filter((s: ChatSession) => s.key);

        const canonicalBySuffix = new Map<string, string>();
        for (const session of sessions) {
          if (!session.key.startsWith('agent:')) continue;
          const parts = session.key.split(':');
          if (parts.length < 3) continue;
          const suffix = parts.slice(2).join(':');
          if (suffix && !canonicalBySuffix.has(suffix)) {
            canonicalBySuffix.set(suffix, session.key);
          }
        }

        // Deduplicate: if both short and canonical existed, keep canonical only
        const seen = new Set<string>();
        const dedupedSessions = sessions.filter((s) => {
          if (!s.key.startsWith('agent:') && canonicalBySuffix.has(s.key)) return false;
          if (seen.has(s.key)) return false;
          seen.add(s.key);
          return true;
        });

        const stateSnapshot = get();
        const { currentSessionKey } = stateSnapshot;
        let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
        if (!nextSessionKey.startsWith('agent:')) {
          const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
          if (canonicalMatch) {
            nextSessionKey = canonicalMatch;
          }
        }
        const hasSessionInBackend = (sessionKey: string): boolean => dedupedSessions.some((session) => session.key === sessionKey);
        let shouldKeepMissingCurrent = false;
        if (!hasSessionInBackend(nextSessionKey)) {
          shouldKeepMissingCurrent = shouldKeepMissingCurrentSession(
            nextSessionKey,
            stateSnapshot,
            dedupedSessions.length,
          );
          if (!shouldKeepMissingCurrent && dedupedSessions.length > 0) {
            nextSessionKey = dedupedSessions[0].key;
          }
        }
        const currentExistsInBackend = hasSessionInBackend(nextSessionKey);
        const sessionsWithCurrent = !currentExistsInBackend && shouldKeepMissingCurrent && nextSessionKey
          ? [
            ...dedupedSessions,
            { key: nextSessionKey, displayName: nextSessionKey },
          ]
          : dedupedSessions;

        const discoveredActivity = Object.fromEntries(
          sessionsWithCurrent
            .filter((session) => typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt))
            .map((session) => [session.key, session.updatedAt!]),
        );
        const discoveredLabels = Object.fromEntries(
          sessionsWithCurrent
            .map((session) => {
              const explicit = (session.label || session.displayName || '').trim();
              if (!explicit || explicit === session.key) {
                return null;
              }
              return [session.key, explicit] as const;
            })
            .filter((entry): entry is readonly [string, string] => entry != null),
        );

        const snapshot = get();
        const sessionsChanged = !areSessionsEquivalent(snapshot.sessions, sessionsWithCurrent);
        const sessionKeyChanged = snapshot.currentSessionKey !== nextSessionKey;
        const discoveredActivityChanged = Object.entries(discoveredActivity).some(
          ([sessionKey, updatedAt]) => snapshot.sessionLastActivity[sessionKey] !== updatedAt,
        );
        const discoveredLabelsChanged = Object.entries(discoveredLabels).some(
          ([sessionKey, label]) => snapshot.sessionLabels[sessionKey] !== label,
        );

        if (sessionsChanged || sessionKeyChanged || discoveredActivityChanged || discoveredLabelsChanged) {
          set((state) => {
            const next: Partial<ChatStoreState> = {};

            if (sessionsChanged) {
              next.sessions = sessionsWithCurrent;
            }
            if (sessionKeyChanged) {
              next.currentSessionKey = nextSessionKey;
            }
            if (discoveredActivityChanged) {
              next.sessionLastActivity = {
                ...state.sessionLastActivity,
                ...discoveredActivity,
              };
            }
            if (discoveredLabelsChanged) {
              next.sessionLabels = {
                ...state.sessionLabels,
                ...discoveredLabels,
              };
            }

            return next;
          });
        }

      }
    } catch (err) {
      console.warn('Failed to load sessions:', err);
    }
  },

  openAgentConversation: (agentId: string) => {
    const normalized = agentId.trim();
    if (!normalized) {
      return;
    }
    const state = get();
    const preferredSessionKey = resolvePreferredSessionKeyForAgent(
      normalized,
      state.sessions,
      state.sessionLastActivity,
    );
    if (preferredSessionKey) {
      get().switchSession(preferredSessionKey);
      return;
    }
    get().newSession(normalized);
  },

  // ── Switch session ──

  switchSession: (key: string) => {
    if (key === get().currentSessionKey) {
      return;
    }
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    clearPendingDeltaBatch();
    resetToolSnapshotTxnState();
    const state = get();
    const { currentSessionKey } = state;
    const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
    if (leavingEmpty) {
      _historyFingerprintBySession.delete(currentSessionKey);
      _historyProbeFingerprintBySession.delete(currentSessionKey);
      _historyQuickFingerprintBySession.delete(currentSessionKey);
      _historyRenderFingerprintBySession.delete(currentSessionKey);
    }
    const nextSessionRuntimeByKey = { ...state.sessionRuntimeByKey };

    if (leavingEmpty) {
      delete nextSessionRuntimeByKey[currentSessionKey];
    } else {
      touchSessionRuntimeSnapshot(
        nextSessionRuntimeByKey,
        currentSessionKey,
        snapshotCurrentSessionRuntime(state),
      );
    }
    touchSessionRuntimeSnapshot(nextSessionRuntimeByKey, key);
    trimSessionRuntimeSnapshots(nextSessionRuntimeByKey, [currentSessionKey, key]);
    const hasTargetRuntimeSnapshot = Object.prototype.hasOwnProperty.call(nextSessionRuntimeByKey, key);
    const targetRuntime = resolveSessionRuntime(nextSessionRuntimeByKey[key]);
    const targetPendingApprovals = state.pendingApprovalsBySession[key] ?? [];
    const targetApprovalStatus: ApprovalStatus = targetPendingApprovals.length > 0
      ? 'awaiting_approval'
      : targetRuntime.approvalStatus;
    const targetSessionReady = Boolean(state.sessionReadyByKey[key])
      || hasTargetRuntimeSnapshot
      || _historyFingerprintBySession.has(key);
    const nextSessionReadyByKey = (() => {
      const next = { ...state.sessionReadyByKey };
      if (leavingEmpty) {
        delete next[currentSessionKey];
      }
      if (targetSessionReady) {
        next[key] = true;
      }
      return next;
    })();

    set((s) => ({
      currentSessionKey: key,
      messages: targetRuntime.messages,
      snapshotReady: state.snapshotReady || targetSessionReady,
      initialLoading: false,
      refreshing: false,
      sending: targetRuntime.sending,
      streamingText: targetRuntime.streamingText,
      streamingMessage: targetRuntime.streamingMessage,
      streamingTools: targetRuntime.streamingTools,
      activeRunId: targetRuntime.activeRunId,
      error: null,
      pendingFinal: targetRuntime.pendingFinal,
      lastUserMessageAt: targetRuntime.lastUserMessageAt,
      pendingToolImages: targetRuntime.pendingToolImages,
      approvalStatus: targetApprovalStatus,
      sessionReadyByKey: nextSessionReadyByKey,
      sessionRuntimeByKey: nextSessionRuntimeByKey,
      ...(leavingEmpty ? {
        sessions: s.sessions.filter((s) => s.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
        ),
      } : {}),
    }));
    // 切回正在运行的会话时，重启历史轮询，避免 UI 卡在旧快照状态
    if (targetRuntime.sending) {
      const POLL_INTERVAL = 4_000;
      const pollHistory = () => {
        const current = get();
        if (!current.sending) {
          clearHistoryPoll();
          return;
        }
        if (!current.streamingMessage) {
          void current.loadHistory(true);
        }
        _historyPollTimer = setTimeout(pollHistory, POLL_INTERVAL);
      };
      _historyPollTimer = setTimeout(pollHistory, 1_000);
    }
    const shouldQuietReload = targetSessionReady;
    const shouldDeferQuietReload = shouldQuietReload && !targetRuntime.sending;
    scheduleNextFrame(() => {
      if (shouldDeferQuietReload) {
        scheduleIdleTask(() => {
          void get().loadHistory(true);
        });
        return;
      }
      void get().loadHistory(shouldQuietReload);
    });
  },

  // ── Delete session ──
  //
  // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
  // RPC — confirmed by inspecting client.ts, protocol.ts and the full codebase.
  // Deletion is therefore a local-only UI operation: the session is removed from
  // the sidebar list and its labels/activity maps are cleared.  The underlying
  // JSONL history file on disk is intentionally left intact, consistent with the
  // newSession() design that avoids sessions.reset to preserve history.

  deleteSession: async (key: string) => {
    clearPendingDeltaBatch();
    beginGlobalMutating(set);
    try {
      // Soft-delete the session's JSONL transcript on disk.
      // The main process renames <suffix>.jsonl → <suffix>.deleted.jsonl so that
      // sessions.list and token-usage queries both skip it automatically.
      try {
        const result = await hostApiFetch<{
          success: boolean;
          error?: string;
        }>('/api/sessions/delete', {
          method: 'POST',
          body: JSON.stringify({ sessionKey: key }),
        });
        if (!result.success) {
          console.warn(`[deleteSession] Host API reported failure for ${key}:`, result.error);
        }
      } catch (err) {
        console.warn(`[deleteSession] Host API call failed for ${key}:`, err);
      }
      const { currentSessionKey, sessions } = get();
      const remaining = sessions.filter((s) => s.key !== key);
      _historyFingerprintBySession.delete(key);
      _historyProbeFingerprintBySession.delete(key);
      _historyQuickFingerprintBySession.delete(key);
      _historyRenderFingerprintBySession.delete(key);

      if (currentSessionKey === key) {
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        // Switched away from deleted session — pick the first remaining or create new
        const next = remaining[0];
        set((s) => ({
          ...(function buildNextState() {
            const runtimeMap = Object.fromEntries(
              Object.entries(s.sessionRuntimeByKey).filter(([sessionKey]) => sessionKey !== key),
            );
            const nextRuntime = resolveSessionRuntime(runtimeMap[next?.key ?? '']);
            return {
              sessionRuntimeByKey: runtimeMap,
              messages: nextRuntime.messages,
              sending: nextRuntime.sending,
              streamingText: nextRuntime.streamingText,
              streamingMessage: nextRuntime.streamingMessage,
              streamingTools: nextRuntime.streamingTools,
              activeRunId: nextRuntime.activeRunId,
              pendingFinal: nextRuntime.pendingFinal,
              lastUserMessageAt: nextRuntime.lastUserMessageAt,
              pendingToolImages: nextRuntime.pendingToolImages,
              approvalStatus: nextRuntime.approvalStatus,
            };
          })(),
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          sessionReadyByKey: Object.fromEntries(Object.entries(s.sessionReadyByKey).filter(([k]) => k !== key)),
          pendingApprovalsBySession: Object.fromEntries(
            Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== key),
          ),
          error: null,
          initialLoading: false,
          refreshing: false,
          currentSessionKey: next?.key ?? DEFAULT_SESSION_KEY,
        }));
        if (next) {
          get().loadHistory();
        }
      } else {
        set((s) => ({
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          sessionReadyByKey: Object.fromEntries(Object.entries(s.sessionReadyByKey).filter(([k]) => k !== key)),
          sessionRuntimeByKey: Object.fromEntries(Object.entries(s.sessionRuntimeByKey).filter(([k]) => k !== key)),
          pendingApprovalsBySession: Object.fromEntries(
            Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== key),
          ),
        }));
      }
    } finally {
      finishGlobalMutating(set);
    }
  },

  // ── New session ──

  newSession: (agentId?: string) => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    clearPendingDeltaBatch();
    // Generate a new unique session key and switch to it.
    // NOTE: We intentionally do NOT call sessions.reset on the old session.
    // sessions.reset archives (renames) the session JSONL file, making old
    // conversation history inaccessible when the user switches back to it.
    const state = get();
    const { currentSessionKey } = state;
    const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
    if (leavingEmpty) {
      _historyFingerprintBySession.delete(currentSessionKey);
      _historyProbeFingerprintBySession.delete(currentSessionKey);
      _historyQuickFingerprintBySession.delete(currentSessionKey);
      _historyRenderFingerprintBySession.delete(currentSessionKey);
    }
    const prefix = resolveCanonicalPrefixForAgent(agentId)
      ?? getCanonicalPrefixFromSessions(get().sessions, currentSessionKey)
      ?? DEFAULT_CANONICAL_PREFIX;
    const newKey = `${prefix}:session-${Date.now()}`;
    const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
    set((s) => ({
      sessionRuntimeByKey: (() => {
        const next = { ...s.sessionRuntimeByKey };
        if (leavingEmpty) {
          delete next[currentSessionKey];
        } else {
          touchSessionRuntimeSnapshot(next, currentSessionKey, snapshotCurrentSessionRuntime(s));
        }
        delete next[newKey];
        trimSessionRuntimeSnapshots(next, [currentSessionKey, newKey]);
        return next;
      })(),
      currentSessionKey: newKey,
      sessions: [
        ...(leavingEmpty ? s.sessions.filter((sess) => sess.key !== currentSessionKey) : s.sessions),
        newSessionEntry,
      ],
      sessionLabels: leavingEmpty
        ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey))
        : s.sessionLabels,
      sessionLastActivity: leavingEmpty
        ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey))
        : s.sessionLastActivity,
      sessionReadyByKey: (() => {
        const next = { ...s.sessionReadyByKey };
        if (leavingEmpty) {
          delete next[currentSessionKey];
        }
        next[newKey] = true;
        return next;
      })(),
      pendingApprovalsBySession: (() => {
        if (!leavingEmpty) return s.pendingApprovalsBySession;
        return Object.fromEntries(
          Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== currentSessionKey),
        );
      })(),
      ...createEmptySessionRuntime(),
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      error: null,
    }));
  },

  // ── Cleanup empty session on navigate away ──

  cleanupEmptySession: () => {
    const state = get();
    const { currentSessionKey } = state;
    // Only remove non-main sessions that were never used (no messages sent).
    // This mirrors the "leavingEmpty" logic in switchSession so that creating
    // a new session and immediately navigating away doesn't leave a ghost entry
    // in the sidebar.
    const isEmptyNonMain = isTrulyEmptyNonMainSession(currentSessionKey, state);
    if (!isEmptyNonMain) return;
    _historyFingerprintBySession.delete(currentSessionKey);
    _historyProbeFingerprintBySession.delete(currentSessionKey);
    _historyQuickFingerprintBySession.delete(currentSessionKey);
    _historyRenderFingerprintBySession.delete(currentSessionKey);
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
      sessionLabels: Object.fromEntries(
        Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
      ),
      sessionLastActivity: Object.fromEntries(
        Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
      ),
      sessionReadyByKey: Object.fromEntries(
        Object.entries(s.sessionReadyByKey).filter(([k]) => k !== currentSessionKey),
      ),
      sessionRuntimeByKey: Object.fromEntries(
        Object.entries(s.sessionRuntimeByKey).filter(([k]) => k !== currentSessionKey),
      ),
      pendingApprovalsBySession: Object.fromEntries(
        Object.entries(s.pendingApprovalsBySession).filter(([k]) => k !== currentSessionKey),
      ),
    }));
  },

  // ── Load chat history ──

  loadHistory: async (quiet = false) => {
    const requestedSessionKey = get().currentSessionKey;
    const historyLoadRunId = quiet ? 0 : ++_historyLoadRunId;
    let loadingSafetyTimer: ReturnType<typeof setTimeout> | null = null;
    if (!quiet) {
      const snapshot = get();
      const hasSnapshot = Boolean(snapshot.sessionReadyByKey[requestedSessionKey]) || snapshot.messages.length > 0;
      set({
        initialLoading: !hasSnapshot,
        refreshing: hasSnapshot,
        error: null,
      });
      loadingSafetyTimer = setTimeout(() => {
        set((state) => {
          if (historyLoadRunId !== _historyLoadRunId || (!state.initialLoading && !state.refreshing)) {
            return state;
          }
          return { initialLoading: false, refreshing: false };
        });
      }, CHAT_HISTORY_LOADING_TIMEOUT_MS);
    }

    const shouldAbortHistoryProcessing = (): boolean => (
      get().currentSessionKey !== requestedSessionKey
      || (!quiet && historyLoadRunId !== _historyLoadRunId)
    );

    const applyLoadedMessages = async (rawMessages: RawMessage[], thinkingLevel: string | null) => {
      const quickFingerprint = buildQuickRawHistoryFingerprint(rawMessages, thinkingLevel);
      const previousQuickFingerprint = _historyQuickFingerprintBySession.get(requestedSessionKey) ?? null;
      const currentStateForQuickPath = get();
      const canSkipWithQuickFingerprint = (
        previousQuickFingerprint === quickFingerprint
        && currentStateForQuickPath.currentSessionKey === requestedSessionKey
        && currentStateForQuickPath.messages.length > 0
        && currentStateForQuickPath.thinkingLevel === thinkingLevel
      );
      if (canSkipWithQuickFingerprint) {
        if (
          !_historyRenderFingerprintBySession.has(requestedSessionKey)
          && currentStateForQuickPath.messages.length > 0
        ) {
          _historyRenderFingerprintBySession.set(
            requestedSessionKey,
            buildRenderMessagesFingerprint(currentStateForQuickPath.messages),
          );
        }
        if (!quiet && (currentStateForQuickPath.initialLoading || currentStateForQuickPath.refreshing)) {
          set((state) => {
            const alreadyReady = Boolean(state.sessionReadyByKey[requestedSessionKey]);
            if (alreadyReady) {
              return { initialLoading: false, refreshing: false, snapshotReady: true };
            }
            return {
              initialLoading: false,
              refreshing: false,
              snapshotReady: true,
              sessionReadyByKey: {
                ...state.sessionReadyByKey,
                [requestedSessionKey]: true,
              },
            };
          });
        } else if (!currentStateForQuickPath.sessionReadyByKey[requestedSessionKey]) {
          set((state) => ({
            sessionReadyByKey: {
              ...state.sessionReadyByKey,
              [requestedSessionKey]: true,
            },
          }));
        }
        return;
      }
      _historyQuickFingerprintBySession.set(requestedSessionKey, quickFingerprint);

      if (shouldAbortHistoryProcessing()) {
        return;
      }

      const shouldStageFirstPaint = (
        get().messages.length === 0
        && rawMessages.length > 120
      );
      if (shouldStageFirstPaint) {
        const provisionalTail: RawMessage[] = [];
        for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
          const current = rawMessages[index];
          if (isToolResultRole(current.role) || isInternalMessage(current)) {
            continue;
          }
          provisionalTail.push(current);
          if (provisionalTail.length >= 48) {
            break;
          }
        }
        provisionalTail.reverse();
        const provisionalLastMsg = provisionalTail[provisionalTail.length - 1];
        const provisionalLastAt = provisionalLastMsg?.timestamp ? toMs(provisionalLastMsg.timestamp) : null;
        const provisionalLabel = requestedSessionKey.endsWith(':main')
          ? ''
          : resolveSessionLabelFromMessages(provisionalTail);
        if (provisionalTail.length > 0) {
          set((state) => {
            if (state.currentSessionKey !== requestedSessionKey) {
              return state;
            }
            return {
              messages: provisionalTail,
              snapshotReady: true,
              initialLoading: false,
              refreshing: false,
              thinkingLevel,
              ...(provisionalLabel && state.sessionLabels[requestedSessionKey] !== provisionalLabel
                ? {
                    sessionLabels: {
                      ...state.sessionLabels,
                      [requestedSessionKey]: provisionalLabel,
                    },
                  }
                : {}),
              ...(provisionalLastAt != null && state.sessionLastActivity[requestedSessionKey] !== provisionalLastAt
                ? {
                    sessionLastActivity: {
                      ...state.sessionLastActivity,
                      [requestedSessionKey]: provisionalLastAt,
                    },
                  }
                : {}),
              sessionReadyByKey: state.sessionReadyByKey[requestedSessionKey]
                ? state.sessionReadyByKey
                : {
                    ...state.sessionReadyByKey,
                    [requestedSessionKey]: true,
                  },
            };
          });
        }
      }

      // Offload heavy history normalization to Worker:
      // tool_result attachment enrichment + internal/filler filtering + cached-image candidates.
      const normalizedMessages = await normalizeHistoryMessages(rawMessages);
      if (shouldAbortHistoryProcessing()) {
        return;
      }
      // Hydrate attachment preview/file-size from local cache with cheap path-based merge.
      const enrichedMessages = hydrateAttachedFilesFromCache(normalizedMessages);
      if (shouldAbortHistoryProcessing()) {
        return;
      }

      // Preserve the optimistic user message during an active send.
      // The Gateway may not include the user's message in chat.history
      // until the run completes, causing it to flash out of the UI.
      let finalMessages = enrichedMessages;
      const userMsgAt = get().lastUserMessageAt;
      if (get().sending && userMsgAt) {
        const userMsMs = toMs(userMsgAt);
        const currentMsgs = get().messages;
        const optimistic = [...currentMsgs].reverse().find(
          (m) => (
            m.role === 'user'
            && m.timestamp
            && Math.abs(toMs(m.timestamp) - userMsMs) <= OPTIMISTIC_USER_RECONCILE_WINDOW_MS
          ),
        );
        if (optimistic) {
          const optimisticText = normalizeUserTextForReconcile(optimistic.content);
          const matchedHistoryIndex = enrichedMessages.findIndex((candidate) => {
            if (candidate.role !== 'user' || !candidate.timestamp) {
              return false;
            }
            const candidateTsMs = toMs(candidate.timestamp);
            if (Math.abs(candidateTsMs - userMsMs) > OPTIMISTIC_USER_RECONCILE_WINDOW_MS) {
              return false;
            }
            if (candidate.id && optimistic.id && candidate.id === optimistic.id) {
              return true;
            }
            if (!optimisticText) {
              return false;
            }
            const candidateText = normalizeUserTextForReconcile(candidate.content);
            return candidateText !== '' && candidateText === optimisticText;
          });
          if (matchedHistoryIndex >= 0) {
            const matchedHistoryMessage = enrichedMessages[matchedHistoryIndex];
            const optimisticFiles = optimistic._attachedFiles ?? [];
            const historyFiles = matchedHistoryMessage?._attachedFiles ?? [];
            const optimisticId = typeof optimistic.id === 'string' && optimistic.id.trim()
              ? optimistic.id.trim()
              : '';
            const shouldPreserveOptimisticId = Boolean(
              optimisticId
              && matchedHistoryMessage?.id !== optimisticId,
            );
            const shouldHydrateOptimisticFiles = optimisticFiles.length > 0 && historyFiles.length === 0;
            if (shouldPreserveOptimisticId || shouldHydrateOptimisticFiles) {
              const merged = [...enrichedMessages];
              merged[matchedHistoryIndex] = {
                ...matchedHistoryMessage,
                ...(shouldPreserveOptimisticId ? { id: optimisticId } : {}),
                ...(shouldHydrateOptimisticFiles
                  ? { _attachedFiles: optimisticFiles.map((file) => ({ ...file })) }
                  : {}),
              };
              finalMessages = merged;
            }
          } else {
            finalMessages = [...enrichedMessages, optimistic];
          }
        }
      }

      const isMainSession = requestedSessionKey.endsWith(':main');
      const resolvedLabel = !isMainSession
        ? resolveSessionLabelFromMessages(finalMessages)
        : '';
      const lastMsg = finalMessages[finalMessages.length - 1];
      const lastAt = lastMsg?.timestamp ? toMs(lastMsg.timestamp) : null;
      const renderFingerprint = buildRenderMessagesFingerprint(finalMessages);
      const previousRenderFingerprint = _historyRenderFingerprintBySession.get(requestedSessionKey) ?? null;

      const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();

      // If we're sending but haven't received streaming events, check
      // whether the loaded history reveals intermediate tool-call activity.
      // This surfaces progress via the pendingFinal → ActivityIndicator path.
      const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
      const isAfterUserMsg = (msg: RawMessage): boolean => {
        if (!userMsTs || !msg.timestamp) return true;
        return toMs(msg.timestamp) >= userMsTs;
      };

      let hasRecentAssistantActivity = false;
      if (isSendingNow && !pendingFinal) {
        for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
          const msg = normalizedMessages[index];
          if (msg.role === 'assistant' && isAfterUserMsg(msg)) {
            hasRecentAssistantActivity = true;
            break;
          }
        }
      }

      // If pendingFinal, check whether the AI produced a final text response.
      let hasRecentFinalAssistantMessage = false;
      for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
        const msg = normalizedMessages[index];
        if (msg.role !== 'assistant') {
          continue;
        }
        if (!hasNonToolAssistantContent(msg)) {
          continue;
        }
        if (isAfterUserMsg(msg)) {
          hasRecentFinalAssistantMessage = true;
          break;
        }
      }

      let didMessageListChange = false;
      set((state) => {
        if (state.currentSessionKey !== requestedSessionKey) {
          return state;
        }
        const nextStatePatch: Partial<ChatStoreState> = {};
        let changed = false;

        if (!state.snapshotReady) {
          nextStatePatch.snapshotReady = true;
          changed = true;
        }
        if (!state.sessionReadyByKey[requestedSessionKey]) {
          nextStatePatch.sessionReadyByKey = {
            ...state.sessionReadyByKey,
            [requestedSessionKey]: true,
          };
          changed = true;
        }
        if (state.initialLoading || state.refreshing) {
          nextStatePatch.initialLoading = false;
          nextStatePatch.refreshing = false;
          changed = true;
        }
        // Fingerprint is the only source of truth for history payload change;
        // avoid O(n) deep compare on long conversations.
        if (previousRenderFingerprint !== renderFingerprint && state.messages !== finalMessages) {
          nextStatePatch.messages = finalMessages;
          didMessageListChange = true;
          changed = true;
        }
        if (state.thinkingLevel !== thinkingLevel) {
          nextStatePatch.thinkingLevel = thinkingLevel;
          changed = true;
        }
        if (resolvedLabel && state.sessionLabels[requestedSessionKey] !== resolvedLabel) {
          nextStatePatch.sessionLabels = {
            ...state.sessionLabels,
            [requestedSessionKey]: resolvedLabel,
          };
          changed = true;
        }
        if (lastAt != null && state.sessionLastActivity[requestedSessionKey] !== lastAt) {
          nextStatePatch.sessionLastActivity = {
            ...state.sessionLastActivity,
            [requestedSessionKey]: lastAt,
          };
          changed = true;
        }
        if (hasRecentAssistantActivity && state.sending && !state.pendingFinal) {
          nextStatePatch.pendingFinal = true;
          changed = true;
        }
        if (hasRecentFinalAssistantMessage && (state.sending || state.activeRunId != null || state.pendingFinal)) {
          nextStatePatch.sending = false;
          nextStatePatch.activeRunId = null;
          nextStatePatch.pendingFinal = false;
          changed = true;
        }

        return changed ? nextStatePatch : state;
      });
      _historyRenderFingerprintBySession.set(requestedSessionKey, renderFingerprint);

      if (hasRecentFinalAssistantMessage) {
        clearHistoryPoll();
      }

      // Async: load missing image previews from disk (updates in background)
      if (didMessageListChange && hasPendingPreviewLoads(finalMessages)) {
        void loadMissingPreviews(finalMessages).then((updated) => {
          if (!updated) {
            return;
          }
          set((state) => {
            if (state.currentSessionKey !== requestedSessionKey) {
              return state;
            }
            if (state.messages !== finalMessages) {
              return state;
            }
            return {
              messages: finalMessages.map((msg) => (
                msg._attachedFiles
                  ? { ...msg, _attachedFiles: msg._attachedFiles.map((file) => ({ ...file })) }
                  : msg
              )),
            };
          });
        });
      }
    };

    const fetchHistoryWindow = async (
      limit: number,
    ): Promise<{ rawMessages: RawMessage[]; thinkingLevel: string | null }> => {
      // Preferred path on OpenClaw 4.1+: sessions.get returns transcript messages
      // without depending on model-pricing bootstrap.
      try {
        const sessionsGetData = await useGatewayStore.getState().rpc<Record<string, unknown>>(
          'sessions.get',
          { key: requestedSessionKey, limit },
        );
        if (Array.isArray(sessionsGetData?.messages)) {
          let rawMessages = sessionsGetData.messages as RawMessage[];
          const thinkingLevel = resolveSessionThinkingLevelFromList(get().sessions, requestedSessionKey);
          if (rawMessages.length === 0) {
            rawMessages = await loadCronFallbackMessages(requestedSessionKey, limit);
          }
          return { rawMessages, thinkingLevel };
        }
      } catch {
        // Ignore and fall back to chat.history for backward compatibility.
      }

      // Compatibility path for older runtimes.
      const data = await useGatewayStore.getState().rpc<Record<string, unknown>>(
        'chat.history',
        { sessionKey: requestedSessionKey, limit },
      );
      let rawMessages = Array.isArray(data?.messages) ? data.messages as RawMessage[] : [];
      const thinkingLevel = data?.thinkingLevel ? String(data.thinkingLevel) : null;
      if (rawMessages.length === 0) {
        rawMessages = await loadCronFallbackMessages(requestedSessionKey, limit);
      }
      return { rawMessages, thinkingLevel };
    };

    try {
      if (quiet) {
        const probe = await fetchHistoryWindow(CHAT_HISTORY_QUIET_PROBE_LIMIT);
        if (get().currentSessionKey !== requestedSessionKey) {
          return;
        }
        const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
        const previousProbeFingerprint = _historyProbeFingerprintBySession.get(requestedSessionKey) ?? null;
        _historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);

        const hasKnownFullSnapshot = _historyFingerprintBySession.has(requestedSessionKey);
        const hasRenderableMessages = get().messages.length > 0;
        if (
          previousProbeFingerprint === probeFingerprint
          && hasKnownFullSnapshot
          && hasRenderableMessages
        ) {
          if (!get().sessionReadyByKey[requestedSessionKey]) {
            set((state) => ({
              sessionReadyByKey: {
                ...state.sessionReadyByKey,
                [requestedSessionKey]: true,
              },
            }));
          }
          return;
        }

        const shouldUseProbeAsFinal = probe.rawMessages.length < CHAT_HISTORY_QUIET_PROBE_LIMIT;
        if (shouldUseProbeAsFinal) {
          const fullFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
          _historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
          await applyLoadedMessages(probe.rawMessages, probe.thinkingLevel);
          return;
        }

        const full = await fetchHistoryWindow(CHAT_HISTORY_QUIET_FULL_LIMIT);
        if (get().currentSessionKey !== requestedSessionKey) {
          return;
        }
        const fullFingerprint = buildHistoryFingerprint(full.rawMessages, full.thinkingLevel);
        _historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, fullFingerprint);
        await applyLoadedMessages(full.rawMessages, full.thinkingLevel);
        return;
      }

      // Active (non-quiet) path also uses two-stage loading:
      // 1) small fixed probe window for constant-time first paint
      // 2) full window in background for complete history
      const probe = await fetchHistoryWindow(CHAT_HISTORY_ACTIVE_PROBE_LIMIT);
      // 防止异步竞态：请求返回时若用户已切到其它会话，直接丢弃本次结果。
      if (get().currentSessionKey !== requestedSessionKey) {
        return;
      }
      const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
      _historyFingerprintBySession.set(requestedSessionKey, probeFingerprint);
      _historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);
      await applyLoadedMessages(probe.rawMessages, probe.thinkingLevel);

      // Probe shorter than limit means we already have full history.
      if (probe.rawMessages.length < CHAT_HISTORY_ACTIVE_PROBE_LIMIT) {
        return;
      }

      try {
        const full = await fetchHistoryWindow(CHAT_HISTORY_FULL_LIMIT);
        if (get().currentSessionKey !== requestedSessionKey) {
          return;
        }
        const fullFingerprint = buildHistoryFingerprint(full.rawMessages, full.thinkingLevel);
        _historyFingerprintBySession.set(requestedSessionKey, fullFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, fullFingerprint);
        await applyLoadedMessages(full.rawMessages, full.thinkingLevel);
      } catch (fullErr) {
        // Keep probe snapshot on screen if full fetch fails.
        console.warn('Failed to load full chat history after probe window:', fullErr);
      }
    } catch (err) {
      console.warn('Failed to load chat history:', err);
      const fallbackMessages = await loadCronFallbackMessages(requestedSessionKey, CHAT_HISTORY_FULL_LIMIT);
      if (get().currentSessionKey !== requestedSessionKey) {
        return;
      }
      if (fallbackMessages.length > 0) {
        const fallbackFingerprint = buildHistoryFingerprint(fallbackMessages, null);
        _historyFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
        await applyLoadedMessages(fallbackMessages, null);
      } else if (!quiet) {
        const emptyFingerprint = buildHistoryFingerprint([], null);
        _historyFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
        _historyProbeFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
        _historyQuickFingerprintBySession.set(requestedSessionKey, buildQuickRawHistoryFingerprint([], null));
        _historyRenderFingerprintBySession.set(requestedSessionKey, buildRenderMessagesFingerprint([]));
        set({
          snapshotReady: true,
          initialLoading: false,
          refreshing: false,
          sessionReadyByKey: {
            ...get().sessionReadyByKey,
            [requestedSessionKey]: true,
          },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (loadingSafetyTimer) {
        clearTimeout(loadingSafetyTimer);
      }
      if (!quiet) {
        set((state) => {
          if (historyLoadRunId !== _historyLoadRunId || (!state.initialLoading && !state.refreshing)) {
            return state;
          }
          return { initialLoading: false, refreshing: false };
        });
      }
    }
  },

  // ── Send message ──

  syncPendingApprovals: async (sessionKeyHint?: string) => {
    try {
      const payload = await useGatewayStore.getState().rpc<unknown>('exec.approvals.get', {});
      const parsed = parseGatewayApprovalResponse(payload);
      if (!parsed.recognized) return;

      const grouped: Record<string, ApprovalItem[]> = {};
      for (const item of parsed.items) {
        if (!grouped[item.sessionKey]) grouped[item.sessionKey] = [];
        grouped[item.sessionKey].push(item);
      }
      for (const [sessionKey, items] of Object.entries(grouped)) {
        grouped[sessionKey] = [...items].sort((a, b) => a.createdAtMs - b.createdAtMs);
      }

      set((state) => {
        const normalizedHint = typeof sessionKeyHint === 'string' ? sessionKeyHint.trim() : '';
        const nextApprovals = normalizedHint
          ? { ...state.pendingApprovalsBySession, [normalizedHint]: grouped[normalizedHint] ?? [] }
          : grouped;
        const currentPending = nextApprovals[state.currentSessionKey] ?? [];
        const nextApprovalStatus: ApprovalStatus = currentPending.length > 0 ? 'awaiting_approval' : 'idle';
        const nextActiveRunId = state.activeRunId ?? currentPending.find((item) => typeof item.runId === 'string')?.runId ?? null;
        return {
          pendingApprovalsBySession: nextApprovals,
          approvalStatus: nextApprovalStatus,
          sending: currentPending.length > 0 ? true : state.sending,
          pendingFinal: currentPending.length > 0 ? true : state.pendingFinal,
          activeRunId: nextActiveRunId,
        };
      });
    } catch {
      // ignore
    }
  },

  // ── Send message ──

  sendMessage: async (text: string, attachments?: ChatSendAttachment[]) => {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    const { currentSessionKey } = get();

    // Add user message optimistically (with local file metadata for UI display)
    const nowMs = Date.now();
    const userMsg: RawMessage = {
      role: 'user',
      content: trimmed || (attachments?.length ? '(file attached)' : ''),
      timestamp: nowMs / 1000,
      id: crypto.randomUUID(),
      _attachedFiles: attachments?.map(a => ({
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        preview: a.preview,
        filePath: a.stagedPath,
      })),
    };
    set((s) => ({
      messages: [...s.messages, userMsg],
      sending: true,
      error: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: nowMs,
      approvalStatus: 'idle',
    }));

    // 统一会话标题提取：优先用户有效文本；纯附件消息会等待 assistant 响应兜底。
    const { sessionLabels, messages } = get();
    if (!currentSessionKey.endsWith(':main') && !sessionLabels[currentSessionKey]) {
      const resolvedLabel = resolveSessionLabelFromMessages(messages);
      if (resolvedLabel) {
        set((s) => ({ sessionLabels: { ...s.sessionLabels, [currentSessionKey]: resolvedLabel } }));
      }
    }

    // Mark this session as most recently active
    set((s) => ({ sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs } }));

    // Start the history poll and safety timeout IMMEDIATELY (before the
    // RPC await) because the gateway's chat.send RPC may block until the
    // entire agentic conversation finishes — the poll must run in parallel.
    _lastChatEventAt = Date.now();
    clearHistoryPoll();
    clearErrorRecoveryTimer();

    const POLL_START_DELAY = 3_000;
    const POLL_INTERVAL = 4_000;
    const pollHistory = () => {
      const state = get();
      if (!state.sending) { clearHistoryPoll(); return; }
      if (state.streamingMessage) {
        _historyPollTimer = setTimeout(pollHistory, POLL_INTERVAL);
        return;
      }
      state.loadHistory(true);
      void state.syncPendingApprovals(state.currentSessionKey);
      _historyPollTimer = setTimeout(pollHistory, POLL_INTERVAL);
    };
    _historyPollTimer = setTimeout(pollHistory, POLL_START_DELAY);

    const SAFETY_TIMEOUT_MS = 90_000;
    const checkStuck = () => {
      const state = get();
      if (!state.sending) return;
      if (state.streamingMessage || state.streamingText) return;
      if (state.pendingFinal) {
        setTimeout(checkStuck, 10_000);
        return;
      }
      if (Date.now() - _lastChatEventAt < SAFETY_TIMEOUT_MS) {
        setTimeout(checkStuck, 10_000);
        return;
      }
      clearHistoryPoll();
      set({
        error: 'No response received from the model. The provider may be unavailable or the API key may have insufficient quota. Please check your provider settings.',
        sending: false,
        activeRunId: null,
        lastUserMessageAt: null,
      });
    };
    setTimeout(checkStuck, 30_000);

    beginGlobalMutating(set);
    try {
      const idempotencyKey = crypto.randomUUID();
      const hasMedia = attachments && attachments.length > 0;
      if (hasMedia) {
        console.log('[sendMessage] Media paths:', attachments!.map(a => a.stagedPath));
      }

      // Cache image attachments BEFORE the IPC call to avoid race condition:
      // history may reload (via Gateway event) before the RPC returns.
      // Keyed by staged file path which appears in [media attached: <path> ...].
      if (hasMedia && attachments) {
        cacheSendAttachments(attachments);
      }

      let result: { success: boolean; result?: { runId?: string }; error?: string };

      // Longer timeout for chat sends to tolerate high-latency networks (avoids connect error)
      const CHAT_SEND_TIMEOUT_MS = 120_000;

      if (hasMedia) {
        result = await hostApiFetch<{ success: boolean; result?: { runId?: string }; error?: string }>(
          '/api/chat/send-with-media',
          {
            method: 'POST',
            body: JSON.stringify({
              sessionKey: currentSessionKey,
              message: trimmed || 'Process the attached file(s).',
              deliver: false,
              idempotencyKey,
              media: attachments.map((a) => ({
                filePath: a.stagedPath,
                mimeType: a.mimeType,
                fileName: a.fileName,
              })),
            }),
          },
        );
      } else {
        const rpcResult = await useGatewayStore.getState().rpc<{ runId?: string }>(
          'chat.send',
          {
            sessionKey: currentSessionKey,
            message: trimmed,
            deliver: false,
            idempotencyKey,
          },
          CHAT_SEND_TIMEOUT_MS,
        );
        result = { success: true, result: rpcResult };
      }

      console.log(`[sendMessage] RPC result: success=${result.success}, runId=${result.result?.runId || 'none'}`);

      if (!result.success) {
        const errorMsg = result.error || 'Failed to send message';
        if (isRecoverableChatSendTimeout(errorMsg)) {
          set({ error: errorMsg });
          return;
        }
        await get().syncPendingApprovals(currentSessionKey);
        const state = get();
        const pendingApprovals = state.pendingApprovalsBySession[currentSessionKey] ?? [];
        if (pendingApprovals.length > 0) {
          set({
            error: null,
            sending: true,
            pendingFinal: true,
            approvalStatus: 'awaiting_approval',
          });
          return;
        }
        clearHistoryPoll();
        set({ error: errorMsg, sending: false });
      } else if (result.result?.runId) {
        set({ activeRunId: result.result.runId });
      }
    } catch (err) {
      const errMsg = String(err);
      if (isRecoverableChatSendTimeout(errMsg)) {
        set({ error: errMsg });
        return;
      }
      if (hasTimeoutSignal(err)) {
        await get().syncPendingApprovals(currentSessionKey);
      }
      const state = get();
      const pendingApprovals = state.pendingApprovalsBySession[currentSessionKey] ?? [];
      const hasApprovalEvidence = pendingApprovals.length > 0
        || state.approvalStatus === 'awaiting_approval'
        || state.activeRunId != null;
      if (hasTimeoutSignal(err) && hasApprovalEvidence) {
        set({
          error: null,
          sending: true,
          pendingFinal: true,
          approvalStatus: 'awaiting_approval',
        });
        return;
      }
      clearHistoryPoll();
      set({ error: errMsg, sending: false, approvalStatus: 'idle' });
    } finally {
      finishGlobalMutating(set);
    }
  },

  // ── Abort active run ──

  abortRun: async () => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    clearPendingDeltaBatch();
    const { currentSessionKey, pendingApprovalsBySession } = get();
    const pendingApprovals = pendingApprovalsBySession[currentSessionKey] ?? [];
    set({
      sending: false,
      streamingText: '',
      streamingMessage: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle',
    });
    set({ streamingTools: [] });

    beginGlobalMutating(set);
    try {
      for (const approval of pendingApprovals) {
        await useGatewayStore.getState().rpc(
          'exec.approval.resolve',
          { id: approval.id, decision: 'deny' },
        );
      }
      set((s) => ({
        pendingApprovalsBySession: {
          ...s.pendingApprovalsBySession,
          [currentSessionKey]: [],
        },
      }));
      await useGatewayStore.getState().rpc(
        'chat.abort',
        { sessionKey: currentSessionKey },
      );
    } catch (err) {
      set({ error: String(err) });
    } finally {
      finishGlobalMutating(set);
    }
  },

  handleApprovalRequested: (payload: Record<string, unknown>) => {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const sessionKey = resolveApprovalSessionKey(payload);
    if (!id || !sessionKey) return;

    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : undefined;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : undefined;
    const createdAtMs = normalizeApprovalTimestampMs(payload.createdAt)
      ?? normalizeApprovalTimestampMs(payload.requestedAt)
      ?? Date.now();
    const expiresAtMs = normalizeApprovalTimestampMs(payload.expiresAt);

    set((state) => {
      const isCurrentSession = sessionKey === state.currentSessionKey;
      const existing = state.pendingApprovalsBySession[sessionKey] ?? [];
      const filtered = existing.filter((item) => item.id !== id);
      const nextItem: ApprovalItem = {
        id,
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(toolName ? { toolName } : {}),
        createdAtMs,
        ...(expiresAtMs ? { expiresAtMs } : {}),
      };
      const nextSessionItems = [...filtered, nextItem].sort((a, b) => a.createdAtMs - b.createdAtMs);
      const nextApprovals = {
        ...state.pendingApprovalsBySession,
        [sessionKey]: nextSessionItems,
      };

      return {
        pendingApprovalsBySession: nextApprovals,
        approvalStatus: isCurrentSession ? 'awaiting_approval' : state.approvalStatus,
        sending: isCurrentSession ? true : state.sending,
        pendingFinal: isCurrentSession ? true : state.pendingFinal,
        // 进入审批等待态后，清理流式占位，避免工具条占位导致审批按钮不显示。
        streamingMessage: isCurrentSession ? null : state.streamingMessage,
        streamingText: isCurrentSession ? '' : state.streamingText,
        streamingTools: isCurrentSession ? [] : state.streamingTools,
        activeRunId: isCurrentSession && runId
          ? (state.activeRunId ?? runId)
          : state.activeRunId,
      };
    });
  },

  handleApprovalResolved: (payload: Record<string, unknown>) => {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!id) return;

    const resolvedSessionKey = resolveApprovalSessionKey(payload);
    const decision = normalizeApprovalDecision(payload.decision);

    set((state) => {
      let matchedSessionKey = resolvedSessionKey ?? '';
      if (!matchedSessionKey) {
        for (const [sessionKey, approvals] of Object.entries(state.pendingApprovalsBySession)) {
          if (approvals.some((item) => item.id === id)) {
            matchedSessionKey = sessionKey;
            break;
          }
        }
      }
      if (!matchedSessionKey) return {};

      const nextApprovals = { ...state.pendingApprovalsBySession };
      const sessionApprovals = nextApprovals[matchedSessionKey] ?? [];
      nextApprovals[matchedSessionKey] = sessionApprovals.filter((item) => item.id !== id);

      const stillPendingCurrent = (nextApprovals[state.currentSessionKey] ?? []).length > 0;
      return {
        pendingApprovalsBySession: nextApprovals,
        approvalStatus: stillPendingCurrent ? 'awaiting_approval' : 'idle',
        ...(decision === 'deny' && matchedSessionKey === state.currentSessionKey
          ? { pendingFinal: false, sending: false, activeRunId: null }
          : {}),
      };
    });
  },

  resolveApproval: async (id: string, decision: ApprovalDecision) => {
    const approvalId = id.trim();
    if (!approvalId) return;
    beginGlobalMutating(set);
    try {
      await useGatewayStore.getState().rpc(
        'exec.approval.resolve',
        { id: approvalId, decision },
      );
      get().handleApprovalResolved({
        id: approvalId,
        decision,
        sessionKey: get().currentSessionKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isStaleApprovalError = /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
      if (isStaleApprovalError) {
        get().handleApprovalResolved({
          id: approvalId,
          decision: 'deny',
          sessionKey: get().currentSessionKey,
        });
      }
      set({ error: message });
      await get().syncPendingApprovals(get().currentSessionKey);
    } finally {
      finishGlobalMutating(set);
    }
  },

  // ── Handle incoming chat events from Gateway ──

  handleChatEvent: (event: Record<string, unknown>) => {
    const runId = String(event.runId || '');
    const eventState = String(event.state || '');
    const eventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const { activeRunId, currentSessionKey } = get();

    // Only process events for the current session (when sessionKey is present)
    if (eventSessionKey != null && eventSessionKey !== currentSessionKey) return;

    // Only process events for the active run (or if no active run set)
    if (activeRunId && runId && runId !== activeRunId) return;

    _lastChatEventAt = Date.now();

    // Defensive: if state is missing but we have a message, try to infer state.
    let resolvedState = eventState;
    if (!resolvedState && event.message && typeof event.message === 'object') {
      const msg = event.message as Record<string, unknown>;
      const stopReason = msg.stopReason ?? msg.stop_reason;
      if (stopReason) {
        resolvedState = 'final';
      } else if (msg.role || msg.content) {
        resolvedState = 'delta';
      }
    }

    // Only pause the history poll when we receive actual streaming data.
    // The gateway sends "agent" events with { phase, startedAt } that carry
    // no message — these must NOT kill the poll, since the poll is our only
    // way to track progress when the gateway doesn't stream intermediate turns.
    const hasUsefulData = resolvedState === 'delta' || resolvedState === 'final'
      || resolvedState === 'error' || resolvedState === 'aborted';
    if (hasUsefulData) {
      clearHistoryPoll();
      // Adopt run started from another client (e.g. console at 127.0.0.1:18789):
      // show loading/streaming in the app when this session has an active run.
      const { sending } = get();
      if (!sending && runId) {
        set({ sending: true, activeRunId: runId, error: null });
      }
      if (resolvedState !== 'delta') {
        flushPendingDeltaBatch(set, get);
      }
    }

    switch (resolvedState) {
      case 'started': {
        // Run just started (e.g. from console); show loading immediately.
        const { sending: currentSending } = get();
        if (!currentSending && runId) {
          set({ sending: true, activeRunId: runId, error: null });
        }
        break;
      }
      case 'delta': {
        // Clear stale error state (including chat.send timeout) once new data arrives.
        if (_errorRecoveryTimer) {
          clearErrorRecoveryTimer();
        }
        if (get().error) {
          set({ error: null });
        }
        const updates = collectToolUpdates(event.message, resolvedState);
        queueDeltaForFrame(
          set,
          get,
          currentSessionKey,
          runId || activeRunId || '',
          event.message,
          updates,
        );
        armToolSnapshotTxnState(
          currentSessionKey,
          runId || activeRunId || '',
          event.message,
        );
        break;
      }
      case 'final': {
        clearErrorRecoveryTimer();
        if (get().error) set({ error: null });
        // Message complete - add to history and clear streaming
        const finalMsg = event.message as RawMessage | undefined;
        if (finalMsg) {
          const updates = collectToolUpdates(finalMsg, resolvedState);
          if (isToolResultRole(finalMsg.role)) {
            // Resolve file path from the streaming assistant message's matching tool call
            const currentStreamForPath = get().streamingMessage as RawMessage | null;
            const matchedPath = (currentStreamForPath && finalMsg.toolCallId)
              ? getToolCallFilePath(currentStreamForPath, finalMsg.toolCallId)
              : undefined;

            // Mirror enrichWithToolResultFiles: collect images + file refs for next assistant msg
            const toolFiles: AttachedFileMeta[] = [
              ...extractImagesAsAttachedFiles(finalMsg.content),
            ];
            if (matchedPath) {
              for (const f of toolFiles) {
                if (!f.filePath) {
                  f.filePath = matchedPath;
                  f.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
                }
              }
            }
            const text = getMessageText(finalMsg.content);
            if (text) {
              const mediaRefs = extractMediaRefs(text);
              const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
              for (const ref of mediaRefs) toolFiles.push(makeAttachedFile(ref));
              for (const ref of extractRawFilePaths(text)) {
                if (!mediaRefPaths.has(ref.filePath)) toolFiles.push(makeAttachedFile(ref));
              }
            }
            const currentStreamForSnapshot = get().streamingMessage as RawMessage | null;
            if (_toolSnapshotTxnState.phase === 'idle') {
              armToolSnapshotTxnState(
                currentSessionKey,
                runId || activeRunId || '',
                currentStreamForSnapshot,
              );
            }
            const shouldCommitToolSnapshot = consumeToolSnapshotTxnState(
              currentSessionKey,
              runId || activeRunId || '',
              currentStreamForSnapshot,
            );
            set((s) => {
              // Snapshot the current streaming assistant message (thinking + tool_use) into
              // messages[] before clearing it. The Gateway does NOT send separate 'final'
              // events for intermediate tool-use turns — it only sends deltas and then the
              // tool result. Without snapshotting here, the intermediate thinking+tool steps
              // would be overwritten by the next turn's deltas and never appear in the UI.
              const currentStream = s.streamingMessage as RawMessage | null;
              const snapshotMsgs: RawMessage[] = [];
              if (shouldCommitToolSnapshot && currentStream) {
                const streamRole = currentStream.role;
                const shouldSnapshotIntermediateToolTurn = (
                  (streamRole === 'assistant' || streamRole === undefined)
                  && hasAssistantToolCall(currentStream)
                );
                if (shouldSnapshotIntermediateToolTurn) {
                  // Use message's own id if available, otherwise derive a stable one from runId
                  const snapId = currentStream.id
                    || `${runId || 'run'}-turn-${s.messages.length}`;
                  if (!s.messages.some(m => m.id === snapId)) {
                    const snapshot = sanitizeIntermediateToolFillerMessage(
                      createIntermediateToolTurnSnapshot(currentStream as RawMessage, snapId),
                      { trackPhrase: true },
                    );
                    snapshotMsgs.push(snapshot);
                  }
                }
              }
              return {
                messages: snapshotMsgs.length > 0 ? [...s.messages, ...snapshotMsgs] : s.messages,
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                pendingToolImages: toolFiles.length > 0
                  ? [...s.pendingToolImages, ...toolFiles]
                  : s.pendingToolImages,
                streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
              };
            });
            break;
          }
          resetToolSnapshotTxnState();
          const toolOnly = isToolOnlyMessage(finalMsg);
          const hasOutput = hasNonToolAssistantContent(finalMsg);
          const fallbackRole = typeof finalMsg.role === 'string' ? finalMsg.role : 'assistant';
          const msgId = finalMsg.id || (toolOnly ? `run-${runId}-tool-${Date.now()}` : `run-${runId}-${fallbackRole}`);
          set((s) => {
            const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
            const streamingTools = hasOutput ? [] : nextTools;

            // Attach any images collected from preceding tool results
            const pendingImgs = s.pendingToolImages;
            const msgWithImages: RawMessage = pendingImgs.length > 0
              ? {
                ...finalMsg,
                role: (finalMsg.role || 'assistant') as RawMessage['role'],
                id: msgId,
                _attachedFiles: [...(finalMsg._attachedFiles || []), ...pendingImgs],
              }
              : { ...finalMsg, role: (finalMsg.role || 'assistant') as RawMessage['role'], id: msgId };
            const clearPendingImages = { pendingToolImages: [] as AttachedFileMeta[] };

            // Check if message already exists (prevent duplicates)
            const assistantSemanticDuplicate = (() => {
              if (msgWithImages.role !== 'assistant' || (!s.sending && !s.pendingFinal)) {
                return false;
              }
              const incomingText = normalizeAssistantFinalTextForDedup(msgWithImages.content);
              if (!incomingText) {
                return false;
              }
              const scanStart = Math.max(0, s.messages.length - 6);
              for (let index = s.messages.length - 1; index >= scanStart; index -= 1) {
                const candidate = s.messages[index];
                if (candidate.role !== 'assistant') {
                  continue;
                }
                const candidateText = normalizeAssistantFinalTextForDedup(candidate.content);
                if (candidateText && candidateText === incomingText) {
                  return true;
                }
              }
              return false;
            })();
            const alreadyExists = s.messages.some(m => m.id === msgId) || assistantSemanticDuplicate;
            const optimisticUserIndex = (() => {
              if (msgWithImages.role !== 'user') {
                return -1;
              }
              if (s.lastUserMessageAt == null) {
                return -1;
              }
              const sentAtMs = toMs(s.lastUserMessageAt);
              const incomingText = normalizeUserTextForReconcile(msgWithImages.content);
              if (!incomingText) {
                return -1;
              }
              for (let index = s.messages.length - 1; index >= 0; index -= 1) {
                const candidate = s.messages[index];
                if (candidate.role !== 'user') {
                  continue;
                }
                if (!candidate.timestamp) {
                  continue;
                }
                const candidateTsMs = toMs(candidate.timestamp);
                if (Math.abs(candidateTsMs - sentAtMs) > 30_000) {
                  continue;
                }
                const candidateText = normalizeUserTextForReconcile(candidate.content);
                if (!candidateText || candidateText !== incomingText) {
                  continue;
                }
                return index;
              }
              return -1;
            })();
            if (alreadyExists) {
              return toolOnly ? {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                ...clearPendingImages,
              } : {
                streamingText: '',
                streamingMessage: null,
                sending: hasOutput ? false : s.sending,
                activeRunId: hasOutput ? null : s.activeRunId,
                pendingFinal: hasOutput ? false : true,
                streamingTools,
                ...clearPendingImages,
              };
            }
            if (optimisticUserIndex >= 0) {
              const optimisticUser = s.messages[optimisticUserIndex];
              const optimisticUserId = (
                optimisticUser
                && typeof optimisticUser.id === 'string'
                && optimisticUser.id.trim()
              )
                ? optimisticUser.id.trim()
                : '';
              const mergedUserMessage: RawMessage = {
                ...msgWithImages,
                ...(optimisticUserId ? { id: optimisticUserId } : {}),
                _attachedFiles: msgWithImages._attachedFiles && msgWithImages._attachedFiles.length > 0
                  ? msgWithImages._attachedFiles
                  : optimisticUser?._attachedFiles,
              };
              const nextMessages = [...s.messages];
              nextMessages[optimisticUserIndex] = mergedUserMessage;
              return toolOnly ? {
                messages: nextMessages,
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                ...clearPendingImages,
              } : {
                messages: nextMessages,
                streamingText: '',
                streamingMessage: null,
                sending: hasOutput ? false : s.sending,
                activeRunId: hasOutput ? null : s.activeRunId,
                pendingFinal: hasOutput ? false : true,
                streamingTools,
                ...clearPendingImages,
              };
            }
            return toolOnly ? {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              streamingTools,
              ...clearPendingImages,
            } : {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              sending: hasOutput ? false : s.sending,
              activeRunId: hasOutput ? null : s.activeRunId,
              pendingFinal: hasOutput ? false : true,
              streamingTools,
              ...clearPendingImages,
            };
          });
          // After the final response, quietly reload history to surface all intermediate
          // tool-use turns (thinking + tool blocks) from the Gateway's authoritative record.
          if (hasOutput && !toolOnly) {
            clearHistoryPoll();
            const hasPendingApprovals = (get().pendingApprovalsBySession[get().currentSessionKey] ?? []).length > 0;
            if (!hasPendingApprovals) {
              set({ approvalStatus: 'idle' });
            }
            void get().loadHistory(true);
          }
        } else {
          resetToolSnapshotTxnState();
          // No message in final event - reload history to get complete data
          set({ streamingText: '', streamingMessage: null, pendingFinal: true });
          get().loadHistory();
        }
        break;
      }
      case 'error': {
        resetToolSnapshotTxnState();
        const errorMsg = String(event.errorMessage || 'An error occurred');
        const wasSending = get().sending;

        // Snapshot the current streaming message into messages[] so partial
        // content ("Let me get that written down...") is preserved in the UI
        // rather than being silently discarded.
        const currentStream = get().streamingMessage as RawMessage | null;
        if (currentStream && (currentStream.role === 'assistant' || currentStream.role === undefined)) {
          const snapId = (currentStream as RawMessage).id
            || `error-snap-${Date.now()}`;
            const alreadyExists = get().messages.some(m => m.id === snapId);
            if (!alreadyExists) {
              const snapshot = sanitizeIntermediateToolFillerMessage(
                createIntermediateToolTurnSnapshot(currentStream, snapId),
                { trackPhrase: true },
              );
              set((s) => ({
                messages: [...s.messages, snapshot],
              }));
          }
        }

        set({
          error: errorMsg,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          pendingToolImages: [],
          approvalStatus: 'idle',
        });

        // Don't immediately give up: the Gateway often retries internally
        // after transient API failures (e.g. "terminated"). Keep `sending`
        // true for a grace period so that recovery events are processed and
        // the agent-phase-completion handler can still trigger loadHistory.
        if (wasSending) {
          clearErrorRecoveryTimer();
          const ERROR_RECOVERY_GRACE_MS = 15_000;
          _errorRecoveryTimer = setTimeout(() => {
            _errorRecoveryTimer = null;
            const state = get();
            if (state.sending && !state.streamingMessage) {
              clearHistoryPoll();
              // Grace period expired with no recovery — finalize the error
              set({
                sending: false,
                activeRunId: null,
                lastUserMessageAt: null,
              });
              // One final history reload in case the Gateway completed in the
              // background and we just missed the event.
              state.loadHistory(true);
            }
          }, ERROR_RECOVERY_GRACE_MS);
        } else {
          clearHistoryPoll();
          set({ sending: false, activeRunId: null, lastUserMessageAt: null });
        }
        break;
      }
      case 'aborted': {
        resetToolSnapshotTxnState();
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        set({
          sending: false,
          activeRunId: null,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          approvalStatus: 'idle',
        });
        break;
      }
      default: {
        // Unknown or empty state — if we're currently sending and receive an event
        // with a message, attempt to process it as streaming data. This handles
        // edge cases where the Gateway sends events without a state field.
        const { sending } = get();
        if (sending && event.message && typeof event.message === 'object') {
          console.warn(`[handleChatEvent] Unknown event state "${resolvedState}", treating message as streaming delta. Event keys:`, Object.keys(event));
          const updates = collectToolUpdates(event.message, 'delta');
          set((s) => ({
            streamingMessage: event.message ?? s.streamingMessage,
            streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
          }));
        }
        break;
      }
    }
  },

  getTaskInboxBridgeState: () => buildTaskInboxBridgeState(get(), DEFAULT_SESSION_KEY),

  openTaskInboxSession: (sessionKey: string) => {
    const { currentSessionKey, switchSession } = get();
    const targetSessionKey = normalizeTaskInboxSessionKey(sessionKey, currentSessionKey || DEFAULT_SESSION_KEY);
    if (targetSessionKey !== currentSessionKey) {
      switchSession(targetSessionKey);
    }
    return targetSessionKey;
  },

  sendTaskInboxRecoveryPrompt: async (sessionKey: string, prompt: string) => {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (!text) {
      return false;
    }
    const state = get();
    const targetSessionKey = normalizeTaskInboxSessionKey(sessionKey, state.currentSessionKey || DEFAULT_SESSION_KEY);
    const bridge = buildTaskInboxBridgeState(state, DEFAULT_SESSION_KEY);
    if (bridge.sessionKey !== targetSessionKey) {
      return false;
    }
    if (!bridge.canSendRecoveryPrompt) {
      return false;
    }
    await state.sendMessage(text);
    return true;
  },

  // ── Toggle thinking visibility ──

  toggleThinking: () => set((s) => ({ showThinking: !s.showThinking })),

  // ── Refresh: reload history + sessions ──

  refresh: async () => {
    const { loadHistory, loadSessions } = get();
    await Promise.all([loadHistory(), loadSessions()]);
  },

  clearError: () => set({ error: null }),
}));

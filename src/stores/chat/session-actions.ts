import { hostApiFetch, hostGatewayRequest } from '@/lib/host-api';
import { getCanonicalPrefixFromSessions, getMessageText, toMs } from './helpers';
import { DEFAULT_CANONICAL_PREFIX, DEFAULT_SESSION_KEY, type ChatSession, type RawMessage } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';

function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function resolveCanonicalPrefixForAgent(agentId?: string): string | null {
  if (typeof agentId !== 'string') {
    return null;
  }
  const normalized = agentId.trim();
  if (!normalized) {
    return null;
  }
  return `agent:${normalized}`;
}

function isTrulyEmptyNonMainSession(
  currentSessionKey: string,
  state: Pick<ReturnType<ChatGet>, 'messages' | 'sessionLastActivity' | 'sessionLabels'>,
): boolean {
  return !currentSessionKey.endsWith(':main')
    && state.messages.length === 0
    && !state.sessionLastActivity[currentSessionKey]
    && !state.sessionLabels[currentSessionKey];
}

export function createSessionActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadSessions' | 'switchSession' | 'newSession' | 'deleteSession' | 'cleanupEmptySession'> {
  return {
    loadSessions: async () => {
      try {
        const result = await hostGatewayRequest<Record<string, unknown>>(
          'sessions.list',
          {},
        );

        if (result.success && result.result) {
          const data = result.result;
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

          const { currentSessionKey } = get();
          let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
          if (!nextSessionKey.startsWith('agent:')) {
            const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
            if (canonicalMatch) {
              nextSessionKey = canonicalMatch;
            }
          }
          if (!dedupedSessions.find((s) => s.key === nextSessionKey) && dedupedSessions.length > 0) {
            // Current session not found in the backend list
            const isNewEmptySession = get().messages.length === 0;
            if (!isNewEmptySession) {
              nextSessionKey = dedupedSessions[0].key;
            }
          }

          const sessionsWithCurrent = !dedupedSessions.find((s) => s.key === nextSessionKey) && nextSessionKey
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

          set((state) => ({
            sessions: sessionsWithCurrent,
            currentSessionKey: nextSessionKey,
            sessionLastActivity: {
              ...state.sessionLastActivity,
              ...discoveredActivity,
            },
          }));

          if (currentSessionKey !== nextSessionKey) {
            get().loadHistory();
          }

          // Background: fetch first user message for every non-main session to populate labels upfront.
          // Uses a small limit so it's cheap; runs in parallel and doesn't block anything.
          const sessionsToLabel = sessionsWithCurrent.filter((s) => !s.key.endsWith(':main'));
          if (sessionsToLabel.length > 0) {
            void Promise.all(
              sessionsToLabel.map(async (session) => {
                try {
                  const r = await hostGatewayRequest<Record<string, unknown>>(
                    'chat.history',
                    { sessionKey: session.key, limit: 1000 },
                  );
                  if (!r.success || !r.result) return;
                  const msgs = Array.isArray(r.result.messages) ? r.result.messages as RawMessage[] : [];
                  const firstUser = msgs.find((m) => m.role === 'user');
                  const lastMsg = msgs[msgs.length - 1];
                  set((s) => {
                    const next: Partial<typeof s> = {};
                    if (firstUser) {
                      const labelText = getMessageText(firstUser.content).trim();
                      if (labelText) {
                        const truncated = labelText.length > 50 ? `${labelText.slice(0, 50)}…` : labelText;
                        next.sessionLabels = { ...s.sessionLabels, [session.key]: truncated };
                      }
                    }
                    if (lastMsg?.timestamp) {
                      next.sessionLastActivity = { ...s.sessionLastActivity, [session.key]: toMs(lastMsg.timestamp) };
                    }
                    return next;
                  });
                } catch { /* ignore per-session errors */ }
              }),
            );
          }
        }
      } catch (err) {
        console.warn('Failed to load sessions:', err);
      }
    },

    // ── Switch session ──

    switchSession: (key: string) => {
      const state = get();
      const { currentSessionKey } = state;
      const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
      set((s) => ({
        currentSessionKey: key,
        messages: [],
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        error: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
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
      get().loadHistory();
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
      // Soft-delete the session's JSONL transcript on disk.
      // Host API renames <suffix>.jsonl → <suffix>.deleted.jsonl so that
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

      if (currentSessionKey === key) {
        // Switched away from deleted session — pick the first remaining or create new
        const next = remaining[0];
        set((s) => ({
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          messages: [],
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          activeRunId: null,
          error: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
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
        }));
      }
    },

    // ── New session ──

    newSession: (agentId?: string) => {
      // Generate a new unique session key and switch to it.
      // NOTE: We intentionally do NOT call sessions.reset on the old session.
      // sessions.reset archives (renames) the session JSONL file, making old
      // conversation history inaccessible when the user switches back to it.
      const state = get();
      const { currentSessionKey } = state;
      const leavingEmpty = isTrulyEmptyNonMainSession(currentSessionKey, state);
      const prefix = resolveCanonicalPrefixForAgent(agentId)
        ?? getCanonicalPrefixFromSessions(get().sessions, currentSessionKey)
        ?? DEFAULT_CANONICAL_PREFIX;
      const newKey = `${prefix}:session-${Date.now()}`;
      const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
      set((s) => ({
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
        messages: [],
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        error: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
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
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
        ),
      }));
    },

    // ── Load chat history ──

  };
}

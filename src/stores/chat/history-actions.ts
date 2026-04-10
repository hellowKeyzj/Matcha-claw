import { hostApiFetch, hostGatewayRequest } from '@/lib/host-api';
import {
  clearHistoryPoll,
  enrichWithCachedImages,
  enrichWithToolResultFiles,
  getMessageText,
  hasNonToolAssistantContent,
  isInternalMessage,
  isToolResultRole,
  loadMissingPreviews,
  toMs,
} from './helpers';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import type { AttachedFileMeta, RawMessage } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';

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

export function createHistoryActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadHistory'> {
  return {
    loadHistory: async (quiet = false) => {
      const { currentSessionKey } = get();
      const requestedSessionKey = currentSessionKey;
      const isStaleRequest = () => get().currentSessionKey !== requestedSessionKey;
      if (!quiet) set({ loading: true, error: null });

      const applyLoadedMessages = (rawMessages: RawMessage[], thinkingLevel: string | null) => {
        if (isStaleRequest()) {
          return;
        }
        // Before filtering: attach images/files from tool_result messages to the next assistant message
        const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
        const filteredMessages = messagesWithToolImages.filter((msg) => (
          !isToolResultRole(msg.role) && !isInternalMessage(msg)
        ));
        // Restore file attachments for user/assistant messages (from cache + text patterns)
        const enrichedMessages = enrichWithCachedImages(filteredMessages);

        // Preserve the optimistic user message during an active send.
        // The Gateway may not include the user's message in chat.history
        // until the run completes, causing it to flash out of the UI.
        let finalMessages = enrichedMessages;
        const userMsgAt = get().lastUserMessageAt;
        if (get().sending && userMsgAt) {
          const userMsMs = toMs(userMsgAt);
          const hasRecentUser = enrichedMessages.some(
            (m) => m.role === 'user' && m.timestamp && Math.abs(toMs(m.timestamp) - userMsMs) < 5000,
          );
          if (!hasRecentUser) {
            const currentMsgs = get().messages;
            const optimistic = [...currentMsgs].reverse().find(
              (m) => m.role === 'user' && m.timestamp && Math.abs(toMs(m.timestamp) - userMsMs) < 5000,
            );
            if (optimistic) {
              finalMessages = [...enrichedMessages, optimistic];
            }
          }
        }

        set({ messages: finalMessages, thinkingLevel, loading: false, error: null });

        // Extract first user message text as a session label for display in the toolbar.
        // Skip main sessions (key ends with ":main") — they rely on the Gateway-provided
        // displayName (e.g. the configured agent name "ClawX") instead.
        const isMainSession = currentSessionKey.endsWith(':main');
        if (!isMainSession) {
          const firstUserMsg = finalMessages.find((m) => m.role === 'user');
          if (firstUserMsg) {
            const labelText = getMessageText(firstUserMsg.content).trim();
            if (labelText) {
              const truncated = labelText.length > 50 ? `${labelText.slice(0, 50)}…` : labelText;
              set((s) => ({
                sessionLabels: { ...s.sessionLabels, [currentSessionKey]: truncated },
              }));
            }
          }
        }

        // Record last activity time from the last message in history
        const lastMsg = finalMessages[finalMessages.length - 1];
        if (lastMsg?.timestamp) {
          const lastAt = toMs(lastMsg.timestamp);
          set((s) => ({
            sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: lastAt },
          }));
        }

        // Async: load missing image previews from disk (updates in background)
        loadMissingPreviews(finalMessages).then((updated) => {
          if (!updated || isStaleRequest()) {
            return;
          }
          const cloneAttachedFiles = (files: AttachedFileMeta[]): AttachedFileMeta[] => {
            return files.map((file) => ({ ...file }));
          };
          const buildMessageIdentity = (message: RawMessage): string => {
            const record = message as unknown as Record<string, unknown>;
            const id = typeof record.id === 'string' ? record.id.trim() : '';
            if (id) {
              return `id:${id}`;
            }
            const role = typeof message.role === 'string' ? message.role : '';
            const timestamp = message.timestamp !== undefined ? String(message.timestamp) : '';
            const content = typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content ?? null);
            return `sig:${role}|${timestamp}|${content}`;
          };
          const previewsByIdentity = new Map<string, AttachedFileMeta[]>();
          for (const message of finalMessages) {
            if (!message._attachedFiles || message._attachedFiles.length === 0) {
              continue;
            }
            previewsByIdentity.set(
              buildMessageIdentity(message),
              cloneAttachedFiles(message._attachedFiles),
            );
          }
          if (previewsByIdentity.size === 0) {
            return;
          }
          set((state) => {
            if (state.currentSessionKey !== requestedSessionKey) {
              return {};
            }
            const nextMessages = state.messages.map((message) => {
              const previewFiles = previewsByIdentity.get(buildMessageIdentity(message as RawMessage));
              if (!previewFiles) {
                return message;
              }
              return {
                ...message,
                _attachedFiles: cloneAttachedFiles(previewFiles),
              };
            });
            return { messages: nextMessages };
          });
        });
        const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();

        // If we're sending but haven't received streaming events, check
        // whether the loaded history reveals intermediate tool-call activity.
        // This surfaces progress via the pendingFinal → ActivityIndicator path.
        const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
        const isAfterUserMsg = (msg: RawMessage): boolean => {
          if (!userMsTs || !msg.timestamp) return true;
          return toMs(msg.timestamp) >= userMsTs;
        };

        if (isSendingNow && !pendingFinal) {
          const hasRecentAssistantActivity = [...filteredMessages].reverse().some((msg) => {
            if (msg.role !== 'assistant') return false;
            return isAfterUserMsg(msg);
          });
          if (hasRecentAssistantActivity) {
            set({ pendingFinal: true });
          }
        }

        // If pendingFinal, check whether the AI produced a final text response.
        if (pendingFinal || get().pendingFinal) {
          const recentAssistant = [...filteredMessages].reverse().find((msg) => {
            if (msg.role !== 'assistant') return false;
            if (!hasNonToolAssistantContent(msg)) return false;
            return isAfterUserMsg(msg);
          });
          if (recentAssistant) {
            clearHistoryPoll();
            set({ sending: false, activeRunId: null, pendingFinal: false });
          }
        }
      };

      try {
        const result = await hostGatewayRequest<Record<string, unknown>>(
          'chat.history',
          { sessionKey: currentSessionKey, limit: 200 },
        );
        if (isStaleRequest()) {
          return;
        }

        if (result.success && result.result) {
          const data = result.result;
          let rawMessages = Array.isArray(data.messages) ? data.messages as RawMessage[] : [];
          const thinkingLevel = data.thinkingLevel ? String(data.thinkingLevel) : null;
          if (rawMessages.length === 0 && isCronSessionKey(currentSessionKey)) {
            rawMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          }
          applyLoadedMessages(rawMessages, thinkingLevel);
        } else {
          const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          if (isStaleRequest()) {
            return;
          }
          if (fallbackMessages.length > 0) {
            applyLoadedMessages(fallbackMessages, null);
          } else {
            set({ loading: false, error: result.error ? String(result.error) : null });
          }
        }
      } catch (err) {
        console.warn('Failed to load chat history:', err);
        const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
        if (isStaleRequest()) {
          return;
        }
        if (fallbackMessages.length > 0) {
          applyLoadedMessages(fallbackMessages, null);
        } else {
          set({ loading: false, error: String(err) });
        }
      }
    },
  };
}

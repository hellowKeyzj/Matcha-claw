import {
  hostSessionDelete,
  hostSessionList,
  hostSessionPrompt,
  hostSessionWindowFetch,
} from '@/lib/host-api';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatSession } from '@/stores/chat/types';
import {
  findLatestAssistantSnapshotFromTimelineEntries,
  findLatestAssistantTextFromTimelineEntries,
} from '@/stores/chat/timeline-message';

export interface AssistantSnapshot {
  text: string;
  toolNames: string[];
}

export interface FetchChatHistoryInput {
  sessionKey: string;
  limit?: number;
}

export interface FetchChatTimelineInput {
  sessionKey: string;
  limit?: number;
}

export interface SendChatMessageInput {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey?: string;
}

export interface DeleteSessionInput {
  key: string;
}

export interface ListSessionsInput {
  limit?: number;
  offset?: number;
}

const DEFAULT_CHAT_HISTORY_LIMIT = 20;

function resolveAuthoritativeTimelineEntries(
  payload: Awaited<ReturnType<typeof hostSessionWindowFetch>>,
): SessionTimelineEntry[] {
  return Array.isArray(payload?.snapshot?.entries) ? payload.snapshot.entries : [];
}

export async function fetchChatTimeline(
  input: FetchChatTimelineInput,
): Promise<SessionTimelineEntry[]> {
  const history = await hostSessionWindowFetch({
    sessionKey: input.sessionKey,
    mode: 'latest',
    limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
    includeCanonical: true,
  });
  return resolveAuthoritativeTimelineEntries(history);
}

export async function fetchLatestAssistantText(
  input: FetchChatHistoryInput,
): Promise<string> {
  const entries = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    limit: input.limit,
  });
  return findLatestAssistantTextFromTimelineEntries(entries);
}

export async function fetchLatestAssistantSnapshot(
  input: FetchChatHistoryInput,
): Promise<AssistantSnapshot> {
  const entries = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    limit: input.limit,
  });
  return findLatestAssistantSnapshotFromTimelineEntries(entries);
}

export async function sendChatMessage(
  input: SendChatMessageInput,
): Promise<Awaited<ReturnType<typeof hostSessionPrompt>>> {
  return await hostSessionPrompt({
    sessionKey: input.sessionKey,
    message: input.message,
    deliver: input.deliver,
    promptId: input.idempotencyKey,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function deleteSession(
  input: DeleteSessionInput,
): Promise<void> {
  await hostSessionDelete({
    sessionKey: input.key,
  });
}

export async function listSessions(
  input?: ListSessionsInput,
): Promise<ChatSession[]> {
  void input;
  const result = await hostSessionList();
  return Array.isArray(result.sessions) ? result.sessions as ChatSession[] : [];
}

import {
  hostSessionDelete,
  hostSessionList,
  hostSessionPrompt,
  hostSessionWindowFetch,
} from '@/lib/host-api';
import type { SessionRenderRow } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatSession } from '@/stores/chat/types';
import {
  findLatestAssistantSnapshotFromRows,
  findLatestAssistantTextFromRows,
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

function resolveAuthoritativeRows(
  payload: Awaited<ReturnType<typeof hostSessionWindowFetch>>,
): SessionRenderRow[] {
  return Array.isArray(payload?.snapshot?.rows) ? payload.snapshot.rows : [];
}

export async function fetchChatTimeline(
  input: FetchChatTimelineInput,
): Promise<SessionRenderRow[]> {
  const history = await hostSessionWindowFetch({
    sessionKey: input.sessionKey,
    mode: 'latest',
    limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
    includeCanonical: true,
  });
  return resolveAuthoritativeRows(history);
}

export async function fetchLatestAssistantText(
  input: FetchChatHistoryInput,
): Promise<string> {
  const rows = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    limit: input.limit,
  });
  return findLatestAssistantTextFromRows(rows);
}

export async function fetchLatestAssistantSnapshot(
  input: FetchChatHistoryInput,
): Promise<AssistantSnapshot> {
  const rows = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    limit: input.limit,
  });
  return findLatestAssistantSnapshotFromRows(rows);
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

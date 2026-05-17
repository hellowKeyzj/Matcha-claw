import {
  hostSessionDelete,
  hostSessionArchive,
  hostSessionUnarchive,
  hostSessionUpdateStatus,
  hostSessionList,
  hostSessionPrompt,
  hostSessionWindowFetch,
} from '@/lib/host-api';
import type { SessionRenderItem } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatSession } from '@/stores/chat/types';
import {
  findLatestAssistantSnapshotFromItems,
  findLatestAssistantTextFromItems,
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

function resolveAuthoritativeItems(
  payload: Awaited<ReturnType<typeof hostSessionWindowFetch>>,
): SessionRenderItem[] {
  return Array.isArray(payload?.snapshot?.items) ? payload.snapshot.items : [];
}

export async function fetchChatTimeline(
  input: FetchChatTimelineInput,
): Promise<SessionRenderItem[]> {
  const history = await hostSessionWindowFetch({
    sessionKey: input.sessionKey,
    mode: 'latest',
    limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
    includeCanonical: true,
  });
  return resolveAuthoritativeItems(history);
}

export async function fetchLatestAssistantText(
  input: FetchChatHistoryInput,
): Promise<string> {
  const items = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    limit: input.limit,
  });
  return findLatestAssistantTextFromItems(items);
}

export async function fetchLatestAssistantSnapshot(
  input: FetchChatHistoryInput,
): Promise<AssistantSnapshot> {
  const items = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    limit: input.limit,
  });
  return findLatestAssistantSnapshotFromItems(items);
}

export async function sendChatMessage(
  input: SendChatMessageInput,
): Promise<Awaited<ReturnType<typeof hostSessionPrompt>>> {
  return await hostSessionPrompt({
    sessionKey: input.sessionKey,
    message: input.message,
    deliver: input.deliver,
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

export async function archiveSession(input: DeleteSessionInput): Promise<void> {
  await hostSessionArchive({
    sessionKey: input.key,
  });
}

export async function unarchiveSession(input: DeleteSessionInput): Promise<void> {
  await hostSessionUnarchive({
    sessionKey: input.key,
  });
}

export async function updateSessionStatus(input: {
  key: string;
  status: 'active' | 'completed' | 'archived' | 'deleted';
}): Promise<void> {
  await hostSessionUpdateStatus({
    sessionKey: input.key,
    status: input.status,
  });
}

export async function listSessions(
  input?: ListSessionsInput,
): Promise<ChatSession[]> {
  void input;
  const result = await hostSessionList();
  return Array.isArray(result.sessions) ? result.sessions as ChatSession[] : [];
}

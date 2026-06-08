import {
  hostSessionDelete,
  hostSessionArchive,
  hostSessionUnarchive,
  hostSessionUpdateStatus,
  hostSessionList,
  hostSessionPrompt,
  hostSessionWindowFetch,
  resolveHydratedSessionSnapshot,
} from '@/lib/host-api';
import type { RuntimeEndpointRef, SessionIdentity } from '../../../runtime-host/shared/runtime-address';
import type { SessionRenderItem, SessionStateSnapshot } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatSession } from '@/stores/chat/types';
import {
  findLatestAssistantSnapshotFromItems,
  findLatestAssistantTextFromItems,
  findLatestAssistantTurnTextFromItems,
} from '@/stores/chat/timeline-message';

export interface AssistantSnapshot {
  text: string;
  toolNames: string[];
}

export interface FetchChatHistoryInput {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  limit?: number;
}

export interface FetchChatTimelineInput {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  limit?: number;
}

export interface SendChatMessageInput {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  message: string;
  deliver?: boolean;
  idempotencyKey?: string;
}

export interface DeleteSessionInput {
  key: string;
  sessionIdentity: SessionIdentity;
}

export interface ListSessionsInput {
  endpoint: RuntimeEndpointRef;
  limit?: number;
  offset?: number;
}

const DEFAULT_CHAT_HISTORY_LIMIT = 20;

function resolveAuthoritativeItems(
  snapshot: SessionStateSnapshot,
): SessionRenderItem[] {
  return Array.isArray(snapshot.items) ? snapshot.items : [];
}

export async function fetchChatTimeline(
  input: FetchChatTimelineInput,
): Promise<SessionRenderItem[]> {
  const initial = await hostSessionWindowFetch({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    mode: 'latest',
    limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
    includeCanonical: true,
  });
  const snapshot = await resolveHydratedSessionSnapshot({
    initial,
    refetch: async () => await hostSessionWindowFetch({
      sessionKey: input.sessionKey,
      sessionIdentity: input.sessionIdentity,
      mode: 'latest',
      limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
      includeCanonical: true,
    }),
  });
  return snapshot ? resolveAuthoritativeItems(snapshot) : [];
}

export async function fetchLatestAssistantText(
  input: FetchChatHistoryInput,
): Promise<string> {
  const items = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    limit: input.limit,
  });
  return findLatestAssistantTextFromItems(items);
}

export async function fetchLatestAssistantTurnText(
  input: FetchChatHistoryInput,
): Promise<string> {
  const items = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    limit: input.limit,
  });
  return findLatestAssistantTurnTextFromItems(items);
}

export async function fetchLatestAssistantSnapshot(
  input: FetchChatHistoryInput,
): Promise<AssistantSnapshot> {
  const items = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    limit: input.limit,
  });
  return findLatestAssistantSnapshotFromItems(items);
}

export async function sendChatMessage(
  input: SendChatMessageInput,
): Promise<Awaited<ReturnType<typeof hostSessionPrompt>>> {
  return await hostSessionPrompt({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
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
    sessionIdentity: input.sessionIdentity,
  });
}

export async function archiveSession(input: DeleteSessionInput): Promise<void> {
  await hostSessionArchive({
    sessionKey: input.key,
    sessionIdentity: input.sessionIdentity,
  });
}

export async function unarchiveSession(input: DeleteSessionInput): Promise<void> {
  await hostSessionUnarchive({
    sessionKey: input.key,
    sessionIdentity: input.sessionIdentity,
  });
}

export async function updateSessionStatus(input: {
  key: string;
  sessionIdentity: SessionIdentity;
  status: 'active' | 'completed' | 'archived' | 'deleted';
}): Promise<void> {
  await hostSessionUpdateStatus({
    sessionKey: input.key,
    sessionIdentity: input.sessionIdentity,
    status: input.status,
  });
}

export async function listSessions(
  input: ListSessionsInput,
): Promise<ChatSession[]> {
  const result = await hostSessionList({ endpoint: input.endpoint });
  return Array.isArray(result.sessions) ? result.sessions as ChatSession[] : [];
}

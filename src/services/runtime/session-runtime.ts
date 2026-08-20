import {
  hostSessionDelete,
  hostSessionArchive,
  hostSessionUnarchive,
  hostSessionUpdateStatus,
  hostSessionList,
  hostSessionPrompt,
  hostSessionWindowFetch,
} from '@/lib/host-api';
import {
  buildSessionIdentityKey,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
import type { SessionRenderItem } from '../../types/session/render-item';
import { decodeHistorySessionView, resolveSessionViewError } from '@/stores/chat/history-fetch-helpers';
import { projectSessionViewItems } from '@/stores/chat/store-state-helpers';
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
  endpointSessionId?: string;
  limit?: number;
}

export interface FetchChatTimelineInput {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  endpointSessionId?: string;
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

export async function fetchChatTimeline(
  input: FetchChatTimelineInput,
): Promise<SessionRenderItem[]> {
  try {
    const view = decodeHistorySessionView(await hostSessionWindowFetch({
      sessionKey: input.sessionKey,
      ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
      sessionIdentity: input.sessionIdentity,
      mode: 'latest',
      limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
      includeCanonical: true,
    }));
    return projectSessionViewItems(view);
  } catch (error) {
    throw resolveSessionViewError(error);
  }
}

export async function fetchLatestAssistantText(
  input: FetchChatHistoryInput,
): Promise<string> {
  const items = await fetchChatTimeline({
    sessionKey: input.sessionKey,
    sessionIdentity: input.sessionIdentity,
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
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
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
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
    ...(input.endpointSessionId ? { endpointSessionId: input.endpointSessionId } : {}),
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
  return result.sessions.map((session) => ({
    key: buildSessionIdentityKey(session.sessionIdentity),
    backendSessionKey: session.key,
    agentId: session.agentId,
    sessionIdentity: session.sessionIdentity,
    kind: session.kind === 'main' || session.kind === 'subsession' || session.kind === 'session' || session.kind === 'named'
      ? session.kind
      : 'named',
    preferred: session.preferred === true,
    ...(session.protocolId ? { protocolId: session.protocolId } : {}),
    ...(session.runtimeEndpointId ? { runtimeEndpointId: session.runtimeEndpointId } : {}),
    ...(session.endpointSessionId ? { endpointSessionId: session.endpointSessionId } : {}),
    ...(session.label ? { label: session.label } : {}),
    ...(session.titleSource ? { titleSource: session.titleSource } : {}),
    ...(session.displayName ? { displayName: session.displayName } : {}),
    ...(session.contextTokens ? { contextTokens: session.contextTokens } : {}),
    ...(typeof session.updatedAt === 'number' ? { updatedAt: session.updatedAt } : {}),
  }));
}

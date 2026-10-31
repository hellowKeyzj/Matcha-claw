import { selectAgentsResource, useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { extractGeneratedFilesFromToolCards } from '@/plugins/files/generated-files';
import { resolveWorkspaceRelativePath } from '@/plugins/files/types';
import { sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { useChatStore } from './store';

export interface SessionMediaEntry {
  readonly key: string;
  readonly name: string;
  readonly mimeType: string;
  readonly source: { readonly kind: 'workspace'; readonly relativePath: string };
}

export interface SessionMediaSnapshot {
  readonly scope: 'loaded-window';
  readonly items: readonly SessionMediaEntry[];
}

function sessionMediaInputs(identity: SessionIdentity) {
  const state = useChatStore.getState();
  const conversation = state.currentConversation;
  const record = conversation?.kind === 'session'
    && sessionIdentitiesEqual(conversation.sessionIdentity, identity)
    ? state.loadedSessions[conversation.sessionRecordKey] : undefined;
  const items = record?.meta.sessionIdentity && sessionIdentitiesEqual(record.meta.sessionIdentity, identity)
    ? record.items : undefined;
  const workspaceRoot = selectAgentsResource(useSubagentsStore.getState(), identity.endpoint).data
    .find((agent) => agent.id === identity.agentId)?.workspace?.trim();
  return { items, workspaceRoot };
}

function projectSessionMedia(identity: SessionIdentity, { items, workspaceRoot }: ReturnType<typeof sessionMediaInputs>): SessionMediaSnapshot {
  const entries = new Map<string, SessionMediaEntry>();
  const append = (owner: 'message' | 'tool', id: string, filePath: string, name: string, mimeType: string) => {
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) return;
    const relativePath = resolveWorkspaceRelativePath(filePath, workspaceRoot);
    if (!relativePath) return;
    const key = JSON.stringify([owner, id, workspaceRoot ?? null, relativePath]);
    entries.set(key, { key, name, mimeType, source: { kind: 'workspace', relativePath } });
  };
  for (const item of items ?? []) {
    if (item.sessionKey !== identity.sessionKey) continue;
    if (item.kind === 'user-message') {
      if (!item.messageId || item.status === 'pending' || item.status === 'sending') continue;
      for (const file of item.attachedFiles) {
        if (file.filePath && !file.attachmentStatus && !file.gatewayUrl && !file.mediaReference) {
          append('message', item.messageId, file.filePath, file.fileName, file.mimeType);
        }
      }
    } else if (item.kind === 'assistant-turn') {
      const tools = item.tools.filter((tool) => tool.status === 'completed' && tool.toolCallId);
      for (const file of extractGeneratedFilesFromToolCards(tools)) {
        if (file.action !== 'deleted' && file.toolCallId) {
          append('tool', file.toolCallId, file.filePath, file.fileName, file.mimeType);
        }
      }
    }
  }
  return { scope: 'loaded-window', items: [...entries.values()] };
}

/** Readable originals in the current loaded window, not a complete history scan. */
export function readSessionMedia(identity: SessionIdentity): SessionMediaSnapshot {
  return projectSessionMedia(identity, sessionMediaInputs(identity));
}

export function subscribeSessionMedia(identity: SessionIdentity, onChanged: () => void): () => void {
  let inputs = sessionMediaInputs(identity);
  let snapshot = projectSessionMedia(identity, inputs);
  const changed = () => {
    const nextInputs = sessionMediaInputs(identity);
    if (nextInputs.items === inputs.items && nextInputs.workspaceRoot === inputs.workspaceRoot) return;
    inputs = nextInputs;
    const next = projectSessionMedia(identity, inputs);
    const previous = snapshot;
    snapshot = next;
    if (next.items.length !== previous.items.length || next.items.some((entry, index) => {
      const before = previous.items[index];
      return !before || entry.key !== before.key || entry.name !== before.name || entry.mimeType !== before.mimeType;
    })) onChanged();
  };
  const unsubscribeChat = useChatStore.subscribe(changed);
  const unsubscribeAgents = useSubagentsStore.subscribe(changed);
  return () => { unsubscribeChat(); unsubscribeAgents(); };
}

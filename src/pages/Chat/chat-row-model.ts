import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { getOrBuildAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { resolveAssistantEntryLaneIdentity } from '@/stores/chat/session-turn-state';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatMessageView } from './chat-message-view';
import { getOrBuildChatMessageView } from './chat-message-view';
import { extractEntryText } from './message-utils';

export interface ChatAssistantPresentation {
  agentId?: string;
  agentName?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

export interface ChatMessageRow {
  key: string;
  kind: 'message';
  entry: SessionTimelineEntry;
  role: 'user' | 'assistant' | 'system';
  text: string;
  assistantTurnKey: string | null;
  assistantLaneKey: string | null;
  assistantLaneAgentId: string | null;
  messageView: ChatMessageView;
  assistantMarkdownHtml: string | null;
  assistantPresentation: ChatAssistantPresentation | null;
}

export type ChatRow = ChatMessageRow;

export function buildAssistantLaneTurnMatchKey(
  turnKey: string | null | undefined,
  laneKey: string | null | undefined,
): string | null {
  const normalizedTurnKey = typeof turnKey === 'string' ? turnKey.trim() : '';
  const normalizedLaneKey = typeof laneKey === 'string' ? laneKey.trim() : '';
  if (!normalizedTurnKey || !normalizedLaneKey) {
    return null;
  }
  return `${normalizedTurnKey}|${normalizedLaneKey}`;
}

export function resolveEntryAssistantLaneTurnMatchKey(
  entry: SessionTimelineEntry | null | undefined,
): string | null {
  if (!entry) {
    return null;
  }
  const laneIdentity = resolveAssistantEntryLaneIdentity(entry);
  return buildAssistantLaneTurnMatchKey(laneIdentity.turnKey, laneIdentity.laneKey);
}

export function resolveRowAssistantLaneTurnMatchKey(
  row: ChatMessageRow,
): string | null {
  return buildAssistantLaneTurnMatchKey(row.assistantTurnKey, row.assistantLaneKey);
}

interface BuildStaticChatRowsInput {
  sessionKey: string;
  entries: SessionTimelineEntry[];
}

interface BuildStaticChatRowsResult {
  rows: ChatMessageRow[];
  renderableCount: number;
}

export function canAppendReferenceList<T>(
  previous: T[],
  next: T[],
): boolean {
  if (previous.length > next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

export function canPrependReferenceList<T>(
  previous: T[],
  next: T[],
): boolean {
  if (previous.length > next.length) {
    return false;
  }
  const offset = next.length - previous.length;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[offset + index]) {
      return false;
    }
  }
  return true;
}

export function isRenderableTimelineEntry(entry: SessionTimelineEntry): boolean {
  return entry.role !== 'toolresult' && entry.role !== 'tool_result';
}

function resolveRenderableEntryRole(entry: SessionTimelineEntry): ChatMessageRow['role'] {
  return entry.role === 'user' || entry.role === 'system' ? entry.role : 'assistant';
}

function createMessageRow(
  key: string,
  entry: SessionTimelineEntry,
): ChatMessageRow {
  const role = resolveRenderableEntryRole(entry);
  const messageView = getOrBuildChatMessageView(entry);
  const laneIdentity = role === 'assistant'
    ? resolveAssistantEntryLaneIdentity(entry)
    : { turnKey: null, laneKey: null, agentId: null };
  return {
    key,
    kind: 'message',
    entry,
    role,
    text: extractEntryText(entry),
    assistantTurnKey: laneIdentity.turnKey,
    assistantLaneKey: laneIdentity.laneKey,
    assistantLaneAgentId: laneIdentity.agentId,
    messageView,
    assistantMarkdownHtml: role === 'assistant'
      ? (getOrBuildAssistantMarkdownBody(entry)?.fullHtml ?? null)
      : null,
    assistantPresentation: null,
  };
}

export function resolveTimelineEntryRowKey(
  sessionKey: string,
  entry: SessionTimelineEntry,
): string {
  return `session:${sessionKey}|entry:${entry.entryId}`;
}

function buildEntryRow(
  sessionKey: string,
  entry: SessionTimelineEntry,
  usedRowKeys: Set<string>,
): ChatMessageRow {
  const baseKey = resolveTimelineEntryRowKey(sessionKey, entry);
  let rowKey = baseKey;
  let duplicateOrdinal = 1;
  while (usedRowKeys.has(rowKey)) {
    rowKey = `${baseKey}|dup:${duplicateOrdinal}`;
    duplicateOrdinal += 1;
  }
  usedRowKeys.add(rowKey);
  return createMessageRow(rowKey, entry);
}

export function appendTimelineRows(
  sessionKey: string,
  baseRows: ChatMessageRow[],
  entries: SessionTimelineEntry[],
  fromIndex: number,
  startRenderableIndex: number,
): {
  rows: ChatMessageRow[];
  renderableCount: number;
} {
  if (fromIndex >= entries.length) {
    return {
      rows: baseRows,
      renderableCount: startRenderableIndex,
    };
  }

  const rows = [...baseRows];
  const usedRowKeys = new Set(rows.map((row) => row.key));
  let renderableCount = startRenderableIndex;
  for (let index = fromIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRenderableTimelineEntry(entry)) {
      continue;
    }
    rows.push(buildEntryRow(sessionKey, entry, usedRowKeys));
    renderableCount += 1;
  }

  return {
    rows,
    renderableCount,
  };
}

export function prependTimelineRows(
  sessionKey: string,
  baseRows: ChatMessageRow[],
  entries: SessionTimelineEntry[],
  toIndexExclusive: number,
  startRenderableCount: number,
): {
  rows: ChatMessageRow[];
  renderableCount: number;
} {
  if (toIndexExclusive <= 0) {
    return {
      rows: baseRows,
      renderableCount: startRenderableCount,
    };
  }

  const prependedRows: ChatMessageRow[] = [];
  const usedRowKeys = new Set(baseRows.map((row) => row.key));
  let prependedRenderableCount = 0;
  for (let index = 0; index < toIndexExclusive; index += 1) {
    const entry = entries[index];
    if (!isRenderableTimelineEntry(entry)) {
      continue;
    }
    prependedRows.push(buildEntryRow(sessionKey, entry, usedRowKeys));
    prependedRenderableCount += 1;
  }

  return {
    rows: prependedRows.length > 0 ? [...prependedRows, ...baseRows] : baseRows,
    renderableCount: startRenderableCount + prependedRenderableCount,
  };
}

export function patchTimelineRows(
  sessionKey: string,
  baseRows: ChatMessageRow[],
  previousEntries: SessionTimelineEntry[],
  nextEntries: SessionTimelineEntry[],
): {
  rows: ChatMessageRow[];
  renderableCount: number;
} | null {
  if (previousEntries.length !== nextEntries.length) {
    return null;
  }

  const usedRowKeys = new Set<string>();
  const nextRows: ChatMessageRow[] = [];
  let previousRenderableIndex = 0;
  let renderableCount = 0;

  for (let index = 0; index < nextEntries.length; index += 1) {
    const previousEntry = previousEntries[index];
    const nextEntry = nextEntries[index];
    const previousRenderable = isRenderableTimelineEntry(previousEntry);
    const nextRenderable = isRenderableTimelineEntry(nextEntry);

    if (previousRenderable !== nextRenderable) {
      return null;
    }
    if (!nextRenderable) {
      continue;
    }

    const previousRow = baseRows[previousRenderableIndex];
    if (!previousRow) {
      return null;
    }

    const baseKey = resolveTimelineEntryRowKey(sessionKey, nextEntry);
    let nextRowKey = baseKey;
    let duplicateOrdinal = 1;
    while (usedRowKeys.has(nextRowKey)) {
      nextRowKey = `${baseKey}|dup:${duplicateOrdinal}`;
      duplicateOrdinal += 1;
    }
    usedRowKeys.add(nextRowKey);

    if (previousRow.key !== nextRowKey) {
      return null;
    }

    nextRows.push(previousEntry === nextEntry ? previousRow : createMessageRow(nextRowKey, nextEntry));
    previousRenderableIndex += 1;
    renderableCount += 1;
  }

  if (previousRenderableIndex !== baseRows.length) {
    return null;
  }

  return {
    rows: nextRows,
    renderableCount,
  };
}

export function buildStaticChatRows({
  sessionKey,
  entries,
}: BuildStaticChatRowsInput): ChatMessageRow[] {
  return buildTimelineRowsWithMeta({
    sessionKey,
    entries,
  }).rows;
}

export function buildTimelineRowsWithMeta({
  sessionKey,
  entries,
}: Pick<BuildStaticChatRowsInput, 'sessionKey' | 'entries'>): BuildStaticChatRowsResult {
  const rows: ChatMessageRow[] = [];
  const usedRowKeys = new Set<string>();
  let renderableCount = 0;
  for (const entry of entries) {
    if (!isRenderableTimelineEntry(entry)) {
      continue;
    }
    rows.push(buildEntryRow(sessionKey, entry, usedRowKeys));
    renderableCount += 1;
  }
  return {
    rows,
    renderableCount,
  };
}

export interface ChatAssistantCatalogAgent extends ChatAssistantPresentation {
  id: string;
}

export function resolveAssistantPresentationForLaneAgentId(input: {
  agentId: string | null | undefined;
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatAssistantPresentation | null {
  const laneAgentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
  if (laneAgentId) {
    const matchedAgent = input.agents.find((agent) => agent.id === laneAgentId);
    if (matchedAgent) {
      return {
        agentId: matchedAgent.id,
        agentName: matchedAgent.agentName ?? matchedAgent.id,
        avatarSeed: matchedAgent.avatarSeed,
        avatarStyle: matchedAgent.avatarStyle,
      };
    }
    return {
      agentId: laneAgentId,
      agentName: laneAgentId,
    };
  }
  return input.defaultAssistant;
}

export function resolveRowAssistantPresentation(input: {
  row: ChatMessageRow;
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatAssistantPresentation | null {
  if (input.row.role !== 'assistant') {
    return null;
  }
  return resolveAssistantPresentationForLaneAgentId({
    agentId: input.row.assistantLaneAgentId,
    agents: input.agents,
    defaultAssistant: input.defaultAssistant,
  });
}

export function applyAssistantPresentationToRows(input: {
  rows: ChatMessageRow[];
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatMessageRow[] {
  let changed = false;
  const nextRows = input.rows.map((row) => {
    const assistantPresentation = resolveRowAssistantPresentation({
      row,
      agents: input.agents,
      defaultAssistant: input.defaultAssistant,
    });
    const currentPresentation = row.assistantPresentation;
    const presentationUnchanged = (
      currentPresentation?.agentId === assistantPresentation?.agentId
      && currentPresentation?.agentName === assistantPresentation?.agentName
      && currentPresentation?.avatarSeed === assistantPresentation?.avatarSeed
      && currentPresentation?.avatarStyle === assistantPresentation?.avatarStyle
    );
    if (presentationUnchanged) {
      return row;
    }
    changed = true;
    return {
      ...row,
      assistantPresentation,
    };
  });
  return changed ? nextRows : input.rows;
}

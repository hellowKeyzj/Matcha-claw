import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { getOrBuildAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import type {
  SessionExecutionGraphRow,
  SessionMessageRow as ProtocolMessageRow,
  SessionPendingAssistantRow as ProtocolPendingAssistantRow,
  SessionRenderRow,
  SessionSystemRow as ProtocolSystemRow,
  SessionTaskCompletionRow as ProtocolTaskCompletionRow,
  SessionToolActivityRow as ProtocolToolActivityRow,
} from '../../../runtime-host/shared/session-adapter-types';

export interface ChatAssistantPresentation {
  agentId?: string;
  agentName?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ChatRowBase {
  assistantPresentation: ChatAssistantPresentation | null;
  renderSignature: string;
}

export type ChatMessageRow = ProtocolMessageRow & ChatRowBase & {
  kind: 'message';
  assistantMarkdownHtml: string | null;
};

export type ChatToolActivityRow = ProtocolToolActivityRow & ChatRowBase;
export type ChatExecutionGraphRow = SessionExecutionGraphRow & ChatRowBase;
export type ChatPendingAssistantRow = ProtocolPendingAssistantRow & ChatRowBase;
export type ChatTaskCompletionRow = ProtocolTaskCompletionRow & ChatRowBase;
export type ChatSystemRow = ProtocolSystemRow & ChatRowBase;

export type ChatRow =
  | ChatMessageRow
  | ChatToolActivityRow
  | ChatExecutionGraphRow
  | ChatPendingAssistantRow
  | ChatTaskCompletionRow
  | ChatSystemRow;

export interface ChatAssistantCatalogAgent extends ChatAssistantPresentation {
  id: string;
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

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

export function resolveRowAssistantLaneTurnMatchKey(row: ChatRow): string | null {
  return buildAssistantLaneTurnMatchKey(row.assistantTurnKey, row.assistantLaneKey);
}

function buildRenderSignature(row: SessionRenderRow): string {
  return [
    row.key,
    row.kind,
    row.role,
    row.status ?? '',
    row.createdAt ?? '',
    hashStringDjb2(safeStableStringify(row)),
  ].join('|');
}

function decorateProtocolRow(row: SessionRenderRow): ChatRow {
  const base = {
    assistantPresentation: null,
    renderSignature: buildRenderSignature(row),
  } satisfies ChatRowBase;

  if (row.kind === 'message') {
    return {
      ...row,
      ...base,
      assistantMarkdownHtml: row.role === 'assistant'
        ? (getOrBuildAssistantMarkdownBody(row)?.fullHtml ?? null)
        : null,
    };
  }

  return {
    ...row,
    ...base,
  } as ChatRow;
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
  row: ChatRow;
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
  rows: SessionRenderRow[];
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatRow[] {
  return input.rows.map((protocolRow) => {
    const row = decorateProtocolRow(protocolRow);
    return {
      ...row,
      assistantPresentation: resolveRowAssistantPresentation({
        row,
        agents: input.agents,
        defaultAssistant: input.defaultAssistant,
      }),
    };
  });
}

import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { getOrBuildAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { getAssistantTurnPlainText } from './chat-message-view';
import type {
  SessionAssistantMessageSegment,
  SessionAssistantTurnItem,
  SessionRenderExecutionGraphItem,
  SessionRenderItem,
  SessionRenderSystemItem,
  SessionRenderTaskCompletionItem,
  SessionRenderUserMessageItem,
} from '../../../runtime-host/shared/session-adapter-types';

export interface ChatAssistantPresentation {
  agentId?: string;
  agentName?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ChatRenderItemBase {
  assistantPresentation: ChatAssistantPresentation | null;
  renderSignature: string;
}

export type ChatUserMessageItem = SessionRenderUserMessageItem & ChatRenderItemBase;
export type ChatAssistantTurnItem = SessionAssistantTurnItem & ChatRenderItemBase & {
  assistantMarkdownHtml: string | null;
  assistantSegmentMarkdownHtmlByKey: Record<string, string>;
};
export type ChatExecutionGraphItem = SessionRenderExecutionGraphItem & ChatRenderItemBase;
export type ChatTaskCompletionItem = SessionRenderTaskCompletionItem & ChatRenderItemBase;
export type ChatSystemItem = SessionRenderSystemItem & ChatRenderItemBase;

export type ChatRenderItem =
  | ChatUserMessageItem
  | ChatAssistantTurnItem
  | ChatExecutionGraphItem
  | ChatTaskCompletionItem
  | ChatSystemItem;

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

function buildRenderSignature(item: SessionRenderItem): string {
  return [
    item.key,
    item.kind,
    item.role,
    'status' in item ? (item.status ?? '') : '',
    item.createdAt ?? '',
    hashStringDjb2(safeStableStringify(item)),
  ].join('|');
}

function decorateProtocolItem(item: SessionRenderItem): ChatRenderItem {
  const base = {
    assistantPresentation: null,
    renderSignature: buildRenderSignature(item),
  } satisfies ChatRenderItemBase;

  if (item.kind === 'assistant-turn') {
    const itemTools = Array.isArray(item.tools) ? item.tools : [];
    const plainText = getAssistantTurnPlainText(item);
    const assistantSegmentMarkdownHtmlByKey = Object.fromEntries(
      item.segments
        .filter((segment): segment is SessionAssistantMessageSegment => segment.kind === 'message')
        .map((segment) => {
          const html = getOrBuildAssistantMarkdownBody({
            key: `${item.key}:segment:${segment.key}`,
            role: 'assistant',
            sessionKey: item.sessionKey,
            createdAt: item.createdAt,
            text: segment.text,
            attachedFiles: [],
          } as never)?.fullHtml ?? null;
          return [segment.key, html ?? ''];
        }),
    );
    return {
      ...item,
      ...base,
      assistantMarkdownHtml: plainText
        ? (getOrBuildAssistantMarkdownBody({
            key: item.key,
            kind: 'message',
            sessionKey: item.sessionKey,
            role: 'assistant',
            text: plainText,
            createdAt: item.createdAt,
            thinking: item.thinking,
            images: item.images,
            toolUses: itemTools.map((tool) => ({
              id: tool.id,
              name: tool.name,
              input: tool.input,
            })),
            attachedFiles: item.attachedFiles,
            toolStatuses: itemTools.map((tool) => ({
              ...(tool.id ? { id: tool.id } : {}),
              ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
              name: tool.name,
              status: tool.status,
              ...(tool.summary ? { summary: tool.summary } : {}),
              ...(tool.durationMs != null ? { durationMs: tool.durationMs } : {}),
              ...(tool.updatedAt != null ? { updatedAt: tool.updatedAt } : {}),
              ...(tool.output !== undefined ? { output: tool.output } : {}),
              ...(tool.result.kind === 'canvas' && tool.result.rawText ? { outputText: tool.result.rawText } : {}),
              ...(tool.result.kind === 'text' || tool.result.kind === 'json'
                ? { outputText: tool.result.bodyText }
                : {}),
            })),
            isStreaming: item.status === 'streaming',
          } as never)?.fullHtml ?? null)
        : null,
      assistantSegmentMarkdownHtmlByKey,
    };
  }

  return {
    ...item,
    ...base,
  } as ChatRenderItem;
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

export function resolveItemAssistantPresentation(input: {
  item: ChatRenderItem;
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatAssistantPresentation | null {
  if (input.item.kind !== 'assistant-turn' && input.item.kind !== 'execution-graph') {
    return null;
  }
  return resolveAssistantPresentationForLaneAgentId({
    agentId: input.item.agentId,
    agents: input.agents,
    defaultAssistant: input.defaultAssistant,
  });
}

export function applyAssistantPresentationToItems(input: {
  items: SessionRenderItem[];
  agents: ChatAssistantCatalogAgent[];
  defaultAssistant: ChatAssistantPresentation | null;
}): ChatRenderItem[] {
  return input.items.map((protocolItem) => {
    const item = decorateProtocolItem(protocolItem);
    return {
      ...item,
      assistantPresentation: resolveItemAssistantPresentation({
        item,
        agents: input.agents,
        defaultAssistant: input.defaultAssistant,
      }),
    };
  });
}

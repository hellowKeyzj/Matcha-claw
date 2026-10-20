import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { buildSessionItemDisplaySignature } from '@/stores/chat/session-render-signature';
import type {
  SessionAssistantTurnItem,
  SessionRenderExecutionGraphItem,
  SessionRenderItem,
  SessionRenderSystemItem,
  SessionRenderUserMessageItem,
} from '../../types/session/render-item';

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
export type ChatAssistantTurnItem = SessionAssistantTurnItem & ChatRenderItemBase;
export type ChatExecutionGraphItem = SessionRenderExecutionGraphItem & ChatRenderItemBase;
export type ChatSystemItem = SessionRenderSystemItem & ChatRenderItemBase;

export type ChatRenderItem =
  | ChatUserMessageItem
  | ChatAssistantTurnItem
  | ChatExecutionGraphItem
  | ChatSystemItem;

export interface ChatAssistantCatalogAgent extends ChatAssistantPresentation {
  id: string;
}

function isSameAssistantPresentation(
  left: ChatAssistantPresentation | null,
  right: ChatAssistantPresentation | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.agentId === right.agentId
    && left.agentName === right.agentName
    && left.avatarSeed === right.avatarSeed
    && left.avatarStyle === right.avatarStyle;
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
  item: Pick<SessionRenderItem, 'kind'> & { agentId?: string | null };
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
  previousItems?: ChatRenderItem[];
}): ChatRenderItem[] {
  const previousItemsByKey = new Map(
    (input.previousItems ?? []).map((item) => [item.key, item] as const),
  );
  return input.items.map((protocolItem) => {
    const renderSignature = buildSessionItemDisplaySignature(protocolItem);
    const assistantPresentation = resolveItemAssistantPresentation({
      item: protocolItem,
      agents: input.agents,
      defaultAssistant: input.defaultAssistant,
    });
    const previousItem = previousItemsByKey.get(protocolItem.key);
    if (
      previousItem
      && previousItem.kind === protocolItem.kind
      && previousItem.renderSignature === renderSignature
      && isSameAssistantPresentation(previousItem.assistantPresentation, assistantPresentation)
    ) {
      return previousItem;
    }
    return {
      ...protocolItem,
      renderSignature,
      assistantPresentation,
    } as ChatRenderItem;
  });
}

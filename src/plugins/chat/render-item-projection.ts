import { buildSessionItemDisplaySignature } from '@/plugins/chat/store/session-render-signature';
import type { SessionRenderItem } from '@/types/session/render-item';
import type { ChatAssistantCatalogAgent, ChatAssistantPresentation, ChatRenderItem } from '@/plugins/message-rendering/chat-render-item-model';

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

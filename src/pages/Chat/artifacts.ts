import type { ChatRenderItem, ChatExecutionGraphItem, ChatAssistantTurnItem } from './chat-render-item-model';
import { extractGeneratedFilesFromToolCards, type GeneratedFile } from '@/lib/generated-files';

export interface ChatArtifactGroup {
  graphItemKey: string;
  anchorItemKey?: string;
  triggerItemKey?: string;
  replyItemKey?: string;
  files: GeneratedFile[];
}

function isExecutionGraphItem(item: ChatRenderItem): item is ChatExecutionGraphItem {
  return item.kind === 'execution-graph';
}

function isAssistantTurnItem(item: ChatRenderItem): item is ChatAssistantTurnItem {
  return item.kind === 'assistant-turn';
}

function findReplyTurnForGraph(
  itemsByKey: ReadonlyMap<string, ChatRenderItem>,
  graph: ChatExecutionGraphItem,
): ChatAssistantTurnItem | null {
  if (graph.replyItemKey) {
    const matched = itemsByKey.get(graph.replyItemKey);
    if (matched && isAssistantTurnItem(matched)) {
      return matched;
    }
  }
  return null;
}

export function collectChatArtifactGroups(
  items: ReadonlyArray<ChatRenderItem>,
): ChatArtifactGroup[] {
  const groups: ChatArtifactGroup[] = [];
  const groupedReplyItemKeys = new Set<string>();
  const itemsByKey = new Map<string, ChatRenderItem>();
  for (const item of items) {
    if (!itemsByKey.has(item.key)) itemsByKey.set(item.key, item);
  }

  for (const item of items) {
    if (!isExecutionGraphItem(item)) {
      continue;
    }
    const replyTurn = findReplyTurnForGraph(itemsByKey, item);
    if (!replyTurn) {
      continue;
    }
    const files = extractGeneratedFilesFromToolCards(replyTurn.tools);
    if (files.length === 0) {
      continue;
    }
    if (item.replyItemKey) {
      groupedReplyItemKeys.add(item.replyItemKey);
    }
    groups.push({
      graphItemKey: item.key,
      ...(item.anchorItemKey ? { anchorItemKey: item.anchorItemKey } : {}),
      ...(item.triggerItemKey ? { triggerItemKey: item.triggerItemKey } : {}),
      ...(item.replyItemKey ? { replyItemKey: item.replyItemKey } : {}),
      files,
    });
  }

  for (const item of items) {
    if (!isAssistantTurnItem(item) || groupedReplyItemKeys.has(item.key)) {
      continue;
    }
    const files = extractGeneratedFilesFromToolCards(item.tools);
    if (files.length === 0) {
      continue;
    }
    groups.push({
      graphItemKey: item.key,
      replyItemKey: item.key,
      files,
    });
  }

  return groups;
}

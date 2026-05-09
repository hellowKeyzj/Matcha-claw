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
  items: ReadonlyArray<ChatRenderItem>,
  graph: ChatExecutionGraphItem,
): ChatAssistantTurnItem | null {
  if (graph.replyItemKey) {
    const matched = items.find((item) => item.key === graph.replyItemKey);
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

  for (const item of items) {
    if (!isExecutionGraphItem(item)) {
      continue;
    }
    const replyTurn = findReplyTurnForGraph(items, item);
    if (!replyTurn) {
      continue;
    }
    const files = extractGeneratedFilesFromToolCards(replyTurn.tools);
    if (files.length === 0) {
      continue;
    }
    groups.push({
      graphItemKey: item.key,
      ...(item.anchorItemKey ? { anchorItemKey: item.anchorItemKey } : {}),
      ...(item.triggerItemKey ? { triggerItemKey: item.triggerItemKey } : {}),
      ...(item.replyItemKey ? { replyItemKey: item.replyItemKey } : {}),
      files,
    });
  }

  return groups;
}

import type { ChatRenderItem } from './chat-render-item-model';

function hasAssistantTurnContent(item: Extract<ChatRenderItem, { kind: 'assistant-turn' }>): boolean {
  return item.segments.some((segment) => {
    if (segment.kind === 'tool') {
      return true;
    }
    if (segment.kind === 'message' || segment.kind === 'thinking') {
      return segment.text.trim().length > 0;
    }
    return segment.images.length > 0 || segment.attachedFiles.length > 0;
  });
}

function resolveTailMessageSignalPart(item: ChatRenderItem | null): string {
  if (!item) {
    return '0||';
  }
  const hasContent = item.kind === 'assistant-turn'
    ? (hasAssistantTurnContent(item) ? '1' : '0')
    : ('text' in item && typeof item.text === 'string' && item.text.trim().length > 0 ? '1' : '0');
  const identity = item.kind === 'user-message'
    ? (item.messageId ?? item.key)
    : item.key;
  return [item.key, item.kind, identity, hasContent].join('|');
}

export function buildChatAutoFollowSignal(items: ChatRenderItem[]): string {
  const tailItem = items.at(-1) ?? null;
  return `${items.length}|${resolveTailMessageSignalPart(tailItem)}`;
}

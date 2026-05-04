import type { ChatRenderItem } from './chat-render-item-model';

function resolveTailMessageSignalPart(item: ChatRenderItem | null): string {
  if (!item) {
    return '0||';
  }
  const hasContent = item.kind === 'assistant-turn'
    ? ((item.text.trim().length > 0 || item.toolCalls.length > 0) ? '1' : '0')
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

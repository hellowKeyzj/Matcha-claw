import type { RawMessage } from '@/stores/chat';
import { isRenderableChatMessage, resolveMessageRowKey } from './chat-row-model';
import { extractText } from './message-utils';

function resolveLastMessageSignalPart(
  sessionKey: string,
  message: RawMessage | null,
  renderableIndex: number,
): string {
  if (!message) {
    return '0||';
  }

  const hasContent = extractText(message).trim().length > 0 ? '1' : '0';
  return [
    resolveMessageRowKey(sessionKey, message, renderableIndex),
    typeof message.id === 'string' ? message.id : '',
    hasContent,
  ].join('|');
}

export function buildChatAutoFollowSignal(sessionKey: string, messages: RawMessage[]): string {
  let messageCount = 0;
  let lastMessage: RawMessage | null = null;

  for (const message of messages) {
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    messageCount += 1;
    lastMessage = message;
  }

  return `${messageCount}|${resolveLastMessageSignalPart(sessionKey, lastMessage, Math.max(0, messageCount - 1))}`;
}

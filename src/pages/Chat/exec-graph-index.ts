import type { RawMessage } from '@/stores/chat';
import {
  canAppendMessageList,
  isRenderableChatMessage,
  resolveMessageRowKey,
} from './chat-row-model';
import { parseSubagentCompletionInfo } from './task-viz';
import type {
  AnchorsSnapshot,
  CompletionEventAnchor,
  MessageKeyIndexSnapshot,
} from './exec-graph-types';

export function buildMessageKeyIndex(
  sessionKey: string,
  messages: RawMessage[],
  previous?: MessageKeyIndexSnapshot,
): MessageKeyIndexSnapshot {
  if (previous && canAppendMessageList(previous.messagesRef, messages)) {
    const keyByIndex = new Map(previous.keyByIndex);
    let renderableCount = previous.renderableCount;
    for (let index = previous.messagesRef.length; index < messages.length; index += 1) {
      const message = messages[index];
      if (!isRenderableChatMessage(message)) {
        continue;
      }
      keyByIndex.set(index, resolveMessageRowKey(sessionKey, message, renderableCount));
      renderableCount += 1;
    }
    return {
      messagesRef: messages,
      keyByIndex,
      renderableCount,
    };
  }

  const keyByIndex = new Map<number, string>();
  let renderableCount = 0;
  for (const [index, message] of messages.entries()) {
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    keyByIndex.set(index, resolveMessageRowKey(sessionKey, message, renderableCount));
    renderableCount += 1;
  }
  return {
    messagesRef: messages,
    keyByIndex,
    renderableCount,
  };
}

function findCompletionEventAnchors(messages: RawMessage[]): CompletionEventAnchor[] {
  const anchors: CompletionEventAnchor[] = [];
  for (const [eventIndex, message] of messages.entries()) {
    const completionInfo = parseSubagentCompletionInfo(message);
    if (!completionInfo) continue;

    let triggerIndex = eventIndex;
    for (let index = eventIndex - 1; index >= 0; index -= 1) {
      const previous = messages[index];
      if (previous.role !== 'user') continue;
      if (parseSubagentCompletionInfo(previous)) continue;
      triggerIndex = index;
      break;
    }

    let replyIndex: number | null = null;
    for (let index = eventIndex + 1; index < messages.length; index += 1) {
      if (messages[index]?.role === 'assistant') {
        replyIndex = index;
        break;
      }
    }

    anchors.push({
      eventIndex,
      triggerIndex,
      replyIndex,
      sessionKey: completionInfo.sessionKey,
      ...(completionInfo.sessionId ? { sessionId: completionInfo.sessionId } : {}),
      ...(completionInfo.agentId ? { agentId: completionInfo.agentId } : {}),
    });
  }
  return anchors;
}

export function buildCompletionAnchors(
  messages: RawMessage[],
  previous?: AnchorsSnapshot,
): AnchorsSnapshot {
  if (!previous || !canAppendMessageList(previous.messagesRef, messages)) {
    return {
      messagesRef: messages,
      anchors: findCompletionEventAnchors(messages),
    };
  }

  const anchors = previous.anchors.map((anchor) => ({ ...anchor }));
  const unresolvedIndices: number[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].replyIndex == null) {
      unresolvedIndices.push(index);
    }
  }

  for (let index = previous.messagesRef.length; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === 'assistant') {
      while (unresolvedIndices.length > 0) {
        const unresolvedIndex = unresolvedIndices[0];
        if (anchors[unresolvedIndex].eventIndex < index) {
          anchors[unresolvedIndex].replyIndex = index;
          unresolvedIndices.shift();
          break;
        }
        break;
      }
    }

    const completionInfo = parseSubagentCompletionInfo(message);
    if (!completionInfo) {
      continue;
    }

    let triggerIndex = index;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previousMessage = messages[cursor];
      if (previousMessage.role !== 'user') continue;
      if (parseSubagentCompletionInfo(previousMessage)) continue;
      triggerIndex = cursor;
      break;
    }

    const nextAnchor: CompletionEventAnchor = {
      eventIndex: index,
      triggerIndex,
      replyIndex: null,
      sessionKey: completionInfo.sessionKey,
      ...(completionInfo.sessionId ? { sessionId: completionInfo.sessionId } : {}),
      ...(completionInfo.agentId ? { agentId: completionInfo.agentId } : {}),
    };
    anchors.push(nextAnchor);
    unresolvedIndices.push(anchors.length - 1);
  }

  return {
    messagesRef: messages,
    anchors,
  };
}

import type { RawMessage } from '@/stores/chat';

const HISTORY_PROJECTION_FINGERPRINT_SAMPLE_SIZE = 6;

export interface HistoryProjectionBuildResult {
  historyBaseMessages: RawMessage[];
  committedLiveTailMessages: RawMessage[];
  mergedMessages: RawMessage[];
  historyBaseFingerprint: string;
  liveTailFingerprint: string;
}

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function buildMessageSemanticKey(message: RawMessage): string {
  return JSON.stringify([
    message.role,
    message.timestamp ?? null,
    message.toolCallId ?? null,
    message.toolName ?? null,
    message.isError ?? null,
    message.content,
    message._attachedFiles ?? null,
  ]);
}

function readMessageId(message: RawMessage): string | null {
  return typeof message.id === 'string' && message.id.trim()
    ? message.id
    : null;
}

function buildMessagesFingerprint(messages: RawMessage[]): string {
  if (messages.length === 0) {
    return '0';
  }
  const sample = messages
    .slice(-HISTORY_PROJECTION_FINGERPRINT_SAMPLE_SIZE)
    .map((message) => {
      const messageId = readMessageId(message);
      if (messageId) {
        return `id:${messageId}`;
      }
      return `sig:${hashStringDjb2(buildMessageSemanticKey(message))}`;
    });

  return `${messages.length}|${sample.join('|')}`;
}

function buildHistorySeenIndex(baseMessages: RawMessage[]) {
  return {
    messageIds: new Set(
      baseMessages
        .map(readMessageId)
        .filter((messageId): messageId is string => messageId != null),
    ),
    semanticKeys: new Set(baseMessages.map(buildMessageSemanticKey)),
  };
}

function hasMessageInHistoryBase(
  message: RawMessage,
  seenIndex: ReturnType<typeof buildHistorySeenIndex>,
): boolean {
  const messageId = readMessageId(message);
  if (messageId && seenIndex.messageIds.has(messageId)) {
    return true;
  }
  return seenIndex.semanticKeys.has(buildMessageSemanticKey(message));
}

function filterMissingLiveMessages(
  baseMessages: RawMessage[],
  liveMessages: RawMessage[],
): RawMessage[] {
  const seenIndex = buildHistorySeenIndex(baseMessages);
  const missingMessages: RawMessage[] = [];
  for (const message of liveMessages) {
    if (!hasMessageInHistoryBase(message, seenIndex)) {
      missingMessages.push(message);
    }
  }
  return missingMessages;
}

function extractCommittedLiveTailMessages(
  baseMessages: RawMessage[],
  liveMessages: RawMessage[],
): RawMessage[] {
  if (baseMessages.length === 0) {
    return liveMessages;
  }
  if (liveMessages.length === 0) {
    return [];
  }

  const seenIndex = buildHistorySeenIndex(baseMessages);
  const missingTailReversed: RawMessage[] = [];
  let foundOverlap = false;
  for (let index = liveMessages.length - 1; index >= 0; index -= 1) {
    const message = liveMessages[index];
    if (hasMessageInHistoryBase(message, seenIndex)) {
      foundOverlap = true;
      break;
    }
    missingTailReversed.push(message);
  }

  if (missingTailReversed.length === 0) {
    return [];
  }

  if (!foundOverlap) {
    return filterMissingLiveMessages(baseMessages, liveMessages);
  }

  return missingTailReversed.reverse();
}

export function buildHistoryProjectionMessages(
  historyBaseMessages: RawMessage[],
  liveMessages: RawMessage[],
): HistoryProjectionBuildResult {
  const committedLiveTailMessages = extractCommittedLiveTailMessages(historyBaseMessages, liveMessages);
  return {
    historyBaseMessages,
    committedLiveTailMessages,
    mergedMessages: committedLiveTailMessages.length > 0
      ? [...historyBaseMessages, ...committedLiveTailMessages]
      : historyBaseMessages,
    historyBaseFingerprint: buildMessagesFingerprint(historyBaseMessages),
    liveTailFingerprint: buildMessagesFingerprint(committedLiveTailMessages),
  };
}

import {
  enrichWithCachedImagesIncremental,
  enrichWithToolResultFilesIncremental,
} from './attachment-helpers';
import { throwIfHistoryLoadAborted } from './history-abort';
import {
  isInternalMessage,
  sanitizeIntermediateToolFillerMessage,
} from './message-helpers';
import { isToolResultRole } from './event-helpers';
import type { RawMessage } from './types';

const NORMALIZE_CHUNK_SIZE = 48;

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface NormalizeHistoryMessagesOptions {
  abortSignal?: AbortSignal;
}

export async function normalizeHistoryMessages(
  rawMessages: RawMessage[],
  options: NormalizeHistoryMessagesOptions = {},
): Promise<RawMessage[]> {
  const { abortSignal } = options;
  if (abortSignal) {
    throwIfHistoryLoadAborted(abortSignal);
  }
  if (rawMessages.length === 0) {
    return rawMessages;
  }

  const messagesWithToolImages = await enrichWithToolResultFilesIncremental(
    rawMessages,
    NORMALIZE_CHUNK_SIZE,
    abortSignal,
  );
  const filteredMessages: RawMessage[] = [];
  for (let index = 0; index < messagesWithToolImages.length; index += 1) {
    if (abortSignal) {
      throwIfHistoryLoadAborted(abortSignal);
    }
    const current = messagesWithToolImages[index];
    if (isToolResultRole(current.role) || isInternalMessage(current)) {
      continue;
    }
    const next = index + 1 < messagesWithToolImages.length ? messagesWithToolImages[index + 1] : undefined;
    filteredMessages.push(
      sanitizeIntermediateToolFillerMessage(current, {
        nextMessage: next,
        requireFollower: true,
        trackPhrase: false,
      }),
    );
    if ((index + 1) % NORMALIZE_CHUNK_SIZE === 0) {
      if (abortSignal) {
        throwIfHistoryLoadAborted(abortSignal);
      }
      await yieldToMainThread();
    }
  }
  return await enrichWithCachedImagesIncremental(
    filteredMessages,
    NORMALIZE_CHUNK_SIZE,
    abortSignal,
  );
}



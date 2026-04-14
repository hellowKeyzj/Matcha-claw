import {
  enrichWithCachedImagesIncremental,
  enrichWithToolResultFilesIncremental,
} from './attachment-helpers';
import {
  isInternalMessage,
  sanitizeIntermediateToolFillerMessage,
} from './message-helpers';
import { isToolResultRole } from './runtime-event-helpers';
import type { RawMessage } from './types';

const NORMALIZE_CHUNK_SIZE = 48;

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function normalizeHistoryMessages(rawMessages: RawMessage[]): Promise<RawMessage[]> {
  if (rawMessages.length === 0) {
    return rawMessages;
  }

  const messagesWithToolImages = await enrichWithToolResultFilesIncremental(rawMessages, NORMALIZE_CHUNK_SIZE);
  const filteredMessages: RawMessage[] = [];
  for (let index = 0; index < messagesWithToolImages.length; index += 1) {
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
      await yieldToMainThread();
    }
  }
  return await enrichWithCachedImagesIncremental(filteredMessages, NORMALIZE_CHUNK_SIZE);
}

import { getMessageAttachedFiles } from '@/lib/chat-markdown-body';
import type { AttachedFileMeta, RawMessage } from '@/stores/chat';
import {
  extractImages,
  extractThinking,
  extractToolUse,
} from './message-utils';

export interface ChatMessageImage {
  url?: string;
  data?: string;
  mimeType: string;
}

export interface ChatMessageToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatMessageView {
  thinking: string | null;
  images: ReadonlyArray<ChatMessageImage>;
  toolUses: ReadonlyArray<ChatMessageToolUse>;
  attachedFiles: ReadonlyArray<AttachedFileMeta>;
}

const EMPTY_IMAGES: ReadonlyArray<ChatMessageImage> = [];
const EMPTY_TOOL_USES: ReadonlyArray<ChatMessageToolUse> = [];
const EMPTY_ATTACHED_FILES: ReadonlyArray<AttachedFileMeta> = [];

const chatMessageViewCache = new WeakMap<RawMessage, ChatMessageView>();

function buildChatMessageView(message: RawMessage): ChatMessageView {
  const images = extractImages(message);
  const toolUses = extractToolUse(message);
  const attachedFiles = getMessageAttachedFiles(message);

  return {
    thinking: extractThinking(message),
    images: images.length > 0 ? images : EMPTY_IMAGES,
    toolUses: toolUses.length > 0 ? toolUses : EMPTY_TOOL_USES,
    attachedFiles: attachedFiles.length > 0 ? attachedFiles : EMPTY_ATTACHED_FILES,
  };
}

export function getOrBuildChatMessageView(message: RawMessage): ChatMessageView {
  const cached = chatMessageViewCache.get(message);
  if (cached) {
    return cached;
  }
  const next = buildChatMessageView(message);
  chatMessageViewCache.set(message, next);
  return next;
}

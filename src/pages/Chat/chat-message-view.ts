import { getTimelineEntryAttachedFiles } from '@/lib/chat-markdown-body';
import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';
import {
  extractEntryImages,
  extractEntryThinking,
  extractEntryToolUse,
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

const chatMessageViewCache = new WeakMap<SessionTimelineEntry, ChatMessageView>();

function buildChatMessageView(entry: SessionTimelineEntry): ChatMessageView {
  const images = extractEntryImages(entry);
  const toolUses = extractEntryToolUse(entry);
  const attachedFiles = getTimelineEntryAttachedFiles(entry);

  return {
    thinking: extractEntryThinking(entry),
    images: images.length > 0 ? images : EMPTY_IMAGES,
    toolUses: toolUses.length > 0 ? toolUses : EMPTY_TOOL_USES,
    attachedFiles: attachedFiles.length > 0 ? attachedFiles : EMPTY_ATTACHED_FILES,
  };
}

export function getOrBuildChatMessageView(entry: SessionTimelineEntry): ChatMessageView {
  const cached = chatMessageViewCache.get(entry);
  if (cached) {
    return cached;
  }
  const next = buildChatMessageView(entry);
  chatMessageViewCache.set(entry, next);
  return next;
}

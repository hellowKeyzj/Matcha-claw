import type { AttachedFileMeta } from '@/stores/chat';
import type { SessionMessageRow } from '../../../runtime-host/shared/session-adapter-types';

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

export function getOrBuildChatMessageView(row: SessionMessageRow): ChatMessageView {
  return {
    thinking: row.thinking,
    images: row.images,
    toolUses: row.toolUses,
    attachedFiles: row.attachedFiles as unknown as AttachedFileMeta[],
  };
}

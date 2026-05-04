import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionAssistantTurnItem,
  SessionRenderImage,
  SessionRenderToolUse,
  SessionRenderUserMessageItem,
} from '../../../runtime-host/shared/session-adapter-types';

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

type ChatRenderableMessageItem = SessionRenderUserMessageItem | SessionAssistantTurnItem;

function normalizeImages(images: ReadonlyArray<SessionRenderImage>): ReadonlyArray<ChatMessageImage> {
  return images;
}

function normalizeToolUses(toolUses: ReadonlyArray<SessionRenderToolUse>): ReadonlyArray<ChatMessageToolUse> {
  return toolUses.map((toolUse) => ({
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  }));
}

export function getOrBuildChatMessageView(item: ChatRenderableMessageItem): ChatMessageView {
  return {
    thinking: item.kind === 'assistant-turn' ? item.thinking : null,
    images: normalizeImages(item.images),
    toolUses: item.kind === 'assistant-turn' ? normalizeToolUses(item.toolCalls) : [],
    attachedFiles: item.attachedFiles as unknown as AttachedFileMeta[],
  };
}

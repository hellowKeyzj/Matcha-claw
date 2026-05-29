import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionAssistantTurnItem,
  SessionRenderImage,
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

function normalizeToolUses(toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>): ReadonlyArray<ChatMessageToolUse> {
  return toolUses.map((toolUse) => ({
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
  }));
}

export function getAssistantTurnPlainText(item: SessionAssistantTurnItem): string {
  return item.text.trim();
}

export function getOrBuildChatMessageView(item: ChatRenderableMessageItem): ChatMessageView {
  if (item.kind === 'assistant-turn') {
    return {
      thinking: item.thinking,
      images: normalizeImages(item.images),
      toolUses: normalizeToolUses(item.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        input: tool.input,
      }))),
      attachedFiles: item.attachedFiles as unknown as AttachedFileMeta[],
    };
  }

  return {
    thinking: null,
    images: normalizeImages(item.images),
    toolUses: [],
    attachedFiles: item.attachedFiles as unknown as AttachedFileMeta[],
  };
}

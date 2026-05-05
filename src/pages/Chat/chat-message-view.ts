import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionAssistantMediaSegment,
  SessionAssistantMessageSegment,
  SessionAssistantThinkingSegment,
  SessionAssistantToolSegment,
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

function readAssistantThinking(item: SessionAssistantTurnItem): string | null {
  const text = item.segments
    .filter((segment): segment is SessionAssistantThinkingSegment => segment.kind === 'thinking')
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function readAssistantImages(item: SessionAssistantTurnItem): ReadonlyArray<ChatMessageImage> {
  return normalizeImages(item.segments
    .filter((segment): segment is SessionAssistantMediaSegment => segment.kind === 'media')
    .flatMap((segment) => segment.images));
}

function readAssistantAttachedFiles(item: SessionAssistantTurnItem): ReadonlyArray<AttachedFileMeta> {
  return item.segments
    .filter((segment): segment is SessionAssistantMediaSegment => segment.kind === 'media')
    .flatMap((segment) => segment.attachedFiles) as unknown as AttachedFileMeta[];
}

export function getAssistantTurnPlainText(item: SessionAssistantTurnItem): string {
  return item.segments
    .filter((segment): segment is SessionAssistantMessageSegment => segment.kind === 'message')
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function getOrBuildChatMessageView(item: ChatRenderableMessageItem): ChatMessageView {
  if (item.kind === 'assistant-turn') {
    return {
      thinking: readAssistantThinking(item),
      images: readAssistantImages(item),
      toolUses: normalizeToolUses(item.segments
        .filter((segment): segment is SessionAssistantToolSegment => segment.kind === 'tool')
        .map((segment) => ({
          id: segment.tool.id,
          name: segment.tool.name,
          input: segment.tool.input,
        }))),
      attachedFiles: readAssistantAttachedFiles(item),
    };
  }

  return {
    thinking: null,
    images: normalizeImages(item.images),
    toolUses: [],
    attachedFiles: item.attachedFiles as unknown as AttachedFileMeta[],
  };
}

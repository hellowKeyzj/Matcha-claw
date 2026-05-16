import {
  extractMessageText,
  sanitizeAssistantDisplayText,
  sanitizeCanonicalUserText,
} from '../../shared/chat-message-normalization';
import type { SessionRenderImage } from '../../shared/session-adapter-types';
import type {
  ContentBlockLike,
  SessionTranscriptMessage,
} from './transcript-types';

export function readMessageContent(message: SessionTranscriptMessage): unknown {
  return message.content;
}

export function resolveTranscriptDisplayText(message: SessionTranscriptMessage): string {
  if (message.role === 'user') {
    return sanitizeCanonicalUserText(extractMessageText(message.content));
  }
  if (message.role === 'assistant') {
    return sanitizeAssistantDisplayText(message.content);
  }
  return extractMessageText(message.content).trim();
}

export function extractThinking(message: SessionTranscriptMessage): string | null {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'thinking' || typeof block.thinking !== 'string') {
      continue;
    }
    const cleaned = block.thinking.trim();
    if (cleaned) {
      parts.push(cleaned);
    }
  }
  const combined = parts.join('\n\n').trim();
  return combined || null;
}

export function extractImages(message: SessionTranscriptMessage): SessionRenderImage[] {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return [];
  }
  const images: SessionRenderImage[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'image') {
      continue;
    }
    if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
      images.push({
        mimeType: block.source.media_type,
        data: block.source.data,
      });
      continue;
    }
    if (block.source?.type === 'url' && typeof block.source.url === 'string') {
      images.push({
        mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
        url: block.source.url,
      });
      continue;
    }
    if (typeof block.data === 'string') {
      images.push({
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
        data: block.data,
      });
    }
  }
  return images;
}

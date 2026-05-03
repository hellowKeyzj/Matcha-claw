import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';
import { sanitizeCanonicalUserText } from '@/stores/chat/message-helpers';

interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
}

function stripAssistantReplyDirectivePrefix(text: string): string {
  return text
    .replace(/^\s*(?:\[\[reply_to(?:[:_][a-z0-9:_-]+)?\]\]\s*)+/ig, '')
    .trim();
}

function readEntryMessage(entry: SessionTimelineEntry): Record<string, unknown> {
  return entry.message as unknown as Record<string, unknown>;
}

function readTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : '';
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      parts.push(block.text);
    }
  }
  const combined = parts.join('\n\n');
  return combined.trim().length > 0 ? combined : '';
}

export function extractEntryText(entry: SessionTimelineEntry): string {
  const msg = readEntryMessage(entry);
  const role = entry.role;
  const fromEntry = typeof entry.text === 'string' && entry.text.trim().length > 0 ? entry.text : '';
  const fromContent = fromEntry || readTextFromContent(msg.content);
  const fromTextField = typeof msg.text === 'string' && msg.text.trim().length > 0 ? msg.text : '';
  let result = fromContent || fromTextField;

  if (role === 'user' && result) {
    result = sanitizeCanonicalUserText(result);
  }
  if (role === 'assistant' && result) {
    result = stripAssistantReplyDirectivePrefix(result);
  }

  return result;
}

export function extractEntryThinking(entry: SessionTimelineEntry): string | null {
  const content = readEntryMessage(entry).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const cleaned = block.thinking.trim();
      if (cleaned) {
        parts.push(cleaned);
      }
    }
  }

  const combined = parts.join('\n\n').trim();
  return combined.length > 0 ? combined : null;
}

export function extractEntryMediaRefs(entry: SessionTimelineEntry): Array<{ filePath: string; mimeType: string }> {
  if (entry.role !== 'user') {
    return [];
  }
  const content = readEntryMessage(entry).content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as ContentBlockLike[])
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text!)
          .join('\n')
      : '';

  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

export function extractEntryImages(entry: SessionTimelineEntry): Array<{ mimeType: string; data: string }> {
  const content = readEntryMessage(entry).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const images: Array<{ mimeType: string; data: string }> = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'image') {
      continue;
    }
    if (block.source?.type === 'base64' && block.source.media_type && block.source.data) {
      images.push({ mimeType: block.source.media_type, data: block.source.data });
      continue;
    }
    if (block.data) {
      images.push({ mimeType: block.mimeType || 'image/jpeg', data: block.data });
    }
  }

  return images;
}

export function extractEntryToolUse(entry: SessionTimelineEntry): Array<{ id: string; name: string; input: unknown }> {
  const msg = readEntryMessage(entry);
  const tools: Array<{ id: string; name: string; input: unknown }> = [];
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlockLike[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.name) {
        tools.push({
          id: block.id || '',
          name: block.name,
          input: block.input ?? block.arguments,
        });
      }
    }
  }

  if (tools.length === 0) {
    const toolCalls = msg.tool_calls ?? msg.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? tc) as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) {
          continue;
        }
        let input: unknown;
        try {
          input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments ?? fn.input;
        } catch {
          input = fn.arguments;
        }
        tools.push({
          id: typeof tc.id === 'string' ? tc.id : '',
          name,
          input,
        });
      }
    }
  }

  return tools;
}

export function formatTimestamp(timestamp: unknown): string {
  if (!timestamp) return '';
  const ts = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!ts || isNaN(ts)) return '';

  const ms = ts > 1e12 ? ts : ts * 1000;
  const date = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

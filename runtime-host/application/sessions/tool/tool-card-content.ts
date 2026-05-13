import { isRecord } from './tool-card-utils';

export interface ToolCardContentBlockLike {
  type?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  callId?: unknown;
  call_id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  content?: unknown;
  text?: unknown;
  isError?: unknown;
  is_error?: unknown;
}

interface ToolResultTextBlockLike {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

export function normalizeContentBlocks(content: unknown): ToolCardContentBlockLike[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((item): item is ToolCardContentBlockLike => Boolean(item) && typeof item === 'object');
}

export function coerceToolArgs(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function extractToolResultOutput(block: ToolCardContentBlockLike): unknown {
  if (Object.prototype.hasOwnProperty.call(block, 'result')) {
    return block.result;
  }
  if (Object.prototype.hasOwnProperty.call(block, 'partialResult')) {
    return block.partialResult;
  }
  if (Object.prototype.hasOwnProperty.call(block, 'content')) {
    return block.content;
  }
  return block.text;
}

export function extractToolResultOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is ToolResultTextBlockLike => isRecord(item))
      .flatMap((item) => {
        if (typeof item.text === 'string') {
          return [item.text];
        }
        if (typeof item.content === 'string') {
          return [item.content];
        }
        return [];
      })
      .map((text) => text.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.text === 'string') {
    return value.text;
  }
  if (typeof value.content === 'string') {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return extractToolResultOutputText(value.content);
  }
  return undefined;
}

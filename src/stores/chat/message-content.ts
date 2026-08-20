export type NormalizedChatMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'toolresult'
  | 'tool_result';

export type ContentTextBlock = {
  type?: unknown;
  text?: unknown;
};

export type ChatMessageRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is ChatMessageRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeMessageRole(value: unknown): NormalizedChatMessageRole | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (
    normalized === 'user'
    || normalized === 'assistant'
    || normalized === 'system'
    || normalized === 'toolresult'
    || normalized === 'toolresult'
    || normalized === 'tool_result'
  ) {
    if (normalized === 'toolresult') {
      return 'toolresult';
    }
    return normalized;
  }
  return undefined;
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is ContentTextBlock => isRecord(block))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n');
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseToolResultJson(text: string | null | undefined): unknown {
  const trimmed = text?.trim() ?? '';
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isToolResultContentBlockType(type: unknown): boolean {
  return type === 'toolResult'
    || type === 'toolresult'
    || type === 'tool_result'
    || type === 'tool_use_result';
}

function collectToolResultTextChunks(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectToolResultTextChunks);
  }
  if (!isRecord(value)) {
    return [];
  }

  if (value.type === 'text') {
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    return text ? [text] : [];
  }

  if (isToolResultContentBlockType(value.type)) {
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    return [
      ...(text ? [text] : []),
      ...collectToolResultTextChunks(value.content),
    ];
  }

  if (Array.isArray(value.content)) {
    return collectToolResultTextChunks(value.content);
  }

  return [];
}

export function extractToolResultContentBlockText(value: unknown): string | null {
  const text = collectToolResultTextChunks(value).join('\n').trim();
  return text || null;
}

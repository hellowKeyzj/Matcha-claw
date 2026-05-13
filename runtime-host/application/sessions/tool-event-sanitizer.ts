function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isMalformedEmptyToolNameResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const name = normalizeString(value.toolName ?? value.name);
  const toolCallId = normalizeString(
    value.toolCallId
      ?? value.tool_call_id
      ?? value.callId
      ?? value.call_id
      ?? value.id,
  );
  const content = value.content;
  if (name && name !== 'unknown') {
    return false;
  }
  if (!toolCallId.startsWith('call_auto_')) {
    return false;
  }
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((item) => isRecord(item) ? normalizeString(item.text) : '')
          .filter(Boolean)
          .join('\n')
      : '';
  return /tool\s+not found/i.test(text);
}

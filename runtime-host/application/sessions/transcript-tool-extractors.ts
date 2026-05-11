import {
  extractMessageText,
  normalizeOptionalString,
} from '../../shared/chat-message-normalization';
import type { SessionRenderToolUse, SessionTimelineMessageEntry } from '../../shared/session-adapter-types';
import type {
  ContentBlockLike,
  SessionTranscriptMessage,
} from './transcript-types';
import {
  readMessageContent,
} from './transcript-content-extractors';

export function extractToolUses(message: SessionTranscriptMessage): SessionTimelineMessageEntry['toolUses'] {
  const content = readMessageContent(message);
  const tools: SessionRenderToolUse[] = [];
  if (Array.isArray(content)) {
    for (const block of content as ContentBlockLike[]) {
      const type = typeof block.type === 'string' ? block.type : '';
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name || (type !== 'tool_use' && type !== 'toolCall')) {
        continue;
      }
      const toolCallId = typeof block.id === 'string' && block.id.trim() ? block.id.trim() : undefined;
      tools.push({
        id: toolCallId || name,
        ...(toolCallId ? { toolCallId } : {}),
        name,
        input: block.input ?? block.arguments,
      });
    }
  }
  if (tools.length > 0) {
    return tools;
  }
  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const toolCallId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : '';
    const fn = (row.function ?? row) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) {
      return [];
    }
    let input: unknown = fn.input ?? fn.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        // keep raw string
      }
    }
    return [{
      id: toolCallId || name,
      ...(toolCallId ? { toolCallId } : {}),
      name,
      input,
    }];
  });
}

function normalizeToolOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const extracted = extractMessageText(value).trim();
    if (extracted) {
      return extracted;
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function mergeToolStatusRecords(
  existingStatuses: SessionTimelineMessageEntry['toolStatuses'],
  incomingStatuses: SessionTimelineMessageEntry['toolStatuses'],
): SessionTimelineMessageEntry['toolStatuses'] {
  const merged = existingStatuses.map((status) => ({ ...status }));
  for (const incoming of incomingStatuses) {
    const key = incoming.toolCallId || incoming.id || incoming.name;
    if (!key) {
      merged.push({ ...incoming });
      continue;
    }
    const existingIndex = merged.findIndex((status) => (
      status.toolCallId === key
      || status.id === key
      || (
        !status.toolCallId
        && !status.id
        && status.name === incoming.name
      )
    ));
    if (existingIndex < 0) {
      merged.push({ ...incoming });
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      ...incoming,
      name: (
        (incoming.name === incoming.toolCallId || incoming.name === incoming.id)
        && existing.name
      ) ? existing.name : incoming.name,
    };
  }
  return merged;
}

function resolveFallbackToolName(input: {
  message: SessionTranscriptMessage;
  toolCallId?: string;
  id?: string;
}): string {
  const explicitName = normalizeOptionalString(input.message.toolName ?? input.message.name);
  if (explicitName) {
    return explicitName;
  }
  const toolCallId = normalizeOptionalString(input.toolCallId) ?? '';
  if (!toolCallId) {
    return normalizeOptionalString(input.id) ?? '';
  }
  const contentToolName = extractToolUses(input.message).find((toolUse) => (
    toolUse.toolCallId === toolCallId || toolUse.id === toolCallId
  ))?.name;
  if (contentToolName) {
    return contentToolName;
  }
  return normalizeOptionalString(input.id) ?? '';
}

function readToolStatusesFromStatusRecords(
  message: SessionTranscriptMessage,
  records: ReadonlyArray<Record<string, unknown>>,
): SessionTimelineMessageEntry['toolStatuses'] {
  return records.flatMap((item) => {
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
    const toolCallId = typeof item.toolCallId === 'string' && item.toolCallId.trim() ? item.toolCallId.trim() : undefined;
    const fallbackName = resolveFallbackToolName({
      message,
      toolCallId,
      id,
    });
    const name = typeof item.name === 'string' && item.name.trim()
      ? item.name.trim()
      : fallbackName;
    const status = item.status === 'running' || item.status === 'completed' || item.status === 'error'
      ? item.status
      : null;
    if (!name || !status) {
      return [];
    }
    const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : undefined;
    const durationMs = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? item.durationMs : undefined;
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : undefined;
    const output = Object.prototype.hasOwnProperty.call(item, 'result')
      ? item.result
      : (Object.prototype.hasOwnProperty.call(item, 'partialResult') ? item.partialResult : undefined);
    const outputText = normalizeToolOutputText(output);
    return [{
      ...(id ? { id } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      name,
      status,
      ...(summary ? { summary } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      ...(updatedAt != null ? { updatedAt } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(outputText ? { outputText } : {}),
    }];
  });
}

function readToolStatusesFromContent(message: SessionTranscriptMessage): SessionTimelineMessageEntry['toolStatuses'] {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') {
      return [];
    }
    const row = block as Record<string, unknown>;
    const type = typeof row.type === 'string' ? row.type : '';
    if (type !== 'tool_result' && type !== 'toolResult') {
      return [];
    }
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
    const toolCallId = typeof row.toolCallId === 'string' && row.toolCallId.trim()
      ? row.toolCallId.trim()
      : id;
    const fallbackName = resolveFallbackToolName({
      message,
      toolCallId,
      id,
    });
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : fallbackName;
    if (!name) {
      return [];
    }
    const output = Object.prototype.hasOwnProperty.call(row, 'result')
      ? row.result
      : (
          Object.prototype.hasOwnProperty.call(row, 'partialResult')
            ? row.partialResult
            : (Object.prototype.hasOwnProperty.call(row, 'content') ? row.content : row.text)
        );
    const outputText = normalizeToolOutputText(output);
    const isError = row.isError === true || row.is_error === true;
    return [{
      ...(id ? { id } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      name,
      status: isError ? 'error' : 'completed',
      ...(output !== undefined ? { output } : {}),
      ...(outputText ? { outputText } : {}),
    }];
  });
}

export function readToolStatuses(message: SessionTranscriptMessage): SessionTimelineMessageEntry['toolStatuses'] {
  const records = Array.isArray(message.toolStatuses)
    ? message.toolStatuses.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
  const mergedStatuses = mergeToolStatusRecords(
    readToolStatusesFromStatusRecords(message, records),
    readToolStatusesFromContent(message),
  );
  if (mergedStatuses.length > 0) {
    return mergedStatuses;
  }
  if (message.role !== 'toolresult' && message.role !== 'tool_result') {
    return mergedStatuses;
  }
  const toolCallId = normalizeOptionalString(message.toolCallId);
  const name = resolveFallbackToolName({
    message,
    toolCallId,
  });
  if (!name) {
    return mergedStatuses;
  }
  const output = message.details !== undefined
    ? message.details
    : message.content;
  const outputText = normalizeToolOutputText(output);
  return [{
    ...(toolCallId ? { id: toolCallId, toolCallId } : {}),
    name,
    status: message.isError ? 'error' : 'completed',
    ...(output !== undefined ? { output } : {}),
    ...(outputText ? { outputText } : {}),
  }];
}

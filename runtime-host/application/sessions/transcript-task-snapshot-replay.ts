import type { TaskSnapshotEvent } from '../../shared/session-adapter-types';
import { isRecord, normalizeString } from './session-value-normalization';
import {
  isStateOnlyToolCallSnapshotName,
  isStateOnlyToolName,
  isToolCallContentType,
  isToolResultContentType,
  resolveToolRecordCallPayload,
  resolveToolRecordName,
  resolveToolRecordResultPayload,
} from './state-only-tools';
import { normalizeTaskToolSnapshot } from './task-snapshot-normalizer';
import { readMessageContent } from './transcript-content-extractors';
import type { SessionTranscriptMessage } from './transcript-types';

function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function readToolCallPayload(block: Record<string, unknown>): unknown {
  const base = parseStructuredValue(resolveToolRecordCallPayload(block));
  if (!isRecord(base)) {
    return base;
  }
  return {
    ...base,
    source: 'todo',
  };
}

function readToolResultPayload(block: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(block, 'input')) {
    const input = parseStructuredValue(block.input);
    return isRecord(input) ? { ...input, source: 'todo' } : input;
  }
  const base = parseStructuredValue(resolveToolRecordResultPayload(block));
  if (!isRecord(base)) {
    return base;
  }
  return {
    ...base,
    source: 'todo',
  };
}

function isStateOnlyToolResultSnapshotName(toolName: unknown): boolean {
  return isStateOnlyToolName(toolName);
}

function extractSnapshotFromContentBlock(
  sessionKey: string,
  block: unknown,
): TaskSnapshotEvent | null {
  if (!isRecord(block)) {
    return null;
  }
  const type = normalizeString(block.type);
  const name = resolveToolRecordName(block);
  if (isToolCallContentType(type)) {
    if (!isStateOnlyToolCallSnapshotName(name)) {
      return null;
    }
    return normalizeTaskToolSnapshot(name, readToolCallPayload(block), sessionKey);
  }
  if (isToolResultContentType(type)) {
    if (!isStateOnlyToolResultSnapshotName(name)) {
      return null;
    }
    return normalizeTaskToolSnapshot(name, readToolResultPayload(block), sessionKey);
  }
  return null;
}

function extractSnapshotFromToolCall(
  sessionKey: string,
  toolCall: unknown,
): TaskSnapshotEvent | null {
  if (!isRecord(toolCall)) {
    return null;
  }
  const name = resolveToolRecordName(toolCall);
  if (!isStateOnlyToolName(name)) {
    return null;
  }
  return normalizeTaskToolSnapshot(name, readToolCallPayload(toolCall), sessionKey);
}

export function extractTaskSnapshotFromTranscriptMessage(
  sessionKey: string,
  message: SessionTranscriptMessage,
): TaskSnapshotEvent | null {
  let latest: TaskSnapshotEvent | null = null;

  if (isStateOnlyToolName(message.toolName ?? message.name) && (message.role === 'toolresult' || message.role === 'tool_result')) {
    latest = normalizeTaskToolSnapshot(
      message.toolName ?? message.name,
      message.details ?? message.content,
      sessionKey,
    ) ?? latest;
  } else if (isStateOnlyToolName(message.toolName ?? message.name)) {
    latest = normalizeTaskToolSnapshot(
      message.toolName ?? message.name,
      message.details ?? message.content,
      sessionKey,
    ) ?? latest;
  }

  const content = readMessageContent(message);
  if (Array.isArray(content)) {
    for (const block of content) {
      latest = extractSnapshotFromContentBlock(sessionKey, block) ?? latest;
    }
  }

  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const toolCall of toolCalls) {
      latest = extractSnapshotFromToolCall(sessionKey, toolCall) ?? latest;
    }
  }

  return latest;
}

export function extractLatestTaskSnapshotFromTranscriptMessages(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
): TaskSnapshotEvent | null {
  let latest: TaskSnapshotEvent | null = null;
  for (const message of messages) {
    latest = extractTaskSnapshotFromTranscriptMessage(sessionKey, message) ?? latest;
  }
  return latest;
}

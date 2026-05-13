import {
  canonicalizeStateOnlyTaskToolName,
  isStateOnlyTaskToolCallSnapshotName,
  isStateOnlyTaskToolName,
  normalizeToolName,
  type StateOnlyTaskToolName,
} from '../../shared/task-tool-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type StateOnlyToolName = StateOnlyTaskToolName;

export function canonicalizeStateOnlyToolName(toolName: unknown): StateOnlyToolName | '' {
  return canonicalizeStateOnlyTaskToolName(toolName);
}

export function canonicalizeToolName(toolName: unknown): string {
  const normalized = normalizeToolName(toolName);
  return canonicalizeStateOnlyToolName(normalized) || normalized;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveToolRecordCallId(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }
  return normalizeString(
    value.id
      ?? value.toolCallId
      ?? value.tool_call_id
      ?? value.callId
      ?? value.call_id,
  );
}

export function isToolCallContentType(value: unknown): boolean {
  const type = normalizeString(value);
  return type === 'toolCall'
    || type === 'tool_call'
    || type === 'toolUse'
    || type === 'tool_use'
    || type === 'function_call'
    || type === 'functionCall';
}

export function isToolResultContentType(value: unknown): boolean {
  const type = normalizeString(value);
  return type === 'toolResult'
    || type === 'tool_result'
    || type === 'function_call_output'
    || type === 'functionCallOutput';
}

export function resolveToolRecordName(value: unknown): string {
  if (!isRecord(value)) {
    return canonicalizeToolName(value);
  }
  const direct = canonicalizeToolName(
    value.name
      ?? value.toolName
      ?? value.tool_name,
  );
  if (direct) {
    return direct;
  }
  return isRecord(value.function)
    ? resolveToolRecordName(value.function)
    : '';
}

export function resolveToolRecordCallPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = isRecord(value.function) ? value.function : value;
  if (Object.prototype.hasOwnProperty.call(source, 'input')) {
    return source.input;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'arguments')) {
    return source.arguments;
  }
  return source.args;
}

export function resolveToolRecordResultPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = isRecord(value.function) ? value.function : value;
  if (Object.prototype.hasOwnProperty.call(source, 'result')) {
    return source.result;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'partialResult')) {
    return source.partialResult;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'content')) {
    return source.content;
  }
  return source.text;
}

export function isStateOnlyToolName(toolName: unknown): boolean {
  return isStateOnlyTaskToolName(toolName);
}

export function isStateOnlyToolCallSnapshotName(toolName: unknown): boolean {
  return isStateOnlyTaskToolCallSnapshotName(toolName);
}

export function isStateOnlyToolCard(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return isStateOnlyToolName(value.name);
}

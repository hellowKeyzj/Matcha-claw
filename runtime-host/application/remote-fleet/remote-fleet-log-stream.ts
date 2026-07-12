export type RemoteFleetLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type RemoteFleetLogStreamName = 'stdout' | 'stderr' | 'system';

export interface RemoteFleetLogDimensions {
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
}

export interface RemoteFleetLogCursor {
  readonly value: string;
}

export interface RemoteFleetLogEvent extends RemoteFleetLogDimensions {
  readonly cursor: RemoteFleetLogCursor;
  readonly occurredAt: string;
  readonly stream: RemoteFleetLogStreamName;
  readonly level?: RemoteFleetLogLevel;
  readonly line: string;
}

export interface RemoteFleetLogEventInput extends RemoteFleetLogDimensions {
  readonly cursor: RemoteFleetLogCursor | string | number | bigint;
  readonly occurredAt: string | number | Date;
  readonly stream: RemoteFleetLogStreamName;
  readonly level?: RemoteFleetLogLevel;
  readonly line: string;
}

export interface RemoteFleetLogStreamRequest extends RemoteFleetLogDimensions {
  readonly after?: RemoteFleetLogCursor;
}

export interface RemoteFleetLogStreamPort {
  streamLogs(request: RemoteFleetLogStreamRequest): AsyncIterable<RemoteFleetLogEvent>;
}

const REDACTED_VALUE = '[REDACTED]';
const SECRET_KEY_FRAGMENT = String.raw`[\w.-]*(?:authorization|api[-_]?key|secret|token|password)[\w.-]*`;
const TERMINAL_OUTPUT_KEY_FRAGMENT = String.raw`(?:stdout|stderr|output)`;
const SENSITIVE_ASSIGNMENT_KEY_FRAGMENT =
  String.raw`(?:${SECRET_KEY_FRAGMENT}|${TERMINAL_OUTPUT_KEY_FRAGMENT})`;
const AUTHORIZATION_SCHEME_PATTERN = /\b(authorization\s*[:=]\s*)(["']?)(?:bearer|basic|token)\s+[^"',;&\s]+\2?/gi;
const SECRET_QUOTED_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_KEY_FRAGMENT})(\s*[:=]\s*)(["'])(.*?)\3`,
  'gi',
);
const SECRET_UNQUOTED_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${SECRET_KEY_FRAGMENT})(\s*[:=]\s*)(?!["'])[^\s,;&]+`,
  'gi',
);
const TERMINAL_OUTPUT_QUOTED_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${TERMINAL_OUTPUT_KEY_FRAGMENT})(\s*[:=]\s*)(["'])(.*?)\3`,
  'gi',
);
const TERMINAL_OUTPUT_UNQUOTED_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b(${TERMINAL_OUTPUT_KEY_FRAGMENT})(\s*[:=]\s*)(?!\s*["'])(.*?)(?=(?:\s*[;,;&]?\s*)\b${SENSITIVE_ASSIGNMENT_KEY_FRAGMENT}\s*[:=]|$)`,
  'gi',
);
const SECRET_FLAG_PATTERN = /(--[\w.-]*(?:authorization|api[-_]?key|secret|token|password)[\w.-]*(?:\s+|=))(["']?)[^\s"']+\2/gi;
const BEARER_TOKEN_PATTERN = /\b(bearer|basic)\s+[^"',;&\s]+/gi;
const COMMON_SECRET_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}|mrf_[A-Za-z0-9][A-Za-z0-9_-]{8,})\b/g;

export function normalizeRemoteFleetLogEvent(input: RemoteFleetLogEventInput): RemoteFleetLogEvent {
  return {
    ...normalizeRemoteFleetLogDimensions(input),
    cursor: normalizeRemoteFleetLogCursor(input.cursor),
    occurredAt: normalizeRemoteFleetLogTimestamp(input.occurredAt),
    stream: input.stream,
    level: input.level,
    line: redactRemoteFleetLogLine(input.line),
  };
}

export function redactRemoteFleetLogLine(line: string): string {
  try {
    return line
      .replace(AUTHORIZATION_SCHEME_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED_VALUE}${quote}`)
      .replace(SECRET_QUOTED_ASSIGNMENT_PATTERN, (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}${REDACTED_VALUE}${quote}`)
      .replace(SECRET_UNQUOTED_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`)
      .replace(TERMINAL_OUTPUT_QUOTED_ASSIGNMENT_PATTERN, (_match, key: string, separator: string, quote: string) => `${key}${separator}${quote}${REDACTED_VALUE}${quote}`)
      .replace(TERMINAL_OUTPUT_UNQUOTED_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`)
      .replace(SECRET_FLAG_PATTERN, (_match, flag: string, quote: string) => `${flag}${quote}${REDACTED_VALUE}${quote}`)
      .replace(BEARER_TOKEN_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
      .replace(COMMON_SECRET_TOKEN_PATTERN, REDACTED_VALUE);
  } catch {
    return REDACTED_VALUE;
  }
}

function normalizeRemoteFleetLogCursor(cursor: RemoteFleetLogCursor | string | number | bigint): RemoteFleetLogCursor {
  const value = typeof cursor === 'object'
    ? cursor.value.trim()
    : String(cursor).trim();

  if (value.length === 0) {
    throw new TypeError('Remote fleet log cursor must not be empty.');
  }

  return { value };
}

function normalizeRemoteFleetLogTimestamp(occurredAt: string | number | Date): string {
  const date = occurredAt instanceof Date
    ? occurredAt
    : new Date(occurredAt);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Remote fleet log timestamp must be a valid date.');
  }

  return date.toISOString();
}

function normalizeRemoteFleetLogDimensions(dimensions: RemoteFleetLogDimensions): RemoteFleetLogDimensions {
  return {
    nodeId: normalizeOptionalDimensionId(dimensions.nodeId),
    agentId: normalizeOptionalDimensionId(dimensions.agentId),
    runtimeId: normalizeOptionalDimensionId(dimensions.runtimeId),
    endpointId: normalizeOptionalDimensionId(dimensions.endpointId),
  };
}

function normalizeOptionalDimensionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

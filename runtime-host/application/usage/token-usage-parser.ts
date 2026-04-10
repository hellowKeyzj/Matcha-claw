export interface TokenUsageHistoryEntry {
  timestamp: string;
  sessionId: string;
  agentId: string;
  model?: string;
  provider?: string;
  usageStatus: 'available' | 'missing' | 'error';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

interface TranscriptUsageShape {
  [key: string]: unknown;
  input?: number;
  output?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  inputTokenCount?: number;
  input_token_count?: number;
  outputTokenCount?: number;
  output_token_count?: number;
  promptTokenCount?: number;
  prompt_token_count?: number;
  completionTokenCount?: number;
  completion_token_count?: number;
  totalTokenCount?: number;
  total_token_count?: number;
  cacheReadTokenCount?: number;
  cache_read_token_count?: number;
  cacheWriteTokenCount?: number;
  cache_write_token_count?: number;
  cost?: {
    total?: number | string;
  };
}

type UsageRecordStatus = 'available' | 'missing' | 'error';

interface ParsedUsageTokens {
  usageStatus: UsageRecordStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
}

interface TranscriptMessageShape {
  role?: string;
  model?: string;
  modelRef?: string;
  provider?: string;
  usage?: unknown;
  content?: unknown;
  details?: {
    usage?: unknown;
    provider?: string;
    model?: string;
    content?: unknown;
    externalContent?: {
      provider?: string;
    };
  } | null;
}

interface TranscriptLineShape {
  type?: string;
  timestamp?: string;
  message?: TranscriptMessageShape;
}

function normalizeUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstUsageNumber(usage: TranscriptUsageShape | undefined, candidates: string[]): number | undefined {
  if (!usage) {
    return undefined;
  }
  for (const key of candidates) {
    const parsed = normalizeUsageNumber(usage[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parseUsageFromShape(usage: unknown): ParsedUsageTokens | undefined {
  if (usage === undefined) {
    return undefined;
  }

  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return {
      usageStatus: 'error',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
  }

  const usageShape = usage as TranscriptUsageShape;
  const inputTokens = firstUsageNumber(usageShape, [
    'input',
    'promptTokens',
    'prompt_tokens',
    'input_tokens',
    'inputTokenCount',
    'input_token_count',
    'promptTokenCount',
    'prompt_token_count',
  ]);
  const outputTokens = firstUsageNumber(usageShape, [
    'output',
    'completionTokens',
    'completion_tokens',
    'output_tokens',
    'outputTokenCount',
    'output_token_count',
    'completionTokenCount',
    'completion_token_count',
  ]);
  const cacheReadTokens = firstUsageNumber(usageShape, [
    'cacheRead',
    'cache_read',
    'cacheReadTokens',
    'cache_read_tokens',
    'cacheReadTokenCount',
    'cache_read_token_count',
  ]);
  const cacheWriteTokens = firstUsageNumber(usageShape, [
    'cacheWrite',
    'cache_write',
    'cacheWriteTokens',
    'cache_write_tokens',
    'cacheWriteTokenCount',
    'cache_write_token_count',
  ]);
  const explicitTotalTokens = firstUsageNumber(usageShape, [
    'total',
    'totalTokens',
    'total_tokens',
    'totalTokenCount',
    'total_token_count',
  ]);
  const costUsd = normalizeUsageNumber(usageShape.cost?.total);

  const hasUsageValue =
    inputTokens !== undefined
    || outputTokens !== undefined
    || cacheReadTokens !== undefined
    || cacheWriteTokens !== undefined
    || explicitTotalTokens !== undefined
    || costUsd !== undefined;

  if (!hasUsageValue) {
    return {
      usageStatus: 'missing',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
  }

  const computedTotalTokens = explicitTotalTokens ?? (
    (inputTokens ?? 0)
    + (outputTokens ?? 0)
    + (cacheReadTokens ?? 0)
    + (cacheWriteTokens ?? 0)
  );

  return {
    usageStatus: 'available',
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens: computedTotalTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export function parseUsageEntriesFromJsonl(
  content: string,
  context: { sessionId: string; agentId: string },
  limit?: number,
): TokenUsageHistoryEntry[] {
  const entries: TokenUsageHistoryEntry[] = [];
  const lines = content.split(/\r?\n/).filter(Boolean);
  const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;

  for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    let parsed: TranscriptLineShape;
    try {
      parsed = JSON.parse(lines[i]) as TranscriptLineShape;
    } catch {
      continue;
    }

    const message = parsed.message;
    if (!message || !parsed.timestamp) {
      continue;
    }

    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    if (role === 'assistant' && Object.prototype.hasOwnProperty.call(message, 'usage')) {
      const usage = parseUsageFromShape(message.usage);
      if (!usage) {
        continue;
      }

      entries.push({
        timestamp: parsed.timestamp,
        sessionId: context.sessionId,
        agentId: context.agentId,
        model: message.model ?? message.modelRef,
        provider: message.provider,
        ...usage,
      });
      continue;
    }

    if (role !== 'toolresult' && role !== 'tool_result') {
      continue;
    }

    const details = message.details;
    if (!details || !Object.prototype.hasOwnProperty.call(details, 'usage')) {
      continue;
    }

    const usage = parseUsageFromShape(details.usage);
    if (!usage) {
      continue;
    }

    entries.push({
      timestamp: parsed.timestamp,
      sessionId: context.sessionId,
      agentId: context.agentId,
      model: details.model ?? message.model ?? message.modelRef,
      provider: details.provider ?? details.externalContent?.provider ?? message.provider,
      ...usage,
    });
  }

  return entries;
}

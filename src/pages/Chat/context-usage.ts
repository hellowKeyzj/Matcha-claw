import type { SessionContextTokenSnapshot } from '../../../runtime-host/shared/session-adapter-types';
import type { ModelCatalogEntry } from '@/types/subagent';

export type ChatContextUsageLevel = 'neutral' | 'warning' | 'danger';

export interface ChatContextUsageViewModel {
  usedTokens: number;
  limitTokens: number;
  pct: number;
  detail: string;
  level: ChatContextUsageLevel;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizePositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export function formatTokensCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

export function buildChatContextUsageViewModel(input: {
  snapshot: SessionContextTokenSnapshot | null | undefined;
  currentModelId: string | null | undefined;
  availableModels: readonly ModelCatalogEntry[];
}): ChatContextUsageViewModel | null {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.totalTokensFresh === false) {
    return null;
  }

  const usedTokens = normalizeNonNegativeNumber(snapshot.totalTokens);
  if (usedTokens === null) {
    return null;
  }

  const currentModelId = input.currentModelId?.trim() ?? '';
  const modelContextWindow = currentModelId
    ? input.availableModels.find((model) => model.id === currentModelId)?.contextWindow
    : undefined;
  const limitTokens = normalizePositiveNumber(snapshot.contextTokens) ?? normalizePositiveNumber(modelContextWindow);
  if (limitTokens === null) {
    return null;
  }

  const ratio = usedTokens / limitTokens;
  const pct = Math.min(Math.round(ratio * 100), 100);
  const level: ChatContextUsageLevel = ratio >= 0.95 ? 'danger' : ratio >= 0.85 ? 'warning' : 'neutral';
  return {
    usedTokens,
    limitTokens,
    pct,
    detail: `${formatTokensCompact(usedTokens)} / ${formatTokensCompact(limitTokens)}`,
    level,
  };
}

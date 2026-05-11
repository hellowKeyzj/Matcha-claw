import type {
  SessionWindowStateSnapshot,
} from '../../shared/session-adapter-types';
import {
  normalizeFiniteNumber,
  normalizeString,
} from './session-value-normalization';

export type SessionWindowMode = 'latest' | 'older' | 'newer';

export function normalizeWindowMode(value: unknown): SessionWindowMode {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'older' || normalized === 'newer') {
    return normalized;
  }
  return 'latest';
}

export function normalizeWindowLimit(value: unknown): number {
  const parsed = normalizeFiniteNumber(value);
  if (parsed == null) {
    return 80;
  }
  return Math.min(Math.max(Math.floor(parsed), 0), 200);
}

export function normalizeWindowOffset(value: unknown): number | null {
  const parsed = normalizeFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  return Math.max(Math.floor(parsed), 0);
}

export function normalizeIncludeCanonical(value: unknown): boolean {
  return value === true;
}

export function createWindowStateSnapshot(input: {
  totalItemCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}): SessionWindowStateSnapshot {
  return {
    totalItemCount: input.totalItemCount,
    windowStartOffset: input.windowStartOffset,
    windowEndOffset: input.windowEndOffset,
    hasMore: input.hasMore,
    hasNewer: input.hasNewer,
    isAtLatest: input.isAtLatest,
  };
}

export function createLatestWindowState(totalItemCount: number): SessionWindowStateSnapshot {
  return createWindowStateSnapshot({
    totalItemCount,
    windowStartOffset: 0,
    windowEndOffset: totalItemCount,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  });
}

export function cloneSessionWindowState(window: SessionWindowStateSnapshot): SessionWindowStateSnapshot {
  return { ...window };
}

export function clampWindowState(
  window: SessionWindowStateSnapshot,
  totalItemCount: number,
): SessionWindowStateSnapshot {
  const start = Math.max(0, Math.min(window.windowStartOffset, totalItemCount));
  const end = Math.max(start, Math.min(window.windowEndOffset, totalItemCount));
  return createWindowStateSnapshot({
    totalItemCount,
    windowStartOffset: start,
    windowEndOffset: end,
    hasMore: start > 0,
    hasNewer: end < totalItemCount,
    isAtLatest: end >= totalItemCount,
  });
}

export function buildWindowRange(input: {
  totalItemCount: number;
  mode: SessionWindowMode;
  limit: number;
  offset: number | null;
}): { start: number; end: number } {
  const { totalItemCount, mode, limit, offset } = input;
  if (mode === 'older') {
    const anchor = Math.min(Math.max(offset ?? totalItemCount, 0), totalItemCount);
    return {
      start: Math.max(0, anchor - limit),
      end: Math.min(totalItemCount, anchor + limit),
    };
  }
  if (mode === 'newer') {
    const start = Math.min(Math.max(offset ?? totalItemCount, 0), totalItemCount);
    return {
      start,
      end: Math.min(totalItemCount, start + limit),
    };
  }
  return {
    start: Math.max(0, totalItemCount - limit),
    end: totalItemCount,
  };
}

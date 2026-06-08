import type { SessionContextTokenSnapshot } from '../../shared/session-adapter-types';

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readSessionContextTokenSnapshot(
  entry: Record<string, unknown> | null | undefined,
): SessionContextTokenSnapshot | undefined {
  if (!entry) {
    return undefined;
  }
  const totalTokens = readFiniteNumber(entry.totalTokens);
  const contextTokens = readFiniteNumber(entry.contextTokens);
  const totalTokensFresh = typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined;
  if (totalTokens === undefined && contextTokens === undefined && totalTokensFresh === undefined) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(totalTokensFresh !== undefined ? { totalTokensFresh } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

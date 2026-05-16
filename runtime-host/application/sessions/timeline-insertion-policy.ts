import type {
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  normalizeString,
} from './session-value-normalization';

export function findTimelineEntryIndex(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.key === incoming.key) {
      return index;
    }
  }
  return -1;
}

export function resolveTimelineInsertionIndex(
  candidates: SessionTimelineEntry[],
  entry: SessionTimelineEntry,
  fallbackIndex: number,
): number {
  const runId = normalizeString(entry.runId);
  const sequenceId = entry.sequenceId;
  if (!runId || sequenceId == null) {
    return fallbackIndex;
  }

  let lastSameRunIndex = -1;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]!;
    if (normalizeString(candidate.runId) !== runId) {
      continue;
    }
    const candidateSequenceId = candidate.sequenceId;
    if (candidateSequenceId == null) {
      continue;
    }
    if (candidateSequenceId > sequenceId) {
      return candidateIndex;
    }
    lastSameRunIndex = candidateIndex;
  }

  if (lastSameRunIndex >= 0) {
    return lastSameRunIndex + 1;
  }
  return fallbackIndex;
}

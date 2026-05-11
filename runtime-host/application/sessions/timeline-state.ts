import type {
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  mergeTimelineEntry,
} from './timeline-entry-merge';
import {
  findTimelineEntryIndex,
  resolveTimelineInsertionIndex,
} from './timeline-insertion-policy';

export {
  findTimelineEntryIndex,
} from './timeline-insertion-policy';

function cloneTimelineEntries(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  return structuredClone(entries);
}

export function upsertTimelineEntry(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): SessionTimelineEntry[] {
  const index = findTimelineEntryIndex(entries, incoming);

  if (index < 0) {
    const nextEntries = cloneTimelineEntries(entries);
    const insertionIndex = resolveTimelineInsertionIndex(nextEntries, incoming, nextEntries.length);
    nextEntries.splice(insertionIndex, 0, structuredClone(incoming));
    return nextEntries;
  }

  const mergedEntry = mergeTimelineEntry(entries[index]!, incoming);
  const nextEntries = cloneTimelineEntries(entries);
  nextEntries[index] = mergedEntry;
  return nextEntries;
}

export function mergeTimelineEntries(
  transcriptEntries: SessionTimelineEntry[],
  overlayEntries: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  let mergedEntries = cloneTimelineEntries(transcriptEntries);
  for (const entry of overlayEntries) {
    mergedEntries = upsertTimelineEntry(mergedEntries, entry);
  }
  return mergedEntries;
}

export function resolveTimelineLastActivityAt(
  entries: SessionTimelineEntry[],
  runtime: SessionRuntimeStateSnapshot,
): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = entries[index]?.createdAt;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return typeof runtime.updatedAt === 'number' && Number.isFinite(runtime.updatedAt)
    ? runtime.updatedAt
    : undefined;
}

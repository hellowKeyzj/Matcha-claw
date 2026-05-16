import type { SessionTimelineEntry } from '../../shared/session-adapter-types';

/**
 * Merge an incoming timeline entry on top of an existing one identified by
 * the same key. The incoming entry is already produced by the materializer
 * with full knowledge of the existing entry (segments rebuilt from chat
 * content + previous tool runtime state), so the merge here is a structural
 * replacement that simply preserves stable identity fields.
 */
export function mergeTimelineEntry(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
): SessionTimelineEntry {
  if (!existing) {
    return structuredClone(incoming);
  }

  if (existing.kind !== incoming.kind) {
    return structuredClone(incoming);
  }

  return {
    ...structuredClone(incoming),
    entryId: incoming.entryId ?? existing.entryId,
    laneKey: incoming.laneKey ?? existing.laneKey,
    turnKey: incoming.turnKey ?? existing.turnKey,
  };
}

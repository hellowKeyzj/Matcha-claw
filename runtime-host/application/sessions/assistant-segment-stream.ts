import type {
  SessionAssistantTurnSegment,
} from '../../shared/session-adapter-types';
import {
  buildTurnScopedAssistantSegmentKey,
  cloneSegmentWithKey,
  countSegmentsOfKind,
  normalizeToolSegmentCardKey,
  type StableAssistantSegmentKind,
} from './assistant-segment-primitives';

function findLastSegmentIndexByKind(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  kind: StableAssistantSegmentKind,
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.kind === kind) {
      return index;
    }
  }
  return -1;
}

function hasLaterDifferentKindSegment(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  index: number,
  kind: StableAssistantSegmentKind,
): boolean {
  for (let cursor = index + 1; cursor < segments.length; cursor += 1) {
    if (segments[cursor]?.kind !== kind) {
      return true;
    }
  }
  return false;
}

function findToolSegmentIndex(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  toolKey: string,
): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment?.kind !== 'tool') {
      continue;
    }
    if (normalizeToolSegmentCardKey(segment.tool) === toolKey) {
      return index;
    }
  }
  return -1;
}

export function mergeAssistantSegmentStream(input: {
  turnKey: string;
  laneKey: string;
  existingSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  incomingSegments: ReadonlyArray<SessionAssistantTurnSegment>;
}): SessionAssistantTurnSegment[] {
  const merged: SessionAssistantTurnSegment[] = [...structuredClone(input.existingSegments)];
  for (const incoming of input.incomingSegments) {
    if (incoming.kind === 'tool') {
      const toolKey = normalizeToolSegmentCardKey(incoming.tool);
      const existingIndex = findToolSegmentIndex(merged, toolKey);
      if (existingIndex >= 0) {
        merged[existingIndex] = structuredClone(incoming);
      } else {
        merged.push(structuredClone(incoming));
      }
      continue;
    }

    const latestIndex = findLastSegmentIndexByKind(merged, incoming.kind);
    if (latestIndex >= 0 && !hasLaterDifferentKindSegment(merged, latestIndex, incoming.kind)) {
      merged[latestIndex] = cloneSegmentWithKey(incoming, merged[latestIndex]!.key);
      continue;
    }

    const slot = countSegmentsOfKind(merged, incoming.kind);
    merged.push(cloneSegmentWithKey(incoming, buildTurnScopedAssistantSegmentKey({
      kind: incoming.kind,
      turnKey: input.turnKey,
      laneKey: input.laneKey,
      slot,
    })));
  }
  return merged;
}

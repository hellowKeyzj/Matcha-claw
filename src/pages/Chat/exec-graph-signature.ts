import { resolveEntryAssistantLaneTurnMatchKey } from './chat-row-model';
import {
  EMPTY_TIMELINE_ENTRIES,
  type CompletionEventAnchor,
} from './exec-graph-types';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

export function buildHistoryFingerprint(timelineEntries: SessionTimelineEntry[]): string {
  const count = timelineEntries.length;
  if (count === 0) {
    return '0';
  }
  const first = timelineEntries[0];
  const last = timelineEntries[count - 1];
  return [
    count,
    first?.entryId ?? '',
    first?.timestamp ?? '',
    last?.entryId ?? '',
    last?.timestamp ?? '',
  ].join('|');
}

function buildGraphSignature(input: {
  anchor: CompletionEventAnchor;
  agentLabel: string;
  currentSessionKey: string;
  showThinking: boolean;
  subagentHistoryFingerprint: string;
  anchorLaneFingerprint: string;
}): string {
  const { anchor } = input;
  return [
    input.currentSessionKey,
    anchor.eventIndex,
    anchor.triggerIndex,
    anchor.replyIndex ?? -1,
    anchor.sessionKey,
    anchor.sessionId ?? '',
    anchor.agentId ?? '',
    input.agentLabel,
    input.showThinking ? '1' : '0',
    input.subagentHistoryFingerprint,
    input.anchorLaneFingerprint,
  ].join('|');
}

function buildAnchorLaneFingerprint(
  timelineEntries: SessionTimelineEntry[],
  anchor: CompletionEventAnchor,
): string {
  const triggerEntry = timelineEntries[anchor.triggerIndex];
  const replyEntry = anchor.replyIndex != null ? timelineEntries[anchor.replyIndex] : null;
  return [
    triggerEntry?.entryId ?? '',
    replyEntry?.entryId ?? '',
    resolveEntryAssistantLaneTurnMatchKey(replyEntry) ?? '',
  ].join('|');
}

function areAnchorsEquivalent(
  left: CompletionEventAnchor,
  right: CompletionEventAnchor,
): boolean {
  return (
    left.eventIndex === right.eventIndex
    && left.triggerIndex === right.triggerIndex
    && left.replyIndex === right.replyIndex
    && left.sessionKey === right.sessionKey
    && (left.sessionId ?? '') === (right.sessionId ?? '')
    && (left.agentId ?? '') === (right.agentId ?? '')
  );
}

export function findFirstChangedCompletionAnchorIndex(
  previousAnchors: CompletionEventAnchor[] | undefined,
  nextAnchors: CompletionEventAnchor[],
): number {
  if (!previousAnchors || previousAnchors.length === 0 || nextAnchors.length === 0) {
    return 0;
  }
  const sharedLength = Math.min(previousAnchors.length, nextAnchors.length);
  let firstChanged = 0;
  while (firstChanged < sharedLength) {
    if (!areAnchorsEquivalent(previousAnchors[firstChanged], nextAnchors[firstChanged])) {
      return firstChanged;
    }
    firstChanged += 1;
  }
  return firstChanged;
}

export function findReusableGraphSignaturePrefix(input: {
  previousAnchors: CompletionEventAnchor[] | undefined;
  nextAnchors: CompletionEventAnchor[];
  previousTimelineEntries: SessionTimelineEntry[] | undefined;
  nextTimelineEntries: SessionTimelineEntry[];
}): number {
  const anchorPrefix = findFirstChangedCompletionAnchorIndex(
    input.previousAnchors,
    input.nextAnchors,
  );
  if (
    anchorPrefix <= 0
    || !input.previousAnchors
    || !input.previousTimelineEntries
  ) {
    return anchorPrefix;
  }

  let reusablePrefix = 0;
  const sharedLength = Math.min(anchorPrefix, input.previousAnchors.length, input.nextAnchors.length);
  while (reusablePrefix < sharedLength) {
    const previousFingerprint = buildAnchorLaneFingerprint(
      input.previousTimelineEntries,
      input.previousAnchors[reusablePrefix],
    );
    const nextFingerprint = buildAnchorLaneFingerprint(
      input.nextTimelineEntries,
      input.nextAnchors[reusablePrefix],
    );
    if (previousFingerprint !== nextFingerprint) {
      return reusablePrefix;
    }
    reusablePrefix += 1;
  }
  return reusablePrefix;
}

export function buildGraphSignaturesByAnchor(input: {
  anchors: CompletionEventAnchor[];
  currentSessionKey: string;
  showThinking: boolean;
  timelineEntries: SessionTimelineEntry[];
  subagentHistoryBySession: Map<string, SessionTimelineEntry[]>;
  agentNameById: Map<string, string>;
  startIndex?: number;
  previousSignatures?: string[];
}): string[] {
  const maxStartIndex = Math.max(0, Math.min(input.anchors.length, input.startIndex ?? 0));
  const previousSignatures = input.previousSignatures ?? [];
  const startIndex = Math.min(maxStartIndex, previousSignatures.length);
  const subagentFingerprintBySession = new Map<string, string>();
  const signatures = startIndex > 0
    ? previousSignatures.slice(0, startIndex)
    : [];
  for (let anchorIndex = startIndex; anchorIndex < input.anchors.length; anchorIndex += 1) {
    const anchor = input.anchors[anchorIndex];
    const sessionFingerprint = (() => {
      const cached = subagentFingerprintBySession.get(anchor.sessionKey);
      if (cached) {
        return cached;
      }
      const fingerprint = buildHistoryFingerprint(
        input.subagentHistoryBySession.get(anchor.sessionKey) ?? EMPTY_TIMELINE_ENTRIES,
      );
      subagentFingerprintBySession.set(anchor.sessionKey, fingerprint);
      return fingerprint;
    })();
    const resolvedAgentName = anchor.agentId
      ? (input.agentNameById.get(anchor.agentId) || anchor.agentId)
      : 'subagent';
    signatures.push(buildGraphSignature({
      anchor,
      agentLabel: resolvedAgentName,
      currentSessionKey: input.currentSessionKey,
      showThinking: input.showThinking,
      subagentHistoryFingerprint: sessionFingerprint,
      anchorLaneFingerprint: buildAnchorLaneFingerprint(input.timelineEntries, anchor),
    }));
  }
  return signatures;
}

export function findFirstChangedAnchorIndex(
  previousSignatures: string[] | undefined,
  nextSignatures: string[],
): number {
  if (!previousSignatures || previousSignatures.length === 0 || nextSignatures.length === 0) {
    return 0;
  }
  const sharedLength = Math.min(previousSignatures.length, nextSignatures.length);
  let firstChanged = 0;
  while (firstChanged < sharedLength) {
    if (previousSignatures[firstChanged] !== nextSignatures[firstChanged]) {
      return firstChanged;
    }
    firstChanged += 1;
  }
  return firstChanged;
}

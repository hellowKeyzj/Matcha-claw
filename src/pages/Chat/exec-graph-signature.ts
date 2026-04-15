import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  EMPTY_MESSAGES,
  type CompletionEventAnchor,
} from './exec-graph-types';

export function buildHistoryFingerprint(messages: RawMessage[]): string {
  const count = messages.length;
  if (count === 0) {
    return '0';
  }
  const first = messages[0];
  const last = messages[count - 1];
  return [
    count,
    first?.id ?? '',
    first?.timestamp ?? '',
    last?.id ?? '',
    last?.timestamp ?? '',
  ].join('|');
}

export function buildStreamingSignature(
  streamingMessage: unknown | null,
  streamingTools: ToolStatus[],
): string {
  const messageObj = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as Record<string, unknown>
    : null;
  const messageSignature = messageObj
    ? [
        String(messageObj.id ?? ''),
        String(messageObj.role ?? ''),
        String(messageObj.timestamp ?? ''),
      ].join(':')
    : String(streamingMessage ?? '');
  const toolsSignature = streamingTools
    .map((tool) => `${tool.toolCallId ?? tool.id ?? tool.name}:${tool.status}:${tool.updatedAt}`)
    .join(',');
  return `${messageSignature}|${toolsSignature}`;
}

function buildGraphSignature(input: {
  anchor: CompletionEventAnchor;
  agentLabel: string;
  includeStreaming: boolean;
  currentSessionKey: string;
  showThinking: boolean;
  pendingFinal: boolean;
  streamingSignature: string;
  subagentHistoryFingerprint: string;
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
    input.includeStreaming ? '1' : '0',
    input.showThinking ? '1' : '0',
    input.pendingFinal ? '1' : '0',
    input.includeStreaming ? input.streamingSignature : '',
    input.subagentHistoryFingerprint,
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

export function buildGraphSignaturesByAnchor(input: {
  anchors: CompletionEventAnchor[];
  currentSessionKey: string;
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
  streamingSignature: string;
  subagentHistoryBySession: Map<string, RawMessage[]>;
  agentNameById: Map<string, string>;
  startIndex?: number;
  previousSignatures?: string[];
}): string[] {
  const lastAnchorIndex = input.anchors.length - 1;
  const maxStartIndex = Math.max(0, Math.min(input.anchors.length, input.startIndex ?? 0));
  const previousSignatures = input.previousSignatures ?? [];
  const startIndex = Math.min(maxStartIndex, previousSignatures.length);
  const subagentFingerprintBySession = new Map<string, string>();
  const signatures = startIndex > 0
    ? previousSignatures.slice(0, startIndex)
    : [];
  for (let anchorIndex = startIndex; anchorIndex < input.anchors.length; anchorIndex += 1) {
    const anchor = input.anchors[anchorIndex];
    const includeStreaming = input.sending && anchorIndex === lastAnchorIndex;
    const sessionFingerprint = (() => {
      const cached = subagentFingerprintBySession.get(anchor.sessionKey);
      if (cached) {
        return cached;
      }
      const fingerprint = buildHistoryFingerprint(
        input.subagentHistoryBySession.get(anchor.sessionKey) ?? EMPTY_MESSAGES,
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
      includeStreaming,
      currentSessionKey: input.currentSessionKey,
      showThinking: input.showThinking,
      pendingFinal: input.pendingFinal,
      streamingSignature: input.streamingSignature,
      subagentHistoryFingerprint: sessionFingerprint,
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

import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@/stores/chat';
import {
  buildGraphSignaturesByAnchor,
  findFirstChangedCompletionAnchorIndex,
} from '@/pages/Chat/exec-graph-signature';
import type { CompletionEventAnchor } from '@/pages/Chat/exec-graph-types';

const EMPTY_STREAMING_SIGNATURE = '|';

function buildHistoryMessages(seed: string): RawMessage[] {
  return [
    { id: `${seed}-1`, role: 'assistant', content: `${seed}-content-1`, timestamp: 1 },
    { id: `${seed}-2`, role: 'assistant', content: `${seed}-content-2`, timestamp: 2 },
  ];
}

describe('exec graph signature helpers', () => {
  it('computes first changed completion anchor index for append and mutation cases', () => {
    const baseAnchors: CompletionEventAnchor[] = [
      { eventIndex: 2, triggerIndex: 1, replyIndex: 3, sessionKey: 'child-1', agentId: 'coder' },
      { eventIndex: 6, triggerIndex: 5, replyIndex: 7, sessionKey: 'child-2', agentId: 'coder' },
    ];

    const appendedAnchors: CompletionEventAnchor[] = [
      ...baseAnchors,
      { eventIndex: 10, triggerIndex: 9, replyIndex: 11, sessionKey: 'child-3', agentId: 'planner' },
    ];
    expect(findFirstChangedCompletionAnchorIndex(baseAnchors, appendedAnchors)).toBe(2);

    const mutatedAnchors: CompletionEventAnchor[] = [
      { ...baseAnchors[0] },
      { ...baseAnchors[1], replyIndex: 8 },
    ];
    expect(findFirstChangedCompletionAnchorIndex(baseAnchors, mutatedAnchors)).toBe(1);
  });

  it('supports incremental signature build with reusable prefix', () => {
    const previousAnchors: CompletionEventAnchor[] = [
      { eventIndex: 2, triggerIndex: 1, replyIndex: 3, sessionKey: 'child-1', agentId: 'coder' },
      { eventIndex: 6, triggerIndex: 5, replyIndex: 7, sessionKey: 'child-2', agentId: 'coder' },
    ];
    const nextAnchors: CompletionEventAnchor[] = [
      ...previousAnchors,
      { eventIndex: 10, triggerIndex: 9, replyIndex: 11, sessionKey: 'child-3', agentId: 'planner' },
    ];
    const subagentHistoryBySession = new Map<string, RawMessage[]>([
      ['child-1', buildHistoryMessages('child-1')],
      ['child-2', buildHistoryMessages('child-2')],
      ['child-3', buildHistoryMessages('child-3')],
    ]);
    const agentNameById = new Map<string, string>([
      ['coder', 'Coder'],
      ['planner', 'Planner'],
    ]);

    const previousSignatures = buildGraphSignaturesByAnchor({
      anchors: previousAnchors,
      currentSessionKey: 'agent:main:session-1',
      sending: false,
      pendingFinal: false,
      showThinking: true,
      streamingSignature: EMPTY_STREAMING_SIGNATURE,
      subagentHistoryBySession,
      agentNameById,
    });
    const fullNextSignatures = buildGraphSignaturesByAnchor({
      anchors: nextAnchors,
      currentSessionKey: 'agent:main:session-1',
      sending: false,
      pendingFinal: false,
      showThinking: true,
      streamingSignature: EMPTY_STREAMING_SIGNATURE,
      subagentHistoryBySession,
      agentNameById,
    });

    const reusablePrefix = findFirstChangedCompletionAnchorIndex(previousAnchors, nextAnchors);
    const incrementalNextSignatures = buildGraphSignaturesByAnchor({
      anchors: nextAnchors,
      currentSessionKey: 'agent:main:session-1',
      sending: false,
      pendingFinal: false,
      showThinking: true,
      streamingSignature: EMPTY_STREAMING_SIGNATURE,
      subagentHistoryBySession,
      agentNameById,
      startIndex: reusablePrefix,
      previousSignatures,
    });

    expect(reusablePrefix).toBe(2);
    expect(incrementalNextSignatures).toEqual(fullNextSignatures);
  });
});


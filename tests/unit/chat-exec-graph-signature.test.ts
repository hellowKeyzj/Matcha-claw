import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@/stores/chat';
import {
  buildGraphSignaturesByAnchor,
  findFirstChangedCompletionAnchorIndex,
  findReusableGraphSignaturePrefix,
} from '@/pages/Chat/exec-graph-signature';
import type { CompletionEventAnchor } from '@/pages/Chat/exec-graph-types';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';

function buildHistoryMessages(seed: string): RawMessage[] {
  return [
    { id: `${seed}-1`, role: 'assistant', content: `${seed}-content-1`, timestamp: 1 },
    { id: `${seed}-2`, role: 'assistant', content: `${seed}-content-2`, timestamp: 2 },
  ];
}

function buildMainMessages(seed: string): RawMessage[] {
  return [
    { id: `${seed}-user`, role: 'user', content: `${seed}-user-content`, timestamp: 1 },
    {
      id: `${seed}-assistant`,
      role: 'assistant',
      content: `${seed}-assistant-content`,
      timestamp: 2,
      agentId: 'coder',
      uniqueId: `${seed}-turn`,
      requestId: `${seed}-user`,
    },
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
    const subagentTimelinesBySession = new Map(
      Array.from(subagentHistoryBySession.entries()).map(([sessionKey, messages]) => (
        [sessionKey, buildTimelineEntriesFromMessages(sessionKey, messages)] as const
      )),
    );
    const agentNameById = new Map<string, string>([
      ['coder', 'Coder'],
      ['planner', 'Planner'],
    ]);
    const mainTimelineEntries = buildTimelineEntriesFromMessages(
      'agent:main:session-1',
      buildMainMessages('shared'),
    );

    const previousSignatures = buildGraphSignaturesByAnchor({
      anchors: previousAnchors,
      currentSessionKey: 'agent:main:session-1',
      showThinking: true,
      timelineEntries: mainTimelineEntries,
      subagentHistoryBySession: subagentTimelinesBySession,
      agentNameById,
    });
    const fullNextSignatures = buildGraphSignaturesByAnchor({
      anchors: nextAnchors,
      currentSessionKey: 'agent:main:session-1',
      showThinking: true,
      timelineEntries: mainTimelineEntries,
      subagentHistoryBySession: subagentTimelinesBySession,
      agentNameById,
    });

    const reusablePrefix = findReusableGraphSignaturePrefix({
      previousAnchors,
      nextAnchors,
      previousTimelineEntries: mainTimelineEntries,
      nextTimelineEntries: mainTimelineEntries,
    });
    const incrementalNextSignatures = buildGraphSignaturesByAnchor({
      anchors: nextAnchors,
      currentSessionKey: 'agent:main:session-1',
      showThinking: true,
      timelineEntries: mainTimelineEntries,
      subagentHistoryBySession: subagentTimelinesBySession,
      agentNameById,
      startIndex: reusablePrefix,
      previousSignatures,
    });

    expect(reusablePrefix).toBe(2);
    expect(incrementalNextSignatures).toEqual(fullNextSignatures);
  });

  it('changes graph signature when the anchor assistant lane identity changes even if indices stay the same', () => {
    const anchors: CompletionEventAnchor[] = [
      { eventIndex: 1, triggerIndex: 0, replyIndex: 1, sessionKey: 'child-1', agentId: 'coder' },
    ];
    const subagentHistoryBySession = new Map<string, RawMessage[]>([
      ['child-1', buildHistoryMessages('child-1')],
    ]);
    const subagentTimelinesBySession = new Map(
      Array.from(subagentHistoryBySession.entries()).map(([sessionKey, messages]) => (
        [sessionKey, buildTimelineEntriesFromMessages(sessionKey, messages)] as const
      )),
    );
    const agentNameById = new Map<string, string>([
      ['coder', 'Coder'],
    ]);

    const signaturesA = buildGraphSignaturesByAnchor({
      anchors,
      currentSessionKey: 'agent:main:session-1',
      showThinking: true,
      timelineEntries: buildTimelineEntriesFromMessages(
        'agent:main:session-1',
        buildMainMessages('alpha'),
      ),
      subagentHistoryBySession: subagentTimelinesBySession,
      agentNameById,
    });
    const signaturesB = buildGraphSignaturesByAnchor({
      anchors,
      currentSessionKey: 'agent:main:session-1',
      showThinking: true,
      timelineEntries: buildTimelineEntriesFromMessages('agent:main:session-1', [{
        id: 'alpha-user',
        role: 'user',
        content: 'alpha-user-content',
        timestamp: 1,
      }, {
        id: 'alpha-assistant',
        role: 'assistant',
        content: 'alpha-assistant-content',
        timestamp: 2,
        agentId: 'reviewer',
        uniqueId: 'beta-turn',
        requestId: 'alpha-user',
      }]),
      subagentHistoryBySession: subagentTimelinesBySession,
      agentNameById: new Map<string, string>([
        ['coder', 'Coder'],
        ['reviewer', 'Reviewer'],
      ]),
    });

    expect(signaturesA).not.toEqual(signaturesB);
  });
});

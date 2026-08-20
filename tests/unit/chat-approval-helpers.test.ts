import { describe, expect, it } from 'vitest';
import {
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from '@/stores/chat/approval-handlers';
import type { ApprovalItem } from '@/stores/chat/types';

function approval(approvalId: string, sessionKey: string, optionIds: string[] = ['option-1']): ApprovalItem {
  return { approvalId, optionIds, sessionKey };
}

describe('chat approval handlers', () => {
  it('groups opaque native snapshot projections by renderer session', () => {
    const grouped = groupApprovalsBySession([
      approval('approval-b', 'agent:main:main'),
      approval('approval-a', 'agent:main:main'),
      approval('approval-c', 'agent:foo:main'),
    ]);

    expect(grouped['agent:main:main']?.map((item) => item.approvalId)).toEqual(['approval-b', 'approval-a']);
    expect(grouped['agent:foo:main']?.map((item) => item.approvalId)).toEqual(['approval-c']);
  });

  it('replaces only the sessions refreshed from a native snapshot', () => {
    const patch = buildSyncPendingApprovalsPatch({
      state: {
        pendingApprovalsBySession: {
          'agent:old:main': [approval('old', 'agent:old:main')],
        },
      } as never,
      grouped: {
        'agent:main:main': [approval('approval-a', 'agent:main:main')],
      },
      sessionKeys: ['agent:old:main', 'agent:main:main'],
    });

    expect(patch.pendingApprovalsBySession).toEqual({
      'agent:old:main': [],
      'agent:main:main': [approval('approval-a', 'agent:main:main')],
    });
  });

  it('does not discard another session cache during a targeted refresh', () => {
    const patch = buildSyncPendingApprovalsPatch({
      state: {
        pendingApprovalsBySession: {
          'agent:main:main': [approval('stale', 'agent:main:main')],
          'agent:other:main': [approval('other', 'agent:other:main')],
        },
      } as never,
      grouped: {},
      sessionKeys: ['agent:main:main'],
    });

    expect(patch.pendingApprovalsBySession).toEqual({
      'agent:main:main': [],
      'agent:other:main': [approval('other', 'agent:other:main')],
    });
  });
});

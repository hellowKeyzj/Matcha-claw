import { describe, expect, it } from 'vitest';
import {
  buildApprovalResolvedPatch,
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from '@/stores/chat/approval-handlers';
import type { ApprovalItem } from '@/stores/chat/types';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

function approval(input: Partial<ApprovalItem> & Pick<ApprovalItem, 'id' | 'sessionKey' | 'createdAtMs'>): ApprovalItem {
  return {
    title: input.title ?? 'approval',
    backendSessionKey: input.backendSessionKey ?? input.sessionKey,
    sessionIdentity: input.sessionIdentity ?? createOpenClawTestSessionIdentity(input.sessionKey),
    allowedDecisions: input.allowedDecisions ?? ['allow-once', 'deny'],
    ...input,
  };
}

describe('chat approval handlers', () => {
  it('groups canonical approvals by session and sorts by creation time', () => {
    const grouped = groupApprovalsBySession([
      approval({ id: 'approval-b', sessionKey: 'agent:main:main', createdAtMs: 2 }),
      approval({ id: 'approval-a', sessionKey: 'agent:main:main', createdAtMs: 1 }),
      approval({ id: 'approval-c', sessionKey: 'agent:foo:main', createdAtMs: 3 }),
    ]);

    expect(grouped['agent:main:main']?.map((item) => item.id)).toEqual(['approval-a', 'approval-b']);
    expect(grouped['agent:foo:main']?.map((item) => item.id)).toEqual(['approval-c']);
  });

  it('syncs pending approvals from canonical runtime-host response', () => {
    const patch = buildSyncPendingApprovalsPatch({
      state: {
        pendingApprovalsBySession: {
          'agent:old:main': [approval({ id: 'old', sessionKey: 'agent:old:main', createdAtMs: 0 })],
        },
      } as never,
      grouped: {
        'agent:main:main': [approval({ id: 'approval-a', sessionKey: 'agent:main:main', createdAtMs: 1 })],
      },
      sessionKeys: ['agent:old:main', 'agent:main:main'],
    });

    expect(patch.pendingApprovalsBySession).toEqual({
      'agent:old:main': [],
      'agent:main:main': [expect.objectContaining({ id: 'approval-a' })],
    });
  });

  it('can sync only the hinted session without discarding other session approvals', () => {
    const patch = buildSyncPendingApprovalsPatch({
      state: {
        pendingApprovalsBySession: {
          'agent:main:main': [approval({ id: 'stale', sessionKey: 'agent:main:main', createdAtMs: 1 })],
          'agent:other:main': [approval({ id: 'other', sessionKey: 'agent:other:main', createdAtMs: 2 })],
        },
      } as never,
      grouped: {},
      sessionKeys: ['agent:main:main'],
    });

    expect(patch.pendingApprovalsBySession).toEqual({
      'agent:main:main': [],
      'agent:other:main': [expect.objectContaining({ id: 'other' })],
    });
  });

  it('removes resolved approvals from the matching session', () => {
    const patch = buildApprovalResolvedPatch({
      state: {
        currentSessionKey: 'agent:main:main',
        pendingApprovalsBySession: {
          'agent:main:main': [approval({ id: 'approval-a', sessionKey: 'agent:main:main', createdAtMs: 1 })],
        },
      } as never,
      id: 'approval-a',
      decision: 'allow-once',
    });

    expect(patch).toEqual({
      pendingApprovalsBySession: {
        'agent:main:main': [],
      },
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildTaskInboxBridgeState,
  normalizeTaskInboxSessionKey,
  parseSessionUpdatedAtMs,
  resolvePreferredSessionKeyForAgent,
  resolveSessionThinkingLevelFromList,
  shouldKeepMissingCurrentSession,
} from '@/stores/chat/session-helpers';

describe('chat session helpers', () => {
  it('resolves thinking level from sessions list', () => {
    expect(resolveSessionThinkingLevelFromList(
      [{ key: 'agent:main:main', thinkingLevel: ' high ' }],
      'agent:main:main',
    )).toBe('high');
    expect(resolveSessionThinkingLevelFromList([], 'agent:main:main')).toBeNull();
  });

  it('parses session updatedAt in seconds/ms/iso formats', () => {
    expect(parseSessionUpdatedAtMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseSessionUpdatedAtMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(parseSessionUpdatedAtMs('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(parseSessionUpdatedAtMs('')).toBeUndefined();
  });

  it('chooses preferred agent session key by canonical fallback then recency', () => {
    const sessions = [
      { key: 'agent:foo:session-1700000000000' },
      { key: 'agent:foo:main' },
      { key: 'agent:bar:main' },
    ];
    const preferredWithCanonical = resolvePreferredSessionKeyForAgent('foo', sessions, {});
    expect(preferredWithCanonical).toBe('agent:foo:main');

    const sessionsNoCanonical = [
      { key: 'agent:foo:session-1700000000000' },
      { key: 'agent:foo:session-1700000000100' },
    ];
    const preferredByRecency = resolvePreferredSessionKeyForAgent('foo', sessionsNoCanonical, {});
    expect(preferredByRecency).toBe('agent:foo:session-1700000000100');
  });

  it('keeps missing current session only when it has meaningful local state', () => {
    const keepMain = shouldKeepMissingCurrentSession(
      'agent:main:main',
      {
        messages: [{ role: 'user', content: 'hi' }],
        sessionLabels: {},
        sessionLastActivity: {},
        sessionRuntimeByKey: {},
      } as never,
      2,
    );
    expect(keepMain).toBe(true);

    const keepEmptyDraft = shouldKeepMissingCurrentSession(
      'agent:foo:session-1',
      {
        messages: [],
        sessionLabels: {},
        sessionLastActivity: {},
        sessionRuntimeByKey: {},
      } as never,
      2,
    );
    expect(keepEmptyDraft).toBe(true);

    const dropDraftWithRuntime = shouldKeepMissingCurrentSession(
      'agent:foo:session-2',
      {
        messages: [],
        sessionLabels: {},
        sessionLastActivity: {},
        sessionRuntimeByKey: { 'agent:foo:session-2': {} as never },
      } as never,
      2,
    );
    expect(dropDraftWithRuntime).toBe(false);
  });

  it('builds task inbox bridge state from current session runtime flags', () => {
    expect(normalizeTaskInboxSessionKey(' ', 'agent:main:main')).toBe('agent:main:main');
    const bridge = buildTaskInboxBridgeState(
      {
        currentSessionKey: 'agent:foo:main',
        sending: false,
        pendingFinal: false,
        activeRunId: null,
      } as never,
      'agent:main:main',
    );
    expect(bridge).toEqual({
      sessionKey: 'agent:foo:main',
      owner: 'foo',
      canSendRecoveryPrompt: true,
    });
  });
});


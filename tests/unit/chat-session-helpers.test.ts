import { describe, expect, it } from 'vitest';
import {
  buildTaskInboxBridgeState,
  normalizeTaskInboxSessionKey,
  parseSessionUpdatedAtMs,
  readSessionsFromState,
  resolvePreferredSessionKeyForAgent,
  resolveSessionThinkingLevelFromList,
  shouldKeepMissingCurrentSession,
} from '@/stores/chat/session-helpers';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildTimelineEntriesFromMessages } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function createSessionRecord(input?: {
  sessionKey?: string;
  messages?: RawMessage[];
  label?: string | null;
  lastActivityAt?: number | null;
  thinkingLevel?: string | null;
  runtime?: {
    sending?: boolean;
    pendingFinal?: boolean;
    activeRunId?: string | null;
  };
}) {
  const sessionKey = input?.sessionKey ?? 'agent:test:session-1';
  const messages = input?.messages ?? [];
  return {
    meta: {
      label: input?.label ?? null,
      displayName: null,
      model: null,
      lastActivityAt: input?.lastActivityAt ?? null,
      historyStatus: 'idle',
      thinkingLevel: input?.thinkingLevel ?? null,
    },
    runtime: {
      sending: input?.runtime?.sending ?? false,
      pendingFinal: input?.runtime?.pendingFinal ?? false,
      activeRunId: input?.runtime?.activeRunId ?? null,
      runPhase: 'idle' as const,
      streamingMessageId: null,
      lastUserMessageAt: null,
    },
    timelineEntries: buildTimelineEntriesFromMessages(sessionKey, messages),
    window: createViewportWindowState({
      totalMessageCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

describe('chat session helpers', () => {
  it('resolves thinking level from sessions list', () => {
    expect(resolveSessionThinkingLevelFromList(
      [{ key: 'agent:main:main', thinkingLevel: ' high ' }],
      'agent:main:main',
    )).toBe('high');
    expect(resolveSessionThinkingLevelFromList([], 'agent:main:main')).toBeNull();
  });

  it('reads session collection directly from loaded session records and prefers local meta', () => {
    const sessions = readSessionsFromState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          label: '新标题',
          lastActivityAt: 1_800_000_000_000,
          thinkingLevel: 'low',
        }),
        'agent:test:session-1': createSessionRecord({
          label: '本地草稿',
          lastActivityAt: 1_900_000_000_000,
        }),
      },
    } as never);

    expect(sessions.map((session) => session.key)).toEqual([
      'agent:test:session-1',
      'agent:main:main',
    ]);
    expect(sessions[0]?.label).toBe('本地草稿');
    expect(sessions[1]?.label).toBe('新标题');
    expect(sessions[1]?.thinkingLevel).toBe('low');
  });

  it('prefers loaded viewport transcript title over stale stored label', () => {
    const sessions = readSessionsFromState({
      loadedSessions: {
        'agent:test:session-1': createSessionRecord({
          label: '本地旧标题',
          messages: [
            { role: 'user', content: '真正正文标题', timestamp: 1_800_000_001 },
          ],
        }),
      },
    } as never);

    expect(sessions[0]?.label).toBe('真正正文标题');
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
        loadedSessions: {
          'agent:main:main': createSessionRecord({
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      } as never,
      2,
    );
    expect(keepMain).toBe(true);

    const dropMissingDraft = shouldKeepMissingCurrentSession(
      'agent:foo:session-1',
      {
        loadedSessions: {},
      } as never,
      2,
    );
    expect(dropMissingDraft).toBe(false);

    const keepLocalEmptyDraft = shouldKeepMissingCurrentSession(
      'agent:foo:session-2',
      {
        loadedSessions: {
          'agent:foo:session-2': createSessionRecord(),
        },
      } as never,
      2,
    );
    expect(keepLocalEmptyDraft).toBe(true);
  });

  it('builds task inbox bridge state from current session runtime flags', () => {
    expect(normalizeTaskInboxSessionKey(' ', 'agent:main:main')).toBe('agent:main:main');
    const bridge = buildTaskInboxBridgeState(
      {
        currentSessionKey: 'agent:foo:main',
        loadedSessions: {
          'agent:foo:main': createSessionRecord(),
        },
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


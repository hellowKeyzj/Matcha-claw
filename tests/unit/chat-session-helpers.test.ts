import { describe, expect, it } from 'vitest';
import {
  buildTaskBridgeState,
  normalizeAutomaticSessionTitle,
  normalizeTaskSessionKey,
  parseSessionUpdatedAtMs,
  readSessionsFromState,
  resolvePreferredSessionKeyForAgent,
  resolveSessionListLabel,
  resolveSessionThinkingLevelFromList,
  shouldKeepMissingCurrentSession,
  shouldRetainLocalSessionRecord,
  stripAutomaticWorkingDirectoryTitlePrefix,
} from '@/stores/chat/session-helpers';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { ChatSession } from '@/stores/chat';
import { areSessionsEquivalent } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey } from '@/stores/chat/session-identity';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

function createChatSession(input: Partial<ChatSession> & Pick<ChatSession, 'key' | 'agentId'>): ChatSession {
  return {
    sessionIdentity: createOpenClawTestSessionIdentity(input.key, input.agentId),
    ...input,
  };
}

function createSessionRecord(input?: {
  sessionKey?: string;
  messages?: RawMessage[];
  label?: string | null;
  titleSource?: 'user' | 'assistant' | 'none';
  manualLabel?: boolean;
  displayName?: string | null;
  lastActivityAt?: number | null;
  thinkingLevel?: string | null;
  runtime?: {
    activeRunId?: string | null;
  };
}) {
  const sessionKey = input?.sessionKey ?? 'agent:test:session-1';
  const messages = input?.messages ?? [];
  const agentId = sessionKey.split(':')[1] ?? 'main';
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey, agentId);
  return {
    meta: {
      runtimeScopeKey: buildRuntimeScopeKey(sessionIdentity.endpoint),
      agentId,
      protocolId: null,
      runtimeEndpointId: 'local',
      sessionIdentity,
      kind: sessionKey.endsWith(':main') ? 'main' : 'session',
      preferred: sessionKey.endsWith(':main'),
      label: input?.label ?? (messages.length > 0 && typeof messages[messages.length - 1]?.content === 'string'
        ? String(messages[messages.length - 1]?.content)
        : null),
      titleSource: input?.titleSource ?? (input?.label ? 'user' as const : 'none' as const),
      manualLabel: input?.manualLabel ?? false,
      displayName: input?.displayName ?? null,
      model: null,
      lastActivityAt: input?.lastActivityAt ?? null,
      historyStatus: 'idle',
      thinkingLevel: input?.thinkingLevel ?? null,
    },
    runtime: {
      activeRunId: input?.runtime?.activeRunId ?? null,
      runPhase: 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      runtimeActivity: null,
      errorDetail: null,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt: null,
    },
    items: buildRenderItemsFromMessages(sessionKey, messages),
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

describe('chat session helpers', () => {
  it('compares session identity fields without requiring object identity', () => {
    const left = createChatSession({ key: 'agent:main:main', agentId: 'main' });
    const right = {
      ...left,
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main', 'main'),
    };
    const changed = {
      ...left,
      sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main', 'browser'),
    };

    expect(areSessionsEquivalent([left], [right])).toBe(true);
    expect(areSessionsEquivalent([left], [changed])).toBe(false);
  });

  it('resolves thinking level from sessions list', () => {
    expect(resolveSessionThinkingLevelFromList(
      [createChatSession({ key: 'agent:main:main', agentId: 'main', thinkingLevel: ' high ' })],
      'agent:main:main',
    )).toBe('high');
    expect(resolveSessionThinkingLevelFromList([], 'agent:main:main')).toBeNull();
  });

  it('normalizes automatic working-directory session titles', () => {
    expect(stripAutomaticWorkingDirectoryTitlePrefix('[Working directory: E:/code/Matcha]\n\nExplain this repository'))
      .toBe('Explain this repository');
    expect(stripAutomaticWorkingDirectoryTitlePrefix('[Working directory: E:/code/Matcha]…')).toBeNull();
    expect(stripAutomaticWorkingDirectoryTitlePrefix('[Working directory: E:/code/Matcha')).toBeNull();
    expect(normalizeAutomaticSessionTitle('  Plain title  ')).toBe('Plain title');
  });

  it('keeps explicit user labels but cleans automatic session list titles', () => {
    const explicitTitle = '[Working directory: E:/code/Matcha]…';
    expect(resolveSessionListLabel({
      loadedSessions: {
        'agent:test:session-1': createSessionRecord({
          label: explicitTitle,
          titleSource: 'user',
          manualLabel: true,
        }),
      },
    } as never, 'agent:test:session-1')).toBe(explicitTitle);

    expect(resolveSessionListLabel({
      loadedSessions: {
        'agent:test:session-1': createSessionRecord({
          label: '[Working directory: E:/code/Matcha]\n\nExplain this repository',
          titleSource: 'assistant',
        }),
      },
    } as never, 'agent:test:session-1')).toBe('Explain this repository');

    expect(resolveSessionListLabel({
      loadedSessions: {
        'agent:test:session-1': createSessionRecord({
          label: '[Working directory: E:/code/Matcha]…',
          titleSource: 'assistant',
          messages: [{ role: 'user', content: '[Working directory: E:/code/Matcha]\n\nHydrate from prompt' }],
        }),
      },
    } as never, 'agent:test:session-1')).toBe('Hydrate from prompt');
  });

  it('cleans automatic display names in session snapshots', () => {
    const sessions = readSessionsFromState({
      loadedSessions: {
        'agent:test:session-1': createSessionRecord({
          label: null,
          displayName: '[Working directory: E:/code/Matcha]\n\nGenerated title',
          lastActivityAt: 1,
        }),
      },
    } as never);

    expect(sessions[0]?.displayName).toBe('Generated title');
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

  it('reads authoritative store label instead of recomputing from rows', () => {
    const sessions = readSessionsFromState({
      loadedSessions: {
        'agent:test:session-1': createSessionRecord({
          label: '真正正文标题',
          messages: [
            { role: 'user', content: '旧正文内容', timestamp: 1_800_000_001 },
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

  it('chooses preferred agent session key from authoritative catalog preference then recency', () => {
    const sessions = [
      createChatSession({ key: 'agent:foo:session-1700000000000', agentId: 'foo' }),
      createChatSession({ key: 'agent:foo:main', agentId: 'foo', preferred: true }),
      createChatSession({ key: 'agent:bar:main', agentId: 'bar', preferred: true }),
    ];
    const preferredWithCanonical = resolvePreferredSessionKeyForAgent('foo', sessions, {});
    expect(preferredWithCanonical).toBe('agent:foo:main');

    const sessionsNoCanonical = [
      createChatSession({ key: 'agent:foo:session-1700000000000', agentId: 'foo', updatedAt: 1_700_000_000_000 }),
      createChatSession({ key: 'agent:foo:session-1700000000100', agentId: 'foo', updatedAt: 1_700_000_000_100 }),
    ];
    const preferredByRecency = resolvePreferredSessionKeyForAgent('foo', sessionsNoCanonical, {});
    expect(preferredByRecency).toBe('agent:foo:session-1700000000100');
  });

  it('chooses preferred agent sessions without inferring TeamRun role ownership from local id shape', () => {
    const sessions = [
      createChatSession({
        key: 'team-role-session-run-1-leader',
        agentId: 'leader-agent',
        updatedAt: 1_900_000_000_000,
      }),
      createChatSession({
        key: 'agent:leader-agent:main',
        agentId: 'leader-agent',
        preferred: true,
        updatedAt: 1_700_000_000_000,
      }),
    ];

    expect(resolvePreferredSessionKeyForAgent('leader-agent', sessions, {})).toBe('agent:leader-agent:main');
    expect(resolvePreferredSessionKeyForAgent('leader-agent', [sessions[0]!], {})).toBe('team-role-session-run-1-leader');
  });

  it('keeps missing current session only when it has meaningful local state', () => {
    const keepMain = shouldKeepMissingCurrentSession(
      'agent:main:main',
      {
        loadedSessions: {
          'agent:main:main': createSessionRecord({
            sessionKey: 'agent:main:main',
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

  it('does not retain non-current empty local drafts in the session list', () => {
    const retainEmptyCurrent = shouldRetainLocalSessionRecord(
      'agent:foo:session-current',
      {
        currentSessionKey: 'agent:foo:session-current',
        loadedSessions: {
          'agent:foo:session-current': createSessionRecord(),
        },
        pendingApprovalsBySession: {},
      } as never,
    );
    expect(retainEmptyCurrent).toBe(true);

    const retainEmptyBackground = shouldRetainLocalSessionRecord(
      'agent:foo:session-background',
      {
        currentSessionKey: 'agent:foo:session-current',
        loadedSessions: {
          'agent:foo:session-background': createSessionRecord(),
        },
        pendingApprovalsBySession: {},
      } as never,
    );
    expect(retainEmptyBackground).toBe(false);
  });

  it('builds task bridge state from explicit session metadata', () => {
    expect(normalizeTaskSessionKey(' ', 'agent:main:main')).toBe('agent:main:main');
    const bridge = buildTaskBridgeState(
      {
        currentSessionKey: 'agent:foo:main',
        loadedSessions: {
          'agent:foo:main': createSessionRecord({ sessionKey: 'agent:foo:main' }),
        },
      } as never,
      'agent:main:main',
    );
    expect(bridge).toEqual({
      sessionKey: 'agent:foo:main',
      owner: 'foo',
      canSendRecoveryPrompt: true,
    });

    const fallback = buildTaskBridgeState(
      {
        currentSessionKey: 'agent:bar:main',
        loadedSessions: {
          'agent:bar:main': {
            ...createSessionRecord({ sessionKey: 'agent:bar:main' }),
            meta: {
              ...createSessionRecord({ sessionKey: 'agent:bar:main' }).meta,
              agentId: null,
            },
          },
        },
      } as never,
      'agent:main:main',
    );
    expect(fallback.owner).toBe('bar');
  });
});


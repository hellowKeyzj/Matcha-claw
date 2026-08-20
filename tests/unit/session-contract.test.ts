import { describe, expect, it } from 'vitest';
import {
  decodeLegacySessionUpdateDelta,
  decodeSessionDelta,
  decodeSessionView,
  isSessionDelta,
  isSessionView,
} from '../../electron/main/runtime-host-delivery/transport/sessions/session-contract';
import {
  assistantItem,
  completeFact,
  incompleteFact,
  sessionDelta,
  sessionView,
  windowView,
} from './helpers/session-fixtures';

const sessionKey = 'agent:test:main';

const identity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw' as const,
    runtimeInstanceId: 'local' as const,
  },
  agentId: 'agent:test',
  sessionKey,
};

describe('strict SessionView and SessionDelta contract fixtures', () => {
  it('round-trips the complete SessionView fixture used by unchanged clients', () => {
    const view = sessionView(sessionKey, {
      identity,
      epoch: 2,
      seq: 4,
      cursor: 4,
      items: completeFact([assistantItem('item-1', 'done', { runId: 'run-1' })]),
      window: completeFact(windowView(1)),
    });

    expect(isSessionView(view)).toBe(true);
    expect(decodeSessionView(view)).toEqual(view);
  });

  it.each(['unavailable', 'unknown'] as const)('preserves typed %s SessionView facts', (status) => {
    const view = sessionView(sessionKey, {
      identity,
      items: status,
      tools: status,
      approvals: status,
      runtime: status,
      window: status,
      completeness: status,
    });

    expect(isSessionView(view)).toBe(true);
    expect(decodeSessionView(view)).toEqual(view);
  });

  it('preserves incomplete facts and the ordered SessionDelta fixture', () => {
    const view = sessionView(sessionKey, {
      identity,
      items: incompleteFact([assistantItem('item-1', 'partial')], ['bounded_history']),
      tools: 'unavailable',
      completeness: { incomplete: { missing: ['bounded_history', 'catalog'] } },
    });
    const delta = sessionDelta(sessionKey, {
      epoch: 2,
      seq: 5,
      cursor: 5,
      routeKey: 'renderer-route:fixture',
      runId: 'run-1',
      changes: [{ kind: 'runPhaseChanged', runId: 'run-1', phase: 'completed' }],
    });
    const messageDelta = sessionDelta(sessionKey, {
      epoch: 2,
      seq: 6,
      cursor: 6,
      routeKey: 'renderer-route:fixture',
      runId: 'run-1',
      changes: [{
        kind: 'messageDelta',
        itemId: 'item-2',
        runId: 'run-1',
        messageId: 'message-2',
        text: 'chunk',
        replace: false,
        status: 'streaming',
      }],
    });

    expect(isSessionView(view)).toBe(true);
    expect(decodeSessionView(view)).toEqual(view);
    expect(isSessionDelta(delta)).toBe(true);
    expect(decodeSessionDelta(delta)).toEqual(delta);
    expect(isSessionDelta(messageDelta)).toBe(true);
    expect(decodeSessionDelta(messageDelta)).toEqual(messageDelta);
    expect(decodeLegacySessionUpdateDelta({ kind: 'delta', delta })).toEqual(delta);
  });

  it('rejects legacy snapshot fields and malformed typed facts instead of projecting them', () => {
    const view = sessionView(sessionKey, { identity });
    const legacyView = { ...view, snapshot: view };
    const malformedIncomplete = {
      ...view,
      items: { incomplete: { facts: [], gaps: [] } },
    };
    const legacyDelta = {
      ...sessionDelta(sessionKey, {
        seq: 1,
        cursor: 1,
        changes: [{ kind: 'windowChanged', window: windowView(0) }],
      }),
      snapshot: view,
    };

    expect(isSessionView(legacyView)).toBe(false);
    expect(isSessionView(malformedIncomplete)).toBe(false);
    expect(isSessionDelta(legacyDelta)).toBe(false);
    expect(decodeSessionView(legacyView)).toBeNull();
    expect(decodeSessionDelta(legacyDelta)).toBeNull();
    expect(decodeLegacySessionUpdateDelta({
      sessionUpdate: 'session_info_update',
      sessionKey,
      runId: 'run-1',
      snapshot: legacyView,
    })).toBeNull();
  });
});

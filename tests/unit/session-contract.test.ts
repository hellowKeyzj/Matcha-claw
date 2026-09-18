import { describe, expect, it } from 'vitest';
import {
  decodeLegacySessionUpdateDelta,
  decodeSessionContentLoadResponse,
  decodeSessionDelta,
  decodeSessionView,
  isSessionDelta,
  isSessionView,
} from '../../electron/main/runtime-host-delivery/transport/sessions/session-contract';
import {
  assistantItem,
  completeFact,
  incompleteFact,
  largeTextContent,
  sessionDelta,
  sessionView,
  toolUseContent,
  runtimeView,
  toolView,
  userItem,
  windowView,
} from './helpers/session-fixtures';

const sessionKey = 'agent:test:main';

const identity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw' as const,
    runtimeInstanceId: 'local' as const,
  },
  agentId: 'test',
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
    const noticeDelta = sessionDelta(sessionKey, {
      epoch: 2,
      seq: 8,
      cursor: 8,
      routeKey: 'renderer-route:fixture',
      runId: 'run-1',
      changes: [{
        kind: 'runtimeNoticeUpdated',
        notice: {
          runId: 'run-1',
          kind: 'guardian_warning',
          command: 'cargo test',
          riskLevel: 'medium',
          rationale: null,
          message: null,
        },
      }],
    });

    expect(isSessionView(view)).toBe(true);
    expect(decodeSessionView(view)).toEqual(view);
    expect(isSessionDelta(noticeDelta)).toBe(true);
    expect(decodeSessionDelta(noticeDelta)).toEqual(noticeDelta);
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
    const toolDelta = sessionDelta(sessionKey, {
      epoch: 2,
      seq: 7,
      cursor: 7,
      routeKey: 'renderer-route:fixture',
      runId: 'run-1',
      changes: [{
        kind: 'toolUpdated',
        tool: toolView('tool-call-1', {
          runId: 'run-1',
          name: 'Read',
          phase: 'completed',
          input: { file_path: 'src/main.rs' },
          inputText: '{"file_path":"src/main.rs"}',
          summary: null,
          output: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }],
    });
    const viewWithTool = sessionView(sessionKey, {
      identity,
      items: completeFact([assistantItem('item-1', '', {
        runId: 'run-1',
        segments: [toolUseContent('Read', 'tool-call-1')],
      })]),
      tools: completeFact([toolView('tool-call-1', {
        runId: 'run-1',
        name: 'Read',
        input: { file_path: 'src/main.rs' },
        inputText: '{"file_path":"src/main.rs"}',
        output: [{ type: 'text', text: 'ok' }],
      })]),
    });

    expect(isSessionView(view)).toBe(true);
    expect(decodeSessionView(view)).toEqual(view);
    expect(isSessionDelta(delta)).toBe(true);
    expect(decodeSessionDelta(delta)).toEqual(delta);
    expect(isSessionDelta(messageDelta)).toBe(true);
    expect(decodeSessionDelta(messageDelta)).toEqual(messageDelta);
    expect(isSessionDelta(toolDelta)).toBe(true);
    expect(decodeSessionDelta(toolDelta)).toEqual(toolDelta);
    expect(isSessionView(viewWithTool)).toBe(true);
    expect(decodeSessionView(viewWithTool)).toEqual(viewWithTool);
    expect(decodeLegacySessionUpdateDelta({ kind: 'delta', delta })).toEqual(delta);
  });

  it('requires explicit runtime error detail kind', () => {
    const fallbackDelta = sessionDelta(sessionKey, {
      seq: 1,
      cursor: 1,
      changes: [{
        kind: 'runtimeChanged',
        runtime: runtimeView({
          phase: 'failed',
          errorDetail: {
            kind: 'fallback',
            failoverReason: 'rate_limit',
            providerRuntimeFailureKind: null,
            providerErrorType: 'overloaded',
            providerErrorMessagePreview: 'raw preview',
            httpStatus: 429,
          },
        }),
      }],
    });
    const errorDelta = sessionDelta(sessionKey, {
      seq: 2,
      cursor: 2,
      changes: [{
        kind: 'runtimeChanged',
        runtime: runtimeView({
          phase: 'failed',
          errorDetail: {
            kind: 'error',
            failoverReason: null,
            providerRuntimeFailureKind: null,
            providerErrorType: 'unknown_model',
            providerErrorMessagePreview: 'unknown model',
            httpStatus: null,
          },
        }),
      }],
    });
    const missingKindDelta = sessionDelta(sessionKey, {
      seq: 3,
      cursor: 3,
      changes: [{
        kind: 'runtimeChanged',
        runtime: runtimeView({
          phase: 'failed',
          errorDetail: {
            failoverReason: 'rate_limit',
            providerRuntimeFailureKind: null,
            providerErrorType: 'overloaded',
            providerErrorMessagePreview: 'raw preview',
            httpStatus: 429,
          } as never,
        }),
      }],
    });

    expect(decodeSessionDelta(fallbackDelta)).toEqual(fallbackDelta);
    expect(decodeSessionDelta(errorDelta)).toEqual(errorDelta);
    expect(decodeSessionDelta(missingKindDelta)).toBeNull();
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

  it('accepts largeText content previews and rejects malformed byte ranges', () => {
    const view = sessionView(sessionKey, {
      identity,
      items: completeFact([
        userItem('item-user-1', '', { content: [largeTextContent('preview', 'content-ref-1', 10, 7)] }),
      ]),
    });
    const malformed = sessionView(sessionKey, {
      identity,
      items: completeFact([
        userItem('item-user-1', '', { content: [largeTextContent('preview', 'content-ref-1', 6, 7)] }),
      ]),
    });

    expect(isSessionView(view)).toBe(true);
    expect(decodeSessionView(view)).toEqual(view);
    expect(isSessionView(malformed)).toBe(false);
    expect(decodeSessionView(malformed)).toBeNull();
  });

  it('decodes session content load responses without private fields', () => {
    const response = {
      contentRef: 'content-ref-1',
      offset: 7,
      text: 'chunk',
      nextOffset: 12,
      totalBytes: 12,
      complete: true,
    };

    expect(decodeSessionContentLoadResponse(response)).toEqual(response);
    expect(decodeSessionContentLoadResponse({ ...response, private: 'secret' })).toBeNull();
    expect(decodeSessionContentLoadResponse({ ...response, nextOffset: 13 })).toBeNull();
  });
});

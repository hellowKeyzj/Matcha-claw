import { describe, expect, it } from 'vitest';
import { buildRenderItemsFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { OpenClawV4Adapter } from '../../runtime-host/application/sessions/canonical/providers/openclaw-v4-adapter';
import type { CanonicalProvider, CanonicalSessionEvent } from '../../runtime-host/application/sessions/canonical/canonical-events';

function expectCanonicalBase(event: CanonicalSessionEvent, provider: CanonicalProvider, sessionId: string): void {
  expect(event.eventId).toEqual(expect.any(String));
  expect(event.eventId).not.toBe('');
  expect(event.provider).toBe(provider);
  expect(event.sessionId).toBe(sessionId);
  expect(event.source).toEqual(expect.stringMatching(/^(live|replay|imported|snapshot|control)$/));
  expect(event.origin).toEqual(expect.objectContaining({
    providerEventType: expect.any(String),
    providerIds: expect.any(Object),
  }));
}

describe('canonical provider contracts', () => {
  it('keeps OpenClaw V4 adapter output inside canonical message/tool contracts', () => {
    const adapter = new OpenClawV4Adapter();
    const events = [
      ...adapter.translate({
        type: 'chat.message',
        event: {
          state: 'delta',
          sessionKey: 'agent:main:main',
          runId: 'run-openclaw',
          seq: 1,
          agentId: 'main-agent',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '我来检查' }],
          },
        },
      }),
      ...adapter.translate({
        type: 'tool.lifecycle',
        event: {
          phase: 'start',
          sessionKey: 'agent:main:main',
          runId: 'run-openclaw',
          seq: 2,
          timestamp: 1_700_000_000_000,
          toolCallId: 'tool-openclaw-1',
          name: 'Read',
          args: { file_path: 'package.json' },
        },
      }),
    ];

    expect(events).toHaveLength(2);
    for (const event of events) {
      expectCanonicalBase(event, 'openclaw-v4', 'agent:main:main');
      expect(event.origin.providerIds).toMatchObject({
        sessionKey: 'agent:main:main',
        runId: 'run-openclaw',
      });
    }
    expect(events[0]).toMatchObject({
      type: 'message_snapshot',
      runId: 'run-openclaw',
      laneKey: 'main-agent',
      agentId: 'main-agent',
    });
    expect(events[1]).toMatchObject({
      type: 'tool_call',
      runId: 'run-openclaw',
      toolCallId: 'tool-openclaw-1',
    });
  });

  it('bounds OpenClaw V4 streaming chat buffers and keeps recent delta state', () => {
    const adapter = new OpenClawV4Adapter();

    for (let index = 0; index < 130; index += 1) {
      adapter.translate({
        type: 'chat.message',
        event: {
          state: 'delta',
          sessionKey: `agent:main:session-${index}`,
          runId: `run-${index}`,
          seq: 1,
          deltaText: `old-${index}`,
          message: {
            role: 'assistant',
            timestamp: index + 1,
          },
        },
      });
    }

    const prunedOldSession = adapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:session-0',
        runId: 'run-0',
        seq: 2,
        deltaText: '-next',
        message: {
          role: 'assistant',
          timestamp: 131,
        },
      },
    });
    const recentSession = adapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:session-129',
        runId: 'run-129',
        seq: 2,
        deltaText: '-next',
        message: {
          role: 'assistant',
          timestamp: 132,
        },
      },
    });

    expect(prunedOldSession[0]).toMatchObject({
      type: 'message_snapshot',
      text: '-next',
    });
    expect(recentSession[0]).toMatchObject({
      type: 'message_snapshot',
      text: 'old-129-next',
    });
  });

  it('prunes stale OpenClaw V4 streaming chat buffers by timestamp', () => {
    const adapter = new OpenClawV4Adapter();

    adapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:stale',
        runId: 'run-stale',
        seq: 1,
        deltaText: 'stale',
        message: {
          role: 'assistant',
          timestamp: 1,
        },
      },
    });
    adapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:fresh',
        runId: 'run-fresh',
        seq: 1,
        deltaText: 'fresh',
        message: {
          role: 'assistant',
          timestamp: 10 * 60 * 1000 + 2,
        },
      },
    });
    const staleSession = adapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:stale',
        runId: 'run-stale',
        seq: 2,
        deltaText: '-next',
        message: {
          role: 'assistant',
          timestamp: 10 * 60 * 1000 + 3,
        },
      },
    });
    const freshSession = adapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'agent:main:fresh',
        runId: 'run-fresh',
        seq: 2,
        deltaText: '-next',
        message: {
          role: 'assistant',
          timestamp: 10 * 60 * 1000 + 4,
        },
      },
    });

    expect(staleSession[0]).toMatchObject({
      type: 'message_snapshot',
      text: '-next',
    });
    expect(freshSession[0]).toMatchObject({
      type: 'message_snapshot',
      text: 'fresh-next',
    });
  });

  it('represents Claude Code session/project/toolUse identity without provider raw leaking into projection', () => {
    const state = createEmptyCanonicalSessionState('claude-code:project:e-code-matcha-claw');
    const events: CanonicalSessionEvent[] = [{
      eventId: 'claude-code:message:session-1:turn-1',
      type: 'message_snapshot',
      provider: 'claude-code',
      source: 'live',
      sessionId: 'claude-code:project:e-code-matcha-claw',
      runId: 'turn-1',
      turnId: 'turn-1',
      seq: 1,
      timestamp: 1_700_000_000_000,
      laneKey: 'main',
      origin: {
        providerEventType: 'assistant.message',
        providerIds: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'toolu-1',
          parentToolUseId: 'toolu-parent',
        },
        raw: { session_id: 'session-1', project: 'e-code-matcha-claw' },
      },
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading files' }],
      text: 'Reading files',
      status: 'streaming',
    }, {
      eventId: 'claude-code:tool:session-1:toolu-1:start',
      type: 'tool_call',
      provider: 'claude-code',
      source: 'live',
      sessionId: 'claude-code:project:e-code-matcha-claw',
      runId: 'turn-1',
      turnId: 'turn-1',
      seq: 2,
      timestamp: 1_700_000_000_001,
      laneKey: 'main',
      origin: {
        providerEventType: 'tool_use',
        providerIds: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'toolu-1',
          parentToolUseId: 'toolu-parent',
        },
        raw: { id: 'toolu-1', name: 'Read' },
      },
      toolCallId: 'toolu-1',
      name: 'Read',
      input: { file_path: 'package.json' },
    }];

    reduceCanonicalSessionEvents(state, events);
    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });

    for (const event of events) {
      expectCanonicalBase(event, 'claude-code', 'claude-code:project:e-code-matcha-claw');
    }
    expect(state.eventIds).toEqual(['claude-code:message:session-1:turn-1', 'claude-code:tool:session-1:toolu-1:start']);
    expect(items).toMatchObject([{
      kind: 'assistant-turn',
      runId: 'turn-1',
      turnKey: 'message:assistant:main:1',
      segments: [
        { kind: 'message', text: 'Reading files' },
        { kind: 'tool', tool: { toolCallId: 'toolu-1', name: 'Read' } },
      ],
    }]);
  });

  it('represents Codex session/turn identity through the same canonical reducer and projection', () => {
    const state = createEmptyCanonicalSessionState('codex:session:codex-session-1');
    const events: CanonicalSessionEvent[] = [{
      eventId: 'codex:message:codex-session-1:turn-7',
      type: 'message_snapshot',
      provider: 'codex',
      source: 'live',
      sessionId: 'codex:session:codex-session-1',
      runId: 'turn-7',
      turnId: 'turn-7',
      seq: 1,
      timestamp: 1_700_000_000_100,
      laneKey: 'main',
      origin: {
        providerEventType: 'turn.message',
        providerIds: {
          sessionId: 'codex-session-1',
          turnId: 'turn-7',
        },
        raw: { session_id: 'codex-session-1', turn_id: 'turn-7' },
      },
      role: 'assistant',
      content: 'Patch applied',
      text: 'Patch applied',
      status: 'final',
    }, {
      eventId: 'codex:usage:codex-session-1:turn-7',
      type: 'usage',
      provider: 'codex',
      source: 'live',
      sessionId: 'codex:session:codex-session-1',
      runId: 'turn-7',
      turnId: 'turn-7',
      seq: 2,
      timestamp: 1_700_000_000_101,
      origin: {
        providerEventType: 'turn.usage',
        providerIds: {
          sessionId: 'codex-session-1',
          turnId: 'turn-7',
        },
        raw: { input_tokens: 11, output_tokens: 13 },
      },
      payload: { inputTokens: 11, outputTokens: 13 },
    }];

    reduceCanonicalSessionEvents(state, events);
    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });

    for (const event of events) {
      expectCanonicalBase(event, 'codex', 'codex:session:codex-session-1');
    }
    expect(state.usage).toMatchObject([{ payload: { inputTokens: 11, outputTokens: 13 } }]);
    expect(items).toMatchObject([{
      kind: 'assistant-turn',
      runId: 'turn-7',
      turnKey: 'message:assistant:main:1',
      text: 'Patch applied',
    }]);
  });
});

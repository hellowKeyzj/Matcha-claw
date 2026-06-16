import { describe, expect, it } from 'vitest';
import { OpenClawV4ProtocolAdapter } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-v4-protocol-adapter';
import { createRuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-session-context';
import { OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_PROTOCOL_ID } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';

async function* transcriptLines(): AsyncGenerator<string> {
  yield JSON.stringify({
    id: 'message-1',
    timestamp: 1,
    message: {
      role: 'assistant',
      content: 'hello',
    },
  });
}

function runtimeContext(agentId = 'agent-1') {
  return createRuntimeSessionContext({
    identity: {
      endpoint: {
        kind: 'protocol-connector',
        protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
        connectorId: 'openclaw',
        endpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      },
      agentId,
      sessionKey: 'session-1',
    },
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    endpointSessionId: 'session-1',
  });
}

describe('OpenClawV4ProtocolAdapter', () => {
  it('replays async transcript lines as an async canonical event stream', async () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const replay = adapter.replayAdapter.replayTranscript('agent:main:main', transcriptLines(), {} as never);

    expect(Symbol.asyncIterator in Object(replay)).toBe(true);

    const events = [];
    for await (const event of replay) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'replay_boundary',
      'message_snapshot',
      'replay_boundary',
    ]);
  });

  it('keeps realtime chat deltas without provider messageId on the same fallback turn', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        deltaText: 'first',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [],
        },
      },
    }, context);
    const [secondDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        deltaText: 'second',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'first',
    });
    expect(secondDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'firstsecond',
    });
  });

  it('starts a new fallback chat turn after a terminal frame without provider messageId', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        deltaText: 'first',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [],
        },
      },
    }, context);
    const [final] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [],
        },
      },
    }, context);
    const [nextDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 3,
        deltaText: 'next',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_003,
          content: [],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'first',
    });
    expect(final).toMatchObject({
      type: 'message_snapshot',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'first',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_snapshot',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:1',
      text: 'next',
    });
  });

  it('starts a new fallback chat turn after live tool start without provider messageId', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        deltaText: 'Reading SKILL.md',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [],
        },
      },
    }, context);
    adapter.eventAdapter.translate({
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        timestamp: 1_700_000_000_002,
        toolCallId: 'tool-1',
        name: 'Read',
        args: { file_path: 'SKILL.md' },
      },
    }, context);
    const [lateFinal] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 3,
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_003,
          content: [],
        },
      },
    }, context);
    const [nextDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 4,
        deltaText: 'Reading workflow.md',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_004,
          content: [],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'Reading SKILL.md',
    });
    expect(lateFinal).toMatchObject({
      type: 'message_snapshot',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'Reading SKILL.md',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_snapshot',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:1',
      text: 'Reading workflow.md',
    });
  });

  it('does not duplicate prior text when a suffix streaming delta also carries the cumulative snapshot text', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        deltaText: 'Planning workflow tasks',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [{ type: 'text', text: 'Planning workflow tasks' }],
        },
      },
    }, context);
    const [secondDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        deltaText: '\nI need to respond by orchestrating the team workflow instead of performing any role work.',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [{
            type: 'text',
            text: 'Planning workflow tasks\nI need to respond by orchestrating the team workflow instead of performing any role work.',
          }],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      text: 'Planning workflow tasks',
    });
    expect(secondDelta).toMatchObject({
      type: 'message_snapshot',
      text: 'Planning workflow tasks\nI need to respond by orchestrating the team workflow instead of performing any role work.',
      content: [{
        type: 'text',
        text: 'Planning workflow tasks\nI need to respond by orchestrating the team workflow instead of performing any role work.',
      }],
    });
  });

  it('replaces the current live turn text when a streaming frame has replace=true', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-replace',
        seq: 1,
        deltaText: 'Hello world',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [{ type: 'text', text: 'Hello world' }],
        },
      },
    }, context);
    const [replacement] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-replace',
        seq: 2,
        deltaText: 'Hello',
        replace: true,
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [{ type: 'text', text: 'Hello' }],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      text: 'Hello world',
    });
    expect(replacement).toMatchObject({
      type: 'message_snapshot',
      text: 'Hello',
      content: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('uses the message content snapshot when a streaming frame has no deltaText', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [delta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-snapshot-only',
        seq: 1,
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [{ type: 'text', text: 'Full snapshot' }],
        },
      },
    }, context);

    expect(delta).toMatchObject({
      type: 'message_snapshot',
      text: 'Full snapshot',
      content: [{ type: 'text', text: 'Full snapshot' }],
    });
  });

  it('does not carry the previous turn text into the first post-tool streaming delta when V4 sends a cumulative snapshot', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-post-tool-cumulative',
        seq: 1,
        deltaText: 'Considering presentation',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [{ type: 'text', text: 'Considering presentation' }],
        },
      },
    }, context);
    adapter.eventAdapter.translate({
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'session-1',
        runId: 'run-post-tool-cumulative',
        seq: 2,
        timestamp: 1_700_000_000_002,
        toolCallId: 'tool-1',
        name: 'Read',
        args: { file_path: 'workflow.md' },
      },
    }, context);
    const [nextDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-post-tool-cumulative',
        seq: 3,
        deltaText: 'I need to answer concisely.',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_003,
          content: [{ type: 'text', text: 'Considering presentationI need to answer concisely.' }],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-cumulative:member:agent-1:0',
      text: 'Considering presentation',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-cumulative:member:agent-1:1',
      text: 'I need to answer concisely.',
      content: [{ type: 'text', text: 'I need to answer concisely.' }],
    });
  });

  it('starts a new fallback chat turn for the first post-tool final snapshot when V4 sends a cumulative snapshot', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-post-tool-final',
        seq: 1,
        deltaText: 'Considering presentation',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [{ type: 'text', text: 'Considering presentation' }],
        },
      },
    }, context);
    adapter.eventAdapter.translate({
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'session-1',
        runId: 'run-post-tool-final',
        seq: 2,
        timestamp: 1_700_000_000_002,
        toolCallId: 'tool-1',
        name: 'Read',
        args: { file_path: 'workflow.md' },
      },
    }, context);
    const [nextFinal] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'session-1',
        runId: 'run-post-tool-final',
        seq: 3,
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_003,
          content: [{ type: 'text', text: 'Considering presentationI need to answer concisely.' }],
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-final:member:agent-1:0',
      text: 'Considering presentation',
    });
    expect(nextFinal).toMatchObject({
      type: 'message_snapshot',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-final:member:agent-1:1',
      text: 'I need to answer concisely.',
      content: [{ type: 'text', text: 'I need to answer concisely.' }],
    });
  });

  it('preserves buffered assistant text when a terminal snapshot regresses', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-regressed-final',
        seq: 1,
        deltaText: '已写入。',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [{ type: 'text', text: '已写入。' }],
        },
      },
    }, context);
    const [final] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'final',
        sessionKey: 'session-1',
        runId: 'run-regressed-final',
        seq: 2,
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [{ type: 'text', text: '已' }],
        },
      },
    }, context);

    expect(final).toMatchObject({
      type: 'message_snapshot',
      status: 'final',
      text: '已写入。',
      content: [{ type: 'text', text: '已写入。' }],
    });
  });

  it('keeps non-text content blocks while aligning text blocks to the visible streaming text', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [delta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-structured-content',
        seq: 1,
        deltaText: 'Visible text',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_001,
          content: [
            { type: 'text', text: 'Stale cumulative text' },
            { type: 'image', source: { type: 'url', url: 'file://image.png' } },
          ],
        },
      },
    }, context);

    expect(delta).toMatchObject({
      type: 'message_snapshot',
      text: 'Visible text',
      content: [
        { type: 'text', text: 'Visible text' },
        { type: 'image', source: { type: 'url', url: 'file://image.png' } },
      ],
    });
  });

  it('keeps provider messageId as message metadata while live deltas stay on the same synthetic owner turn', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        messageId: 'provider-message-1',
        originMessageId: 'origin-message-1',
        clientId: 'client-message-1',
        timestamp: 1_700_000_000_001,
        deltaText: 'first',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
      },
    }, context);
    const [secondDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        deltaText: 'second',
        message: {
          role: 'assistant',
          messageId: 'provider-message-1',
          timestamp: 1_700_000_000_002,
        },
      },
    }, context);

    expect(firstDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      originMessageId: 'origin-message-1',
      clientId: 'client-message-1',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
      timestamp: 1_700_000_000_001,
      text: 'first',
    });
    expect(secondDelta).toMatchObject({
      type: 'message_snapshot',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
      text: 'firstsecond',
    });
  });

  it('preserves buffered assistant text for final frames and keeps late finals on the same live owner turn', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext('agent-1');
    const [streaming] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        state: 'delta',
        deltaText: 'The longer streamed answer.',
        message: {
          role: 'assistant',
          messageId: 'provider-message-1',
          timestamp: 1,
          content: [],
        },
      },
    }, context);
    const [toolStart] = adapter.eventAdapter.translate({
      type: 'tool.lifecycle',
      event: {
        phase: 'start',
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        timestamp: 2,
        toolCallId: 'tool-1',
        name: 'Read',
        args: { file_path: 'package.json' },
      },
    }, context);
    const [final] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 3,
        state: 'final',
        agentId: 'payload-agent',
        message: {
          role: 'assistant',
          messageId: 'provider-message-1',
          agentId: 'message-agent',
          timestamp: 3,
          content: [],
        },
      },
    }, context);

    expect(streaming).toMatchObject({
      type: 'message_snapshot',
      status: 'streaming',
      text: 'The longer streamed answer.',
      laneKey: 'member:agent-1',
      agentId: 'agent-1',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
    });
    expect(toolStart).toMatchObject({
      type: 'tool_call',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
    });
    expect(final).toMatchObject({
      type: 'message_snapshot',
      status: 'final',
      text: 'The longer streamed answer.',
      laneKey: 'member:agent-1',
      agentId: 'agent-1',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
    });
    expect(final?.origin.raw).toMatchObject({
      agentId: 'payload-agent',
      message: { agentId: 'message-agent' },
    });
  });

});

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
      'message_part',
      'replay_boundary',
    ]);
  });

  it('strips TeamRun role prompt envelopes while replaying OpenClaw transcript user messages', async () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const replay = adapter.replayAdapter.replayTranscript('team-role-session-run-1-leader', [
      JSON.stringify({
        id: 'user-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '# TeamRun node prompt',
                '',
                '## Delivery envelope',
                '',
                '- Role ID: leader',
                '',
                '## TeamRun WorkNode: Lead',
                '',
                '## Team chat message',
                '',
                'Use this user message as the latest input for this TeamRun node.',
                '',
                '只显示这句用户原文',
              ].join('\n'),
            },
          ],
        },
      }),
    ], runtimeContext('leader'));

    const events = [];
    for await (const event of replay) {
      events.push(event);
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        role: 'user',
        text: '只显示这句用户原文',
        content: [{ type: 'text', text: '只显示这句用户原文' }],
      }),
    ]));
    expect(JSON.stringify(events)).not.toContain('TeamRun node prompt');
    expect(JSON.stringify(events)).not.toContain('Delivery envelope');
  });

  it('strips TeamRun v2 Attempt user message envelopes while replaying OpenClaw transcript user messages', async () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const replay = adapter.replayAdapter.replayTranscript('team-role-session-run-1-leader', [
      JSON.stringify({
        id: 'user-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '# TeamRun node prompt',
                '',
                '## Delivery envelope',
                '',
                '- Role ID: leader',
                '',
                '## TeamRun WorkNode: WorkNode',
                '',
                '### Node context',
                '',
                '- runId: run-1',
                '',
                '### Attempt user message',
                '',
                'This user message started this entry WorkNode attempt. Treat it as the attempt input, not as generic chat history.',
                '',
                '使用team_graph_context 查看下graph状况',
                '',
                '### Node work',
                '',
                'This is the work instruction from the node config, workflow task, or node title. Do this work; do not treat it as tool documentation.',
                '',
                'WorkNode',
              ].join('\n'),
            },
          ],
        },
      }),
    ], runtimeContext('leader'));

    const events = [];
    for await (const event of replay) {
      events.push(event);
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        role: 'user',
        text: '使用team_graph_context 查看下graph状况',
        content: [{ type: 'text', text: '使用team_graph_context 查看下graph状况' }],
      }),
    ]));
    expect(JSON.stringify(events)).not.toContain('TeamRun node prompt');
    expect(JSON.stringify(events)).not.toContain('Node context');
    expect(JSON.stringify(events)).not.toContain('Node work');
  });

  it('strips TeamRun v2 Attempt user message envelopes from live session.message events', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const [event] = adapter.eventAdapter.translate({
      type: 'session.message',
      event: {
        sessionKey: 'team-role-session-run-1-leader',
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: [
              '# TeamRun node prompt',
              '',
              '## Delivery envelope',
              '',
              '- Role ID: leader',
              '',
              '## TeamRun WorkNode: WorkNode',
              '',
              '### Node context',
              '',
              '- runId: run-1',
              '',
              '### Attempt user message',
              '',
              'This user message started this entry WorkNode attempt. Treat it as the attempt input, not as generic chat history.',
              '',
              '使用team_graph_context 查看下graph状况',
              '',
              '### Node work',
              '',
              'This is the work instruction from the node config, workflow task, or node title. Do this work; do not treat it as tool documentation.',
              '',
              'WorkNode',
            ].join('\n'),
          }],
        },
      },
    }, runtimeContext('leader'));

    expect(event).toEqual(expect.objectContaining({
      type: 'message_part',
      role: 'user',
      text: '使用team_graph_context 查看下graph状况',
      content: [{ type: 'text', text: '使用team_graph_context 查看下graph状况' }],
    }));
  });

  it('strips TeamRun workspace context while replaying OpenClaw transcript user messages', async () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const replay = adapter.replayAdapter.replayTranscript('team-role-session-run-1-operator', [
      JSON.stringify({
        id: 'user-1',
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: [
              'hello operator',
              '',
              '### TeamRun workspace context',
              '',
              'This message is for the long-lived Team role workspace session. It is not a WorkNode attempt prompt and does not claim a nodeExecutionId.',
              '',
              '- runId: run-1',
              '- roleId: operator',
            ].join('\n'),
          }],
        },
      }),
    ], runtimeContext('operator'));

    const events = [];
    for await (const event of replay) {
      events.push(event);
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message_part',
        role: 'user',
        text: 'hello operator',
        content: [{ type: 'text', text: 'hello operator' }],
      }),
    ]));
    expect(JSON.stringify(events)).not.toContain('TeamRun workspace context');
  });

  it('strips TeamRun workspace context from live session.message events', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const [event] = adapter.eventAdapter.translate({
      type: 'session.message',
      event: {
        sessionKey: 'team-role-session-run-1-operator',
        message: {
          role: 'user',
          content: [{
            type: 'text',
            text: [
              'hello operator',
              '',
              '### TeamRun workspace context',
              '',
              'This message is for the long-lived Team role workspace session. It is not a WorkNode attempt prompt and does not claim a nodeExecutionId.',
              '',
              '- runId: run-1',
              '- roleId: operator',
            ].join('\n'),
          }],
        },
      },
    }, runtimeContext('operator'));

    expect(event).toEqual(expect.objectContaining({
      type: 'message_part',
      role: 'user',
      text: 'hello operator',
      content: [{ type: 'text', text: 'hello operator' }],
    }));
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
      type: 'message_part',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'first',
    });
    expect(secondDelta).toMatchObject({
      type: 'message_part',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'firstsecond',
    });
  });

  it('uses cumulative deltaText as the visible text without duplicating previous text', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-cumulative-delta',
        seq: 1,
        deltaText: 'Hello',
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
        runId: 'run-cumulative-delta',
        seq: 2,
        deltaText: 'Hello world',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [],
        },
      },
    }, context);

    expect(secondDelta).toMatchObject({
      type: 'message_part',
      text: 'Hello world',
    });
  });

  it('keeps appending true incremental deltaText', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-incremental-delta',
        seq: 1,
        deltaText: 'Hello',
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
        runId: 'run-incremental-delta',
        seq: 2,
        deltaText: ' world',
        message: {
          role: 'assistant',
          timestamp: 1_700_000_000_002,
          content: [],
        },
      },
    }, context);

    expect(secondDelta).toMatchObject({
      type: 'message_part',
      text: 'Hello world',
    });
  });

  it('replays session.tool on the historical member agent lane', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [toolEvent] = adapter.eventAdapter.translate({
      type: 'session.tool',
      event: {
        phase: 'result',
        sessionKey: 'session-1',
        runId: 'run-history',
        seq: 3,
        timestamp: 1_700_000_000_003,
        toolCallId: 'tool-1',
        name: 'Read',
        result: 'done',
        agentId: 'writer',
        laneKey: 'member:writer',
      },
    }, context);

    expect(toolEvent).toMatchObject({
      type: 'tool',
      phase: 'completed',
      source: 'replay',
      laneKey: 'member:writer',
      agentId: 'writer',
      ownerTurnKey: 'run:member:writer:run-history',
    });
  });

  it('maps V4 chat states to canonical message status', () => {
    const cases = [
      { state: 'delta', expectedStatus: 'streaming' },
      { state: 'final', expectedStatus: 'final' },
      { state: 'error', expectedStatus: 'error' },
      { state: 'aborted', expectedStatus: 'aborted' },
    ] as const;

    for (const { state, expectedStatus } of cases) {
      const adapter = new OpenClawV4ProtocolAdapter();
      const context = runtimeContext();
      const [event] = adapter.eventAdapter.translate({
        type: 'chat.message',
        event: {
          state,
          sessionKey: 'session-1',
          runId: `run-chat-${state}`,
          seq: 1,
          deltaText: state === 'delta' ? 'streaming text' : undefined,
          message: {
            role: 'assistant',
            timestamp: 1_700_000_000_001,
            content: [{ type: 'text', text: `${state} text` }],
          },
        },
      }, context);

      expect(event).toMatchObject({
        type: 'message_part',
        status: expectedStatus,
      });
    }
  });

  it('maps V4 tool lifecycle phases to canonical tool phases', () => {
    const cases = [
      { phase: 'start', expectedPhase: 'started', input: { args: { file_path: 'README.md' } } },
      { phase: 'update', expectedPhase: 'updated', input: { partialResult: 'partial' } },
      { phase: 'result', expectedPhase: 'completed', input: { result: 'done' } },
      { phase: 'result', expectedPhase: 'failed', input: { result: 'failed', isError: true } },
    ] as const;

    for (const { phase, expectedPhase, input } of cases) {
      const adapter = new OpenClawV4ProtocolAdapter();
      const context = runtimeContext();
      const [event] = adapter.eventAdapter.translate({
        type: 'tool.lifecycle',
        event: {
          phase,
          sessionKey: 'session-1',
          runId: `run-tool-${expectedPhase}`,
          seq: 1,
          timestamp: 1_700_000_000_001,
          toolCallId: `tool-${expectedPhase}`,
          name: 'Read',
          ...input,
        },
      }, context);

      expect(event).toMatchObject({
        type: 'tool',
        phase: expectedPhase,
      });
    }
  });

  it('maps V4 lifecycle phases to canonical run phases', () => {
    const cases = [
      { phase: 'started', expectedLifecyclePhase: 'started', expectedRunPhase: 'submitted' },
      { phase: 'completed', expectedLifecyclePhase: 'final', expectedRunPhase: 'done' },
      { phase: 'error', expectedLifecyclePhase: 'error', expectedRunPhase: 'error' },
      { phase: 'aborted', expectedLifecyclePhase: 'aborted', expectedRunPhase: 'aborted' },
    ] as const;

    for (const { phase, expectedLifecyclePhase, expectedRunPhase } of cases) {
      const adapter = new OpenClawV4ProtocolAdapter();
      const context = runtimeContext();
      const [event] = adapter.eventAdapter.translate({
        type: 'run.phase',
        phase,
        runId: `run-lifecycle-${phase}`,
      }, context);

      expect(event).toMatchObject({
        type: 'lifecycle',
        phase: expectedLifecyclePhase,
        runPhase: expectedRunPhase,
      });
    }
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
      type: 'message_part',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'first',
    });
    expect(final).toMatchObject({
      type: 'message_part',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'first',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_part',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:1',
      text: 'next',
    });
  });

  it('finalizes the live assistant turn when a terminal chat frame has no message', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext();

    const [firstDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-terminal-without-message',
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
        runId: 'run-terminal-without-message',
        seq: 2,
        timestamp: 1_700_000_000_002,
      },
    }, context);
    const [nextDelta] = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        state: 'delta',
        sessionKey: 'session-1',
        runId: 'run-terminal-without-message',
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
      type: 'message_part',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-terminal-without-message:member:agent-1:0',
      text: 'first',
    });
    expect(final).toMatchObject({
      type: 'message_part',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-terminal-without-message:member:agent-1:0',
      text: 'first',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_part',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-terminal-without-message:member:agent-1:1',
      text: 'next',
    });
  });

  it('keeps post-tool assistant text on the same owner turn without provider messageId', () => {
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
      type: 'message_part',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'Reading SKILL.md',
    });
    expect(lateFinal).toMatchObject({
      type: 'message_part',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      text: 'Reading SKILL.md',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_part',
      status: 'streaming',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0:1',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
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
      type: 'message_part',
      text: 'Planning workflow tasks',
    });
    expect(secondDelta).toMatchObject({
      type: 'message_part',
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
      type: 'message_part',
      text: 'Hello world',
    });
    expect(replacement).toMatchObject({
      type: 'message_part',
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
      type: 'message_part',
      text: 'Full snapshot',
      content: [{ type: 'text', text: 'Full snapshot' }],
    });
  });

  it('keeps post-tool streaming delta on the same owner turn while trimming cumulative snapshot text', () => {
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
      type: 'message_part',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-cumulative:member:agent-1:0',
      text: 'Considering presentation',
    });
    expect(nextDelta).toMatchObject({
      type: 'message_part',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-cumulative:member:agent-1:0:1',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-post-tool-cumulative:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-post-tool-cumulative:member:agent-1:0',
      text: 'I need to answer concisely.',
      content: [{ type: 'text', text: 'I need to answer concisely.' }],
    });
  });

  it('keeps the first post-tool final snapshot on the same owner turn while trimming cumulative text', () => {
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
      type: 'message_part',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-final:member:agent-1:0',
      text: 'Considering presentation',
    });
    expect(nextFinal).toMatchObject({
      type: 'message_part',
      status: 'final',
      messageId: 'openclaw-v4:chat:session-1:run-post-tool-final:member:agent-1:0:1',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-post-tool-final:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-post-tool-final:member:agent-1:0',
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
      type: 'message_part',
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
      type: 'message_part',
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
      type: 'message_part',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      originMessageId: 'origin-message-1',
      clientId: 'client-message-1',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
      timestamp: 1_700_000_000_001,
      text: 'first',
    });
    expect(secondDelta).toMatchObject({
      type: 'message_part',
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
      type: 'message_part',
      status: 'streaming',
      text: 'The longer streamed answer.',
      laneKey: 'member:agent-1',
      agentId: 'agent-1',
      messageId: 'openclaw-v4:chat:session-1:run-1:member:agent-1:0',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
    });
    expect(toolStart).toMatchObject({
      type: 'tool', phase: 'started',
      ownerTurnKey: 'openclaw-v4:turn:session-1:run-1:member:agent-1:0',
      ownerMessageKey: 'openclaw-v4:owner-message:session-1:run-1:member:agent-1:0',
    });
    expect(final).toMatchObject({
      type: 'message_part',
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

  it('uses the runtime session context when a lifecycle frame has no sessionKey', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext('agent-1');

    const [lifecycle] = adapter.eventAdapter.translate({
      type: 'run.phase',
      phase: 'completed',
      runId: 'run-1',
    }, context);

    expect(lifecycle).toMatchObject({
      eventId: 'openclaw-v4:lifecycle:session-1:run-1:final',
      type: 'lifecycle',
      sessionId: 'session-1',
      runId: 'run-1',
      laneKey: 'member:agent-1',
      agentId: 'agent-1',
      phase: 'final',
      runPhase: 'done',
      error: null,
    });
  });

});

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
    sessionKey: 'session-1',
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    endpointSessionId: 'session-1',
    address: {
      kind: 'protocol-connector',
      capabilityId: 'session.prompt',
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      connectorId: 'openclaw',
      endpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      agentId,
      sessionKey: 'session-1',
    },
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

  it('preserves buffered assistant text when V4 payload agent id changes across frames', () => {
    const adapter = new OpenClawV4ProtocolAdapter();
    const context = runtimeContext('agent-1');
    const streaming = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 1,
        state: 'delta',
        deltaText: 'The longer streamed answer.',
        message: {
          role: 'assistant',
          timestamp: 1,
          content: [],
        },
      },
    }, context);
    const final = adapter.eventAdapter.translate({
      type: 'chat.message',
      event: {
        sessionKey: 'session-1',
        runId: 'run-1',
        seq: 2,
        state: 'final',
        agentId: 'payload-agent',
        message: {
          role: 'assistant',
          agentId: 'message-agent',
          timestamp: 2,
          content: [],
        },
      },
    }, context);

    expect(streaming[0]).toMatchObject({
      type: 'message_snapshot',
      status: 'streaming',
      text: 'The longer streamed answer.',
      laneKey: 'member:agent-1',
      agentId: 'agent-1',
      messageId: 'openclaw-v4:chat:session-1:run-1:1',
    });
    expect(final[0]).toMatchObject({
      type: 'message_snapshot',
      status: 'final',
      text: 'The longer streamed answer.',
      laneKey: 'member:agent-1',
      agentId: 'agent-1',
      messageId: 'openclaw-v4:chat:session-1:run-1:1',
    });
    expect(final[0]?.origin.raw).toMatchObject({
      agentId: 'payload-agent',
      message: { agentId: 'message-agent' },
    });
  });
});

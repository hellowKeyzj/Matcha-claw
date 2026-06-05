import { describe, expect, it } from 'vitest';
import { AcpProtocolAdapter } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter';
import { createRuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-session-context';

describe('ACP protocol adapter', () => {
  it('translates ACP message notifications into endpoint-scoped canonical events', () => {
    const adapter = new AcpProtocolAdapter();
    const context = createRuntimeSessionContext({
      sessionKey: 'claude-code:session:1',
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpointSessionId: '1',
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'default',
        sessionKey: 'claude-code:session:1',
      },
    });

    const events = adapter.eventAdapter.translate({
      jsonrpc: '2.0',
      method: 'session/message',
      params: {
        runId: 'run-1',
        messageId: 'msg-1',
        role: 'assistant',
        text: 'hello',
        status: 'final',
      },
    }, context);

    expect(events).toMatchObject([{
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      type: 'message_snapshot',
      sessionId: 'claude-code:session:1',
      runId: 'run-1',
      messageId: 'msg-1',
      text: 'hello',
      status: 'final',
    }]);
  });

  it('keeps full ACP endpoint and agent identity in canonical event ids', () => {
    const adapter = new AcpProtocolAdapter();
    const baseAddress = {
      kind: 'protocol-connector' as const,
      capabilityId: 'session.prompt',
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
      sessionKey: 'claude-code:session:1',
    };
    const event = {
      jsonrpc: '2.0',
      method: 'session/message',
      params: {
        runId: 'run-1',
        messageId: 'msg-1',
        role: 'assistant',
        text: 'hello',
        status: 'final',
      },
    };

    const defaultAgentContext = createRuntimeSessionContext({
      sessionKey: 'claude-code:session:1',
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpointSessionId: '1',
      address: {
        ...baseAddress,
        agentId: 'default',
      },
    });
    const reviewerAgentContext = createRuntimeSessionContext({
      sessionKey: 'claude-code:session:1',
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpointSessionId: '1',
      address: {
        ...baseAddress,
        agentId: 'reviewer',
      },
    });

    const [defaultAgentEvent] = adapter.eventAdapter.translate(event, defaultAgentContext);
    const [reviewerAgentEvent] = adapter.eventAdapter.translate(event, reviewerAgentContext);

    expect(defaultAgentEvent?.eventId).not.toBe(reviewerAgentEvent?.eventId);
    expect(defaultAgentEvent?.eventId).toContain(':claude-code:default:');
    expect(reviewerAgentEvent?.eventId).toContain(':claude-code:reviewer:');
  });

  it('keeps full ACP endpoint and agent identity in fallback message ids', () => {
    const adapter = new AcpProtocolAdapter();

    expect(adapter.identityPolicy.buildMessageId({
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'hermes',
        agentId: 'researcher',
        sessionKey: 'hermes:session:1',
      },
      sessionKey: 'hermes:session:1',
      runId: 'run-1',
      laneKey: 'main',
      role: 'assistant',
      messageIndex: 0,
    })).toBe('session.prompt:protocol-connector:acp:acp:hermes:researcher:model-provider::hermes:session:1:run-1:main:assistant:0');
  });

  it('replays ACP transcript lines with endpoint and agent scoped ids', async () => {
    const adapter = new AcpProtocolAdapter();
    const context = createRuntimeSessionContext({
      sessionKey: 'claude-code:session:1',
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      endpointSessionId: '1',
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'reviewer',
        sessionKey: 'claude-code:session:1',
      },
    });

    const events: unknown[] = [];
    for await (const event of adapter.replayAdapter.replayTranscript('claude-code:session:1', [
      '{"jsonrpc":"2.0","method":"session/message","params":{"runId":"run-1","messageId":"msg-1","role":"assistant","text":"hello","status":"final"}}',
      'not-json',
    ], context)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      protocolId: 'acp',
      runtimeEndpointId: 'claude-code',
      sessionId: 'claude-code:session:1',
      messageId: 'msg-1',
    });
    expect((events[0] as { eventId: string }).eventId).toContain(':claude-code:reviewer:');
  });

  it('does not collide message ids for different agents on the same ACP endpoint', () => {
    const adapter = new AcpProtocolAdapter();
    const base = {
      sessionKey: 'claude-code:session:1',
      runId: 'run-1',
      laneKey: 'main',
      role: 'assistant',
      messageIndex: 0,
    };

    const firstAgentMessageId = adapter.identityPolicy.buildMessageId({
      ...base,
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'default',
        sessionKey: 'claude-code:session:1',
      },
    });
    const secondAgentMessageId = adapter.identityPolicy.buildMessageId({
      ...base,
      address: {
        kind: 'protocol-connector',
        capabilityId: 'session.prompt',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
        agentId: 'reviewer',
        sessionKey: 'claude-code:session:1',
      },
    });

    expect(firstAgentMessageId).not.toBe(secondAgentMessageId);
    expect(firstAgentMessageId).toContain(':claude-code:default:');
    expect(secondAgentMessageId).toContain(':claude-code:reviewer:');
  });
});

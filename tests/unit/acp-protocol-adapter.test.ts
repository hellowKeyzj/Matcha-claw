import { describe, expect, it } from 'vitest';
import { AcpProtocolAdapter } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter';
import { createRuntimeSessionContext } from '../../runtime-host/application/agent-runtime/contracts/runtime-session-context';
import { buildRuntimeEndpointKey, buildSessionIdentityKey, type SessionIdentity } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';

function acpContext(agentId = 'default') {
  return createRuntimeSessionContext({
    identity: {
      endpoint: {
        kind: 'protocol-connector',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'claude-code',
      },
      agentId,
      sessionKey: 'claude-code:session:1',
    },
    protocolId: 'acp',
    runtimeEndpointId: 'claude-code',
    endpointSessionId: '1',
  });
}

describe('ACP protocol adapter', () => {
  it('translates ACP message notifications into endpoint-scoped canonical events', () => {
    const adapter = new AcpProtocolAdapter();
    const context = acpContext();

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

  it('keeps explicit ACP message ids stable across agents', () => {
    const adapter = new AcpProtocolAdapter();
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

    const defaultContext = acpContext('default');
    const reviewerContext = acpContext('reviewer');
    const [defaultAgentEvent] = adapter.eventAdapter.translate(event, defaultContext);
    const [reviewerAgentEvent] = adapter.eventAdapter.translate(event, reviewerContext);

    expect(defaultAgentEvent?.eventId).toBe(reviewerAgentEvent?.eventId);
    expect(defaultAgentEvent?.eventId).toContain(`acp:${buildRuntimeEndpointKey(defaultContext.identity.endpoint)}:message:claude-code:session:1:run-1:msg-1`);
  });

  it('keeps full ACP endpoint and agent identity in fallback message ids', () => {
    const adapter = new AcpProtocolAdapter();

    const identity: SessionIdentity = {
      endpoint: {
        kind: 'protocol-connector',
        protocolId: 'acp',
        connectorId: 'acp',
        endpointId: 'hermes',
      },
      agentId: 'researcher',
      sessionKey: 'hermes:session:1',
    };

    expect(adapter.identityPolicy.buildMessageId({
      identity,
      runId: 'run-1',
      laneKey: 'main',
      role: 'assistant',
      messageIndex: 0,
    })).toBe(`${buildSessionIdentityKey(identity)}:run-1:main:assistant:0`);
  });

  it('replays ACP transcript lines with endpoint and agent scoped ids', async () => {
    const adapter = new AcpProtocolAdapter();
    const context = acpContext('reviewer');

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
    expect((events[0] as { eventId: string }).eventId).toContain(`acp:${buildRuntimeEndpointKey(context.identity.endpoint)}:message:claude-code:session:1:run-1:msg-1`);
  });

  it('does not collide message ids for different agents on the same ACP endpoint', () => {
    const adapter = new AcpProtocolAdapter();
    const base = {
      runId: 'run-1',
      laneKey: 'main',
      role: 'assistant',
      messageIndex: 0,
    };
    const endpoint = {
      kind: 'protocol-connector' as const,
      protocolId: 'acp',
      connectorId: 'acp',
      endpointId: 'claude-code',
    };

    const firstAgentMessageId = adapter.identityPolicy.buildMessageId({
      ...base,
      identity: {
        endpoint,
        agentId: 'default',
        sessionKey: 'claude-code:session:1',
      },
    });
    const secondAgentMessageId = adapter.identityPolicy.buildMessageId({
      ...base,
      identity: {
        endpoint,
        agentId: 'reviewer',
        sessionKey: 'claude-code:session:1',
      },
    });

    expect(firstAgentMessageId).not.toBe(secondAgentMessageId);
    expect(firstAgentMessageId).toContain(buildSessionIdentityKey({ endpoint, agentId: 'default', sessionKey: 'claude-code:session:1' }));
    expect(secondAgentMessageId).toContain(buildSessionIdentityKey({ endpoint, agentId: 'reviewer', sessionKey: 'claude-code:session:1' }));
  });
});

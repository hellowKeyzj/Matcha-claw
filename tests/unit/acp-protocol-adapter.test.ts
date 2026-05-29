import { describe, expect, it } from 'vitest';
import { AcpProtocolAdapter } from '../../runtime-host/application/sessions/runtime-providers/acp/acp-protocol-adapter';
import { createRuntimeSessionContext } from '../../runtime-host/application/sessions/runtime-providers/session-runtime-context';

describe('ACP protocol adapter', () => {
  it('translates ACP message notifications into provider-scoped canonical events', () => {
    const adapter = new AcpProtocolAdapter();
    const context = createRuntimeSessionContext({
      sessionKey: 'claude-code:session:1',
      protocolId: 'acp',
      runtimeProviderId: 'claude-code',
      providerSessionId: '1',
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
      runtimeProviderId: 'claude-code',
      type: 'message_snapshot',
      sessionId: 'claude-code:session:1',
      runId: 'run-1',
      messageId: 'msg-1',
      text: 'hello',
      status: 'final',
    }]);
  });

  it('keeps ACP profile identity in fallback message ids', () => {
    const adapter = new AcpProtocolAdapter();

    expect(adapter.identityPolicy.buildMessageId({
      runtimeProviderId: 'hermes',
      sessionKey: 'hermes:session:1',
      runId: 'run-1',
      laneKey: 'main',
      role: 'assistant',
      messageIndex: 0,
    })).toBe('hermes:hermes:session:1:run-1:main:assistant:0');
  });
});

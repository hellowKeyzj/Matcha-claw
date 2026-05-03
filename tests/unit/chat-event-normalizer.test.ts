import { describe, expect, it } from 'vitest';
import {
  buildConversationMessageSequenceKey,
  normalizeBufferedConversationMessageEvent,
  normalizeConversationIngressDomainEvent,
  normalizeGatewayConversationEvent,
  normalizeGatewayNotificationEvent,
} from '@/stores/chat/event-normalizer';

describe('chat event normalizer', () => {
  it('normalizes structured chat.message into chat.message domain event', () => {
    const normalized = normalizeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'completed',
        runId: ' run-1 ',
        sessionKey: ' agent:main:main ',
        sequenceId: 7,
        requestId: ' user-local-1 ',
        uniqueId: ' user-local-1 ',
        agentId: ' agent-main ',
        message: {
          role: 'assistant',
          id: ' assistant-message-1 ',
          message_id: ' gateway-message-1 ',
          origin_message_id: ' upstream-origin-1 ',
          content: 'hello',
        },
      },
    });

    expect(normalized).toEqual({
      kind: 'chat.message',
      source: 'chat.message',
      phase: 'final',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      event: {
        state: 'final',
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        sequenceId: 7,
        requestId: 'user-local-1',
        uniqueId: 'user-local-1',
        agentId: 'agent-main',
        message: {
          role: 'assistant',
          id: 'assistant-message-1',
          messageId: 'gateway-message-1',
          message_id: ' gateway-message-1 ',
          originMessageId: 'upstream-origin-1',
          origin_message_id: ' upstream-origin-1 ',
          requestId: 'user-local-1',
          uniqueId: 'user-local-1',
          agentId: 'agent-main',
          content: 'hello',
        },
      },
    });
  });

  it('normalizes run.phase completed into runtime lifecycle domain event', () => {
    const normalized = normalizeGatewayConversationEvent({
      type: 'run.phase',
      phase: 'completed',
      runId: ' run-2 ',
      sessionKey: ' agent:main:main ',
    });

    expect(normalized).toEqual({
      kind: 'chat.runtime.lifecycle',
      source: 'run.phase',
      phase: 'final',
      runId: 'run-2',
      sessionKey: 'agent:main:main',
      event: {
        state: 'final',
        runId: 'run-2',
        sessionKey: 'agent:main:main',
      },
    });
  });

  it('ignores run.phase started when run/session identifiers are missing', () => {
    const withoutRunId = normalizeGatewayConversationEvent({
      type: 'run.phase',
      phase: 'started',
      sessionKey: 'agent:main:main',
    });
    const withoutSessionKey = normalizeGatewayConversationEvent({
      type: 'run.phase',
      phase: 'started',
      runId: 'run-1',
    });
    expect(withoutRunId).toBeNull();
    expect(withoutSessionKey).toBeNull();
  });

  it('normalizes approval requested notification into chat domain event', () => {
    const normalized = normalizeGatewayNotificationEvent({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-1',
        request: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          toolName: 'shell.exec',
        },
      },
    });

    expect(normalized).toEqual({
      kind: 'chat.approval.requested',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      payload: {
        id: 'approval-1',
        request: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          toolName: 'shell.exec',
        },
        sessionKey: 'agent:main:main',
        runId: 'run-1',
        toolName: 'shell.exec',
      },
    });
  });

  it('returns null for non-chat notification methods', () => {
    const normalized = normalizeGatewayNotificationEvent({
      method: 'task_manager.updated',
      params: {
        task: {
          id: 'task-1',
        },
      },
    });
    expect(normalized).toBeNull();
  });

  it('re-normalizes chat domain ingress event into unified normalized envelope', () => {
    const normalized = normalizeConversationIngressDomainEvent({
      kind: 'chat.message',
      source: 'chat.message',
      phase: 'final',
      runId: ' run-3 ',
      sessionKey: ' agent:main:main ',
      event: {
        state: 'completed',
        runId: ' run-3 ',
        sessionKey: ' agent:main:main ',
        requestId: ' user-local-3 ',
        uniqueId: ' user-local-3 ',
        agentId: ' agent-main ',
        message: {
          role: 'assistant',
          id: ' assistant-message-3 ',
          message_id: ' gateway-message-3 ',
          origin_message_id: ' upstream-origin-3 ',
          content: 'hello again',
        },
      },
    });

    expect(normalized).toEqual({
      kind: 'chat.message',
      phase: 'final',
      runId: 'run-3',
      sessionKey: 'agent:main:main',
      event: {
        state: 'final',
        runId: 'run-3',
        sessionKey: 'agent:main:main',
        requestId: 'user-local-3',
        uniqueId: 'user-local-3',
        agentId: 'agent-main',
        message: {
          role: 'assistant',
          id: 'assistant-message-3',
          messageId: 'gateway-message-3',
          message_id: ' gateway-message-3 ',
          originMessageId: 'upstream-origin-3',
          origin_message_id: ' upstream-origin-3 ',
          requestId: 'user-local-3',
          uniqueId: 'user-local-3',
          agentId: 'agent-main',
          content: 'hello again',
        },
      },
      message: {
        role: 'assistant',
        id: 'assistant-message-3',
        messageId: 'gateway-message-3',
        message_id: ' gateway-message-3 ',
        originMessageId: 'upstream-origin-3',
        origin_message_id: ' upstream-origin-3 ',
        requestId: 'user-local-3',
        uniqueId: 'user-local-3',
        agentId: 'agent-main',
        content: 'hello again',
      },
    });
  });

  it('builds sequence key from clientId when uniqueId and requestId are absent', () => {
    const normalizedBuffered = normalizeBufferedConversationMessageEvent({
      state: 'delta',
      runId: 'run-4',
      sessionKey: 'agent:main:main',
      sequenceId: 3,
      message: {
        role: 'assistant',
        id: 'assistant-message-4',
        clientId: 'assistant-client-4',
        agentId: 'agent-main',
        content: 'hello client identity',
      },
    });

    expect(normalizedBuffered).not.toBeNull();
    expect(buildConversationMessageSequenceKey(
      normalizedBuffered!.event,
      normalizedBuffered!.message,
    )).toBe('agent:main:main|assistant|assistant-client-4|agent-main');
  });

  it('builds separate sequence keys for user echo and assistant stream even when they share the same request identity', () => {
    const userEvent = normalizeBufferedConversationMessageEvent({
      state: 'final',
      runId: 'run-6',
      sessionKey: 'agent:main:main',
      sequenceId: 1,
      requestId: 'user-local-6',
      message: {
        role: 'user',
        id: 'gateway-user-6',
        content: '[Tue 2026-04-14 20:11 GMT+8]你好',
      },
    });
    const assistantEvent = normalizeBufferedConversationMessageEvent({
      state: 'delta',
      runId: 'run-6',
      sessionKey: 'agent:main:main',
      sequenceId: 1,
      requestId: 'user-local-6',
      message: {
        role: 'assistant',
        id: 'assistant-stream-6',
        content: '你好，我在。',
      },
    });

    expect(userEvent).not.toBeNull();
    expect(assistantEvent).not.toBeNull();
    expect(buildConversationMessageSequenceKey(
      userEvent!.event,
      userEvent!.message,
    )).toBe('agent:main:main|user|user-local-6|');
    expect(buildConversationMessageSequenceKey(
      assistantEvent!.event,
      assistantEvent!.message,
    )).toBe('agent:main:main|assistant|user-local-6|');
  });

  it('does not lift streaming delta id into messageId when gateway did not provide authoritative messageId', () => {
    const normalized = normalizeBufferedConversationMessageEvent({
      state: 'delta',
      runId: 'run-5',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-stream-5',
        uniqueId: 'assistant-turn-5',
        requestId: 'user-local-5',
        content: 'partial',
      },
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.message).toEqual({
      role: 'assistant',
      id: 'assistant-stream-5',
      uniqueId: 'assistant-turn-5',
      requestId: 'user-local-5',
      content: 'partial',
    });
  });
});

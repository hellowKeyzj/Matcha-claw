import { describe, expect, it } from 'vitest';
import {
  normalizeGatewayConversationEvent,
  normalizeGatewayNotificationEvent,
} from '@/stores/chat/event-normalizer';

describe('chat event normalizer', () => {
  it('normalizes structured chat.message into chat.runtime domain event', () => {
    const normalized = normalizeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'completed',
        runId: ' run-1 ',
        sessionKey: ' agent:main:main ',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      },
    });

    expect(normalized).toEqual({
      kind: 'chat.runtime',
      source: 'chat.message',
      phase: 'final',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      event: {
        state: 'final',
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        message: {
          role: 'assistant',
          content: 'hello',
        },
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
});

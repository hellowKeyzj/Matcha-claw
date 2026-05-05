import { describe, expect, it } from 'vitest';
import { normalizeGatewayNotificationEvent } from '@/stores/chat/event-normalizer';

describe('chat event normalizer', () => {
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

  it('normalizes approval resolved notification into chat domain event', () => {
    const normalized = normalizeGatewayNotificationEvent({
      method: 'exec.approval.resolved',
      params: {
        id: 'approval-1',
        data: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
        },
      },
    });

    expect(normalized).toEqual({
      kind: 'chat.approval.resolved',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      payload: {
        id: 'approval-1',
        data: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
        },
        sessionKey: 'agent:main:main',
        runId: 'run-1',
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

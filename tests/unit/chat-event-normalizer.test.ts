import { describe, expect, it } from 'vitest';
import { normalizeGatewayNotificationEvent } from '@/stores/chat/event-normalizer';

describe('chat event normalizer', () => {
  it('normalizes approval requested notification into chat domain event', () => {
    const normalized = normalizeGatewayNotificationEvent({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-1',
        allowedDecisions: ['allow-once', 'deny'],
        request: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          command: 'Remove-Item demo.txt',
          host: 'gateway',
        },
      },
    });

    expect(normalized).toEqual({
      kind: 'chat.approval.requested',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      payload: {
        id: 'approval-1',
        command: 'Remove-Item demo.txt',
        allowedDecisions: ['allow-once', 'deny'],
        request: {
          sessionKey: 'agent:main:main',
          runId: 'run-1',
          command: 'Remove-Item demo.txt',
          host: 'gateway',
        },
        sessionKey: 'agent:main:main',
        runId: 'run-1',
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

  it('normalizes plugin approval events with nested request data', () => {
    const normalized = normalizeGatewayNotificationEvent({
      method: 'plugin.approval.requested',
      params: {
        data: {
          id: 'approval-plugin-1',
          request: {
            sessionKey: 'agent:plugin:main',
            runId: 'run-plugin-1',
            commandArgv: ['tool:example'],
            host: 'plugin-host',
            allowedDecisions: ['allow-once', 'deny'],
          },
        },
      },
    });

    expect(normalized).toMatchObject({
      kind: 'chat.approval.requested',
      runId: 'run-plugin-1',
      sessionKey: 'agent:plugin:main',
      payload: {
        data: {
          id: 'approval-plugin-1',
        },
        sessionKey: 'agent:plugin:main',
        runId: 'run-plugin-1',
        allowedDecisions: ['allow-once', 'deny'],
      },
    });
  });

  it('returns null for non-chat notification methods', () => {
    const normalized = normalizeGatewayNotificationEvent({
      method: 'TaskUpdate',
      params: {
        task: {
          id: 'task-1',
        },
      },
    });
    expect(normalized).toBeNull();
  });
});

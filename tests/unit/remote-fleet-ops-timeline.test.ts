import { describe, expect, it } from 'vitest';
import { buildRemoteFleetOpsTimeline } from '../../runtime-host/application/remote-fleet/remote-fleet-ops-timeline';
import type {
  RemoteFleetAuditEventRecord,
  RemoteFleetCommandRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-06T10:00:00.000Z';

describe('buildRemoteFleetOpsTimeline', () => {
  it('builds a correlated command and audit timeline in reverse chronological order', () => {
    const queuedCommand = commandRecord({
      id: 'cmd-queued',
      command: 'install-agent',
      state: { reason: 'queued', queuedAt: '2026-07-06T10:01:00.000Z' },
      createdAt: '2026-07-06T10:01:00.000Z',
      updatedAt: '2026-07-06T10:01:00.000Z',
    });
    const failedCommand = commandRecord({
      id: 'cmd-failed',
      command: 'start-runtime',
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      state: { reason: 'failed', completedAt: '2026-07-06T10:03:00.000Z', message: 'start failed with token=runtime-secret' },
      createdAt: '2026-07-06T10:00:00.000Z',
      updatedAt: '2026-07-06T10:03:00.000Z',
    });
    const queuedAudit = auditEventRecord({
      id: 'audit-queued',
      eventName: 'remoteFleet.command.queued',
      commandId: 'cmd-queued',
      occurredAt: '2026-07-06T10:01:01.000Z',
    });
    const failedAudit = auditEventRecord({
      id: 'audit-failed',
      eventName: 'remoteFleet.command.completed',
      commandId: 'cmd-failed',
      occurredAt: '2026-07-06T10:03:01.000Z',
      message: 'completed with Authorization: Bearer audit-secret',
    });

    const timeline = buildRemoteFleetOpsTimeline({
      commands: [queuedCommand, failedCommand],
      auditEvents: [queuedAudit, failedAudit],
    });

    expect(timeline.commandCount).toBe(2);
    expect(timeline.auditEventCount).toBe(2);
    expect(timeline.omittedEntryCount).toBe(0);
    expect(timeline.entries.map((entry) => entry.id)).toEqual([
      'audit:audit-failed',
      'command:cmd-failed:state',
      'audit:audit-queued',
      'command:cmd-queued:state',
    ]);
    expect(timeline.entries[0]).toMatchObject({
      entryType: 'audit-event',
      severity: 'error',
      targetIds: { nodeId: 'node-1', agentId: 'agent-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1' },
      auditEvent: {
        id: 'audit-failed',
        commandId: 'cmd-failed',
        message: 'completed with Authorization: [REDACTED]',
      },
      command: {
        id: 'cmd-failed',
        commandName: 'start-runtime',
        status: 'failed',
        active: false,
        terminal: true,
        message: 'start failed with token=[REDACTED]',
      },
    });
    expect(timeline.entries[1]).toMatchObject({
      entryType: 'command-state',
      severity: 'error',
      occurredAt: '2026-07-06T10:03:00.000Z',
      relatedAuditEventIds: ['audit-failed'],
    });
    expect(timeline.entries[2]).toMatchObject({
      entryType: 'audit-event',
      severity: 'info',
      auditEvent: { id: 'audit-queued', commandId: 'cmd-queued' },
    });
    expect(timeline.entries[3]).toMatchObject({
      entryType: 'command-state',
      severity: 'info',
      command: { id: 'cmd-queued', active: true, terminal: false },
      relatedAuditEventIds: ['audit-queued'],
    });
    expect(JSON.stringify(timeline)).not.toContain('runtime-secret');
    expect(JSON.stringify(timeline)).not.toContain('audit-secret');
  });

  it('keeps standalone audit events visible and inherits target ids from the referenced command when needed', () => {
    const command = commandRecord({
      id: 'cmd-1',
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      state: { reason: 'succeeded', completedAt: '2026-07-06T10:02:00.000Z' },
      updatedAt: '2026-07-06T10:02:00.000Z',
    });
    const commandAudit = auditEventRecord({
      id: 'audit-command',
      eventName: 'remoteFleet.runtime.started',
      commandId: 'cmd-1',
      nodeId: undefined,
      agentId: undefined,
      runtimeId: undefined,
      endpointId: undefined,
      occurredAt: '2026-07-06T10:02:01.000Z',
    });
    const standaloneAudit = auditEventRecord({
      id: 'audit-retired',
      eventName: 'remoteFleet.endpoint.retired',
      commandId: undefined,
      endpointId: 'endpoint-2',
      occurredAt: '2026-07-06T10:04:00.000Z',
    });

    const timeline = buildRemoteFleetOpsTimeline({
      commands: [command],
      auditEvents: [commandAudit, standaloneAudit],
    });

    expect(timeline.entries[0]).toMatchObject({
      id: 'audit:audit-retired',
      severity: 'warning',
      auditEvent: { id: 'audit-retired', endpointId: 'endpoint-2' },
    });
    expect(timeline.entries[1]).toMatchObject({
      id: 'audit:audit-command',
      severity: 'info',
      targetIds: { nodeId: 'node-1', agentId: 'agent-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1' },
      auditEvent: { commandId: 'cmd-1', nodeId: 'node-1', agentId: 'agent-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1' },
      command: { id: 'cmd-1', status: 'succeeded' },
    });
  });

  it('limits entries without changing source counts', () => {
    const timeline = buildRemoteFleetOpsTimeline({
      commands: [
        commandRecord({ id: 'cmd-1', state: { reason: 'queued', queuedAt: '2026-07-06T10:01:00.000Z' } }),
        commandRecord({ id: 'cmd-2', state: { reason: 'running', startedAt: '2026-07-06T10:02:00.000Z' } }),
      ],
      auditEvents: [auditEventRecord({ id: 'audit-1', occurredAt: '2026-07-06T10:03:00.000Z' })],
      maxEntries: 2,
    });

    expect(timeline.entries.map((entry) => entry.id)).toEqual(['audit:audit-1', 'command:cmd-2:state']);
    expect(timeline.commandCount).toBe(2);
    expect(timeline.auditEventCount).toBe(1);
    expect(timeline.omittedEntryCount).toBe(1);
  });
});

function commandRecord(overrides: Partial<RemoteFleetCommandRecord> = {}): RemoteFleetCommandRecord {
  return {
    id: 'cmd-1',
    idempotencyKey: 'idem:cmd-1',
    nodeId: 'node-1',
    agentId: 'agent-1',
    command: 'probe-node',
    state: { reason: 'queued', queuedAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function auditEventRecord(overrides: Partial<RemoteFleetAuditEventRecord> = {}): RemoteFleetAuditEventRecord {
  return {
    id: 'audit-1',
    eventName: 'remoteFleet.command.queued',
    occurredAt: now,
    nodeId: 'node-1',
    agentId: 'agent-1',
    commandId: 'cmd-1',
    ...overrides,
  };
}

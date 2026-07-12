import { describe, expect, it } from 'vitest';
import {
  createRemoteFleetAuditEventRecord,
  redactRemoteFleetMetadata,
  summarizeRemoteFleetAuditEvent,
} from '../../runtime-host/application/remote-fleet/remote-fleet-audit';

describe('Remote Fleet audit helpers', () => {
  it('redacts sensitive keys and string values deeply while preserving correlation identifiers', () => {
    const redacted = redactRemoteFleetMetadata({
      correlationId: 'corr-1',
      requestId: 'req-1',
      token: 'token-value',
      Authorization: 'Bearer secret',
      detail: 'Authorization: Bearer detail-token',
      output: 'sk-liveSecret_123',
      nested: {
        apiKey: 'api-key-value',
        private_key: 'private-key-value',
        password: 'password-value',
        correlationIds: ['corr-2'],
        lines: ['fleet token mrf_0123456789abcdef'],
      },
      attempts: [
        { secret: 'secret-value', endpointId: 'endpoint-1' },
        { headers: { authorization: 'Bearer nested', requestId: 'req-2' } },
      ],
    });

    expect(redacted).toEqual({
      correlationId: 'corr-1',
      requestId: 'req-1',
      token: '[redacted]',
      Authorization: '[redacted]',
      detail: 'Authorization: [REDACTED]',
      output: '[REDACTED]',
      nested: {
        apiKey: '[redacted]',
        private_key: '[redacted]',
        password: '[redacted]',
        correlationIds: ['corr-2'],
        lines: ['fleet token [REDACTED]'],
      },
      attempts: [
        { secret: '[redacted]', endpointId: 'endpoint-1' },
        { headers: { authorization: '[redacted]', requestId: 'req-2' } },
      ],
    });

    expect(JSON.stringify(redacted)).not.toContain('detail-token');
    expect(JSON.stringify(redacted)).not.toContain('sk-liveSecret_123');
    expect(JSON.stringify(redacted)).not.toContain('mrf_0123456789abcdef');
  });

  it('creates audit event records without persisting plaintext secrets in message or metadata', () => {
    const event = createRemoteFleetAuditEventRecord({
      id: 'audit-1',
      eventName: 'remoteFleet.runtime.started',
      occurredAt: '2026-07-06T00:00:00.000Z',
      actorId: 'actor-1',
      nodeId: 'node-1',
      agentId: 'agent-1',
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      commandId: 'command-1',
      message: 'Runtime started with Authorization: Bearer message-token and fleet token mrf_0123456789abcdef.',
      metadata: {
        correlationId: 'corr-1',
        token: 'token-value',
        Authorization: 'Bearer metadata-token',
        nested: {
          password: 'password-value',
          apiKey: 'sk-liveSecret_123',
        },
      },
    });

    expect(event).toEqual({
      id: 'audit-1',
      eventName: 'remoteFleet.runtime.started',
      occurredAt: '2026-07-06T00:00:00.000Z',
      actorId: 'actor-1',
      nodeId: 'node-1',
      agentId: 'agent-1',
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      commandId: 'command-1',
      message: 'Runtime started with Authorization: [REDACTED] and fleet token [REDACTED].',
      metadata: {
        correlationId: 'corr-1',
        token: '[redacted]',
        Authorization: '[redacted]',
        nested: {
          password: '[redacted]',
          apiKey: '[redacted]',
        },
      },
    });

    expect(JSON.stringify(event)).not.toContain('message-token');
    expect(JSON.stringify(event)).not.toContain('metadata-token');
    expect(JSON.stringify(event)).not.toContain('mrf_0123456789abcdef');
    expect(JSON.stringify(event)).not.toContain('token-value');
    expect(JSON.stringify(event)).not.toContain('password-value');
    expect(JSON.stringify(event)).not.toContain('sk-liveSecret_123');
  });

  it('summarizes audit records without metadata or actor fields', () => {
    const event = createRemoteFleetAuditEventRecord({
      id: 'audit-2',
      eventName: 'remoteFleet.endpoint.capabilitiesSynced',
      occurredAt: '2026-07-06T00:00:01.000Z',
      actorId: 'actor-2',
      nodeId: 'node-2',
      runtimeId: 'runtime-2',
      endpointId: 'endpoint-2',
      commandId: 'command-2',
      metadata: { apiKey: 'api-key-value' },
    });

    expect(summarizeRemoteFleetAuditEvent(event)).toEqual({
      id: 'audit-2',
      eventName: 'remoteFleet.endpoint.capabilitiesSynced',
      occurredAt: '2026-07-06T00:00:01.000Z',
      nodeId: 'node-2',
      runtimeId: 'runtime-2',
      endpointId: 'endpoint-2',
      commandId: 'command-2',
    });
  });
});

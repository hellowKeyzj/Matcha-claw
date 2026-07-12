import { describe, expect, it } from 'vitest';
import {
  normalizeRuntimeAgentClientRequest,
  normalizeRuntimeAgentClientTarget,
  validateRuntimeAgentSnapshotProjection,
} from '../../runtime-host/application/remote-fleet/remote-fleet-agent-client';

const validRequestBase = {
  requestId: 'request-1',
  agentId: 'agent-1',
  sentAt: '2026-07-06T00:00:00.000Z',
};

describe('remote fleet runtime agent client seam', () => {
  it('normalizes credential inputs into redacted target snapshots', () => {
    const result = normalizeRuntimeAgentClientTarget({
      endpointUrl: 'https://runtime-agent.example.test/rpc',
      credential: {
        kind: 'bearer-token',
        token: 'plain-runtime-agent-token',
        credentialId: 'runtime-agent-credential-1',
      },
      timeoutMs: 5000,
    });

    expect(result).toEqual({
      resultType: 'valid',
      value: {
        endpointUrl: 'https://runtime-agent.example.test/rpc',
        credential: {
          credentialType: 'provided',
          credentialId: 'runtime-agent-credential-1',
        },
        timeoutMs: 5000,
      },
    });
    expect(JSON.stringify(result)).not.toContain('plain-runtime-agent-token');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('rejects snapshot DTOs that expose plaintext credential fields', () => {
    const result = validateRuntimeAgentSnapshotProjection({
      agentId: 'agent-1',
      nested: {
        authorization: 'Bearer secret-runtime-agent-token',
      },
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      reason: 'unsafe-snapshot',
      field: 'snapshot.nested.authorization',
    });
  });

  it('validates and normalizes heartbeat requests', () => {
    const result = normalizeRuntimeAgentClientRequest({
      ...validRequestBase,
      type: 'runtime-agent.heartbeat',
      observedAt: '2026-07-06T00:00:01.000Z',
      status: 'running',
      runtimeIds: [' runtime-1 '],
    });

    expect(result).toEqual({
      resultType: 'valid',
      value: {
        ...validRequestBase,
        type: 'runtime-agent.heartbeat',
        observedAt: '2026-07-06T00:00:01.000Z',
        status: 'running',
        runtimeIds: ['runtime-1'],
      },
    });
  });

  it('rejects unsupported request types with a discriminated validation reason', () => {
    const result = normalizeRuntimeAgentClientRequest({
      ...validRequestBase,
      type: 'runtime-agent.unknown',
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      reason: 'invalid-request-type',
      field: 'type',
    });
  });

  it('validates command result shape by result reason', () => {
    const result = normalizeRuntimeAgentClientRequest({
      ...validRequestBase,
      type: 'runtime-agent.command.result',
      commandId: 'command-1',
      idempotencyKey: 'command-1:result-1',
      result: {
        reason: 'timed-out',
        completedAt: '2026-07-06T00:00:02.000Z',
      },
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      reason: 'missing-required-field',
      field: 'timeoutMs',
    });
  });
});

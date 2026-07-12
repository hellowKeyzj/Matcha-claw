import { describe, expect, it } from 'vitest';
import { normalizeRuntimeAgentIngressOperation } from '../../runtime-host/application/remote-fleet/remote-fleet-agent-ingress';

const requestBase = {
  requestId: 'request-1',
  agentId: 'agent-from-runtime-agent',
  sentAt: '2026-07-06T00:00:00.000Z',
};

const runtimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: 'runtime-1',
  },
};

describe('Remote Fleet runtime agent ingress', () => {
  it('accepts heartbeat, command progress, and command result requests unchanged after validation', () => {
    const heartbeatRequest = {
      ...requestBase,
      type: 'runtime-agent.heartbeat',
      observedAt: '2026-07-06T00:00:05.000Z',
      status: 'running',
      runtimeIds: ['runtime-1'],
      message: 'Runtime is active',
    };
    const progressRequest = {
      ...requestBase,
      type: 'runtime-agent.command.progress',
      commandId: 'command-1',
      idempotencyKey: 'idem-command-1',
      progress: {
        state: 'running',
        phase: 'installing',
        message: 'Installing runtime',
        percent: 25,
      },
    };
    const resultRequest = {
      ...requestBase,
      type: 'runtime-agent.command.result',
      commandId: 'command-1',
      idempotencyKey: 'idem-command-1',
      result: {
        reason: 'failed',
        completedAt: '2026-07-06T00:01:00.000Z',
        message: 'Start command failed',
      },
    };

    expect(normalizeRuntimeAgentIngressOperation(heartbeatRequest)).toEqual({
      resultType: 'valid',
      request: heartbeatRequest,
    });
    expect(normalizeRuntimeAgentIngressOperation(progressRequest)).toEqual({
      resultType: 'valid',
      request: progressRequest,
    });
    expect(normalizeRuntimeAgentIngressOperation(resultRequest)).toEqual({
      resultType: 'valid',
      request: resultRequest,
    });
  });

  it('rejects Remote Fleet-owned control operations as unsupported ingress', () => {
    const operations = [
      {
        ...requestBase,
        type: 'runtime-agent.command.accept',
        commandId: 'command-1',
        commandName: 'start-runtime',
        issuedAt: '2026-07-06T00:00:01.000Z',
      },
      {
        ...requestBase,
        type: 'runtime-agent.capabilities.sync',
        endpointId: 'runtime-1:endpoint',
        scope: runtimeScope,
        descriptors: [],
        observedAt: '2026-07-06T00:03:00.000Z',
      },
      {
        ...requestBase,
        type: 'runtime-agent.runtime.start',
        runtimeId: 'runtime-1',
        runtimeKind: 'openclaw',
      },
      {
        ...requestBase,
        type: 'runtime-agent.runtime.stop',
        runtimeId: 'runtime-1',
      },
    ];

    for (const operation of operations) {
      expect(normalizeRuntimeAgentIngressOperation(operation)).toMatchObject({
        resultType: 'invalid',
        reason: 'unsupported-operation',
        field: 'type',
      });
    }
  });

  it.each([
    ['output', { status: 'not-retained' }],
    ['stdout', 'terminal output is not retained'],
    ['stderr', 'terminal error output is not retained'],
  ])('rejects command results that include $0', (field, value) => {
    const result = normalizeRuntimeAgentIngressOperation({
      ...requestBase,
      type: 'runtime-agent.command.result',
      commandId: 'command-1',
      idempotencyKey: 'idem-command-1',
      result: {
        reason: 'succeeded',
        completedAt: '2026-07-06T00:02:00.000Z',
        [field]: value,
      },
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      reason: 'invalid-command-result',
      field: `result.${field}`,
    });
  });

  it('returns schema validation failures before ingress operation handling', () => {
    const result = normalizeRuntimeAgentIngressOperation({
      ...requestBase,
      type: 'runtime-agent.command.progress',
      commandId: 'command-1',
      idempotencyKey: 'idem-command-1',
      progress: { state: 'almost-running' },
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      reason: 'invalid-progress',
      field: 'progress.state',
    });
  });
});

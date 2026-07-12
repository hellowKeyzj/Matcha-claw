import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
} from '../../runtime-host/application/remote-fleet/remote-fleet-credential-host-rpc';
import {
  REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
} from '../../runtime-host/application/remote-fleet/remote-fleet-secret-host-rpc';
import {
  dispatchRemoteFleetHostRequest,
  type RemoteFleetCredentialWriterPort,
  type RemoteFleetRuntimeAgentDispatcherPort,
  type RemoteFleetSecretResolverPort,
  type RemoteFleetTerminalHostPort,
} from '../../runtime-host/application/remote-fleet/remote-fleet-worker-client';
import {
  REMOTE_FLEET_WORKER_FAILURE_MESSAGE,
  errorFromRemoteFleetWorker,
  serializeRemoteFleetWorkerError,
} from '../../runtime-host/application/remote-fleet/remote-fleet-worker-contracts';
import type { RemoteFleetCommandDispatchEnvelope } from '../../runtime-host/application/remote-fleet/remote-fleet-command-dispatch';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapDispatcherPort,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap';

function secretResolveRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
    requestId: 'secret-rpc-1',
    input: {
      secretRef: 'remote-fleet://node-1/api-key',
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
      commandExecutionId: 'command-1',
      workerId: 'worker-1',
    },
    ...overrides,
  };
}

function secretWriteRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD,
    requestId: 'secret-write-rpc-1',
    input: {
      operationId: 'credential-write-1',
      credentialId: 'node-1',
      credentialName: 'sshPassword',
      plaintextValue: 'ssh-secret-password',
      nowIso: '2026-07-08T00:00:00.000Z',
    },
    ...overrides,
  };
}

function secretWriteStatusRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD,
    requestId: 'secret-write-status-rpc-1',
    input: {
      operationId: 'credential-write-1',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
    },
    ...overrides,
  };
}

function dispatchEnvelope(): RemoteFleetCommandDispatchEnvelope {
  return {
    envelopeVersion: 'remote-fleet-command-dispatch/v1',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    agentId: 'agent-1',
    nodeId: 'node-1',
    commandName: 'probe-node',
    request: {
      commandId: 'cmd-1',
      kind: 'probe-node',
      node: {
        id: 'node-1',
        displayName: 'Node 1',
        targetKind: 'container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: '2026-07-06T10:00:00.000Z',
        updatedAt: '2026-07-06T10:00:00.000Z',
      },
      publicConfig: {},
      payload: { payloadType: 'runtime-agent-probe-node', nodeId: 'node-1', agentId: 'agent-1', target: { targetKind: 'container', labels: [] } },
    },
  };
}

function bootstrapEnvelope(): RemoteFleetBootstrapCommandEnvelope {
  const node = {
    id: 'node-1',
    displayName: 'Node 1',
    targetKind: 'container',
    labels: [],
    enabled: true,
    publicConfig: {},
    secretRefs: {},
    health: { reason: 'unknown' },
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedAt: '2026-07-06T10:00:00.000Z',
  } as const;
  const agent = {
    id: 'agent-1',
    nodeId: 'node-1',
    displayName: 'Agent 1',
    enrollment: { status: 'pending' },
    capabilities: [],
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedAt: '2026-07-06T10:00:00.000Z',
  } as const;

  return {
    envelopeVersion: 'remote-fleet-bootstrap-command/v1',
    commandId: 'bootstrap-cmd-1',
    idempotencyKey: 'bootstrap-idem-1',
    commandName: 'probe-node',
    providerKind: 'docker',
    nodeId: 'node-1',
    agentId: 'agent-1',
    node,
    agent,
  };
}

describe('remote fleet worker client host request dispatch', () => {
  it('dispatches terminal issue/close host requests through DTO-only terminalHost seam', async () => {
    const issueConnectionTicket = vi.fn<RemoteFleetTerminalHostPort['issueConnectionTicket']>(async () => ({
      type: 'host.remoteFleetTerminal.issueTicket.result',
      requestId: 'manager-owned',
      resultType: 'issued',
      terminalConnection: {
        sessionId: 'terminal-session-1',
        ticket: 'ticket-value',
        websocketPath: '/api/remote-fleet/terminal/stream?sessionId=terminal-session-1&ticket=ticket-value',
        expiresAt: '2026-07-08T00:00:30.000Z',
      },
    }));
    const closeSession = vi.fn<RemoteFleetTerminalHostPort['closeSession']>(async () => ({
      type: 'host.remoteFleetTerminal.closeSession.result',
      requestId: 'manager-owned',
      resultType: 'closed',
    }));
    const session = {
      id: 'terminal-session-1',
      nodeId: 'node-1',
      targetKind: 'ssh-host',
      status: 'opening',
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    } as const;

    const node = {
      id: 'node-1',
      displayName: 'Node 1',
      targetKind: 'ssh-host',
      labels: [],
      enabled: true,
      publicConfig: {},
      secretRefs: {},
      health: { reason: 'unknown' },
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    } as const;

    await expect(dispatchRemoteFleetHostRequest({
      type: 'host.remoteFleetTerminal.issueTicket',
      requestId: 'terminal-rpc-1',
      input: { reason: 'open', session, node, nowIso: '2026-07-08T00:00:00.000Z' },
    }, { terminalHost: { issueConnectionTicket, closeSession } })).resolves.toEqual({
      type: 'host.remoteFleetTerminal.issueTicket.result',
      requestId: 'terminal-rpc-1',
      resultType: 'issued',
      terminalConnection: {
        sessionId: 'terminal-session-1',
        ticket: 'ticket-value',
        websocketPath: '/api/remote-fleet/terminal/stream?sessionId=terminal-session-1&ticket=ticket-value',
        expiresAt: '2026-07-08T00:00:30.000Z',
      },
    });
    await expect(dispatchRemoteFleetHostRequest({
      type: 'host.remoteFleetTerminal.closeSession',
      requestId: 'terminal-rpc-2',
      input: { session, nowIso: '2026-07-08T00:00:01.000Z', reason: 'user closed' },
    }, { terminalHost: { issueConnectionTicket, closeSession } })).resolves.toEqual({
      type: 'host.remoteFleetTerminal.closeSession.result',
      requestId: 'terminal-rpc-2',
      resultType: 'closed',
    });
    expect(issueConnectionTicket).toHaveBeenCalledWith({ reason: 'open', session, node, nowIso: '2026-07-08T00:00:00.000Z' });
    expect(closeSession).toHaveBeenCalledWith({ session, nowIso: '2026-07-08T00:00:01.000Z', reason: 'user closed' });
  });

  it('dispatches host.runtimeAgent.dispatchCommand to the injected dispatcher', async () => {
    const envelope = dispatchEnvelope();
    const dispatchCommand = vi.fn<RemoteFleetRuntimeAgentDispatcherPort['dispatchCommand']>(async () => ({
      resultType: 'accepted',
      accepted: true,
    }));

    await expect(
      dispatchRemoteFleetHostRequest({
        type: 'host.runtimeAgent.dispatchCommand',
        requestId: 'dispatch-rpc-1',
        envelope,
      }, { runtimeAgentDispatcher: { dispatchCommand } }),
    ).resolves.toEqual({ resultType: 'accepted', accepted: true });
    expect(dispatchCommand).toHaveBeenCalledWith(envelope);
  });

  it('returns unavailable for host.runtimeAgent.dispatchCommand without a dispatcher', async () => {
    await expect(
      dispatchRemoteFleetHostRequest({
        type: 'host.runtimeAgent.dispatchCommand',
        requestId: 'dispatch-rpc-1',
        envelope: dispatchEnvelope(),
      }, {}),
    ).resolves.toEqual({ resultType: 'unavailable', accepted: false });
  });

  it('dispatches host.remoteFleetBootstrap.dispatchCommand to the injected dispatcher', async () => {
    const envelope = bootstrapEnvelope();
    const dispatchCommand = vi.fn<RemoteFleetBootstrapDispatcherPort['dispatchCommand']>(async () => ({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      message: 'Bootstrapped',
    }));

    await expect(
      dispatchRemoteFleetHostRequest({
        type: 'host.remoteFleetBootstrap.dispatchCommand',
        requestId: 'bootstrap-rpc-1',
        envelope,
      }, { bootstrapDispatcher: { dispatchCommand } }),
    ).resolves.toEqual({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      message: 'Bootstrapped',
    });
    expect(dispatchCommand).toHaveBeenCalledWith(envelope);
  });

  it('returns failed unavailable for host.remoteFleetBootstrap.dispatchCommand without a dispatcher', async () => {
    await expect(
      dispatchRemoteFleetHostRequest({
        type: 'host.remoteFleetBootstrap.dispatchCommand',
        requestId: 'bootstrap-rpc-1',
        envelope: bootstrapEnvelope(),
      }, {}),
    ).resolves.toEqual({
      resultType: 'failed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      reason: 'unavailable',
      message: 'Remote Fleet bootstrap dispatcher is unavailable.',
    });
  });

  it('normalizes malformed bootstrap dispatcher results without leaking plaintext', async () => {
    const envelope = bootstrapEnvelope();
    const dispatchCommand = vi.fn<RemoteFleetBootstrapDispatcherPort['dispatchCommand']>(async () => ({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      plaintextSecretValue: 'sk-live-secret',
    } as never));

    const result = await dispatchRemoteFleetHostRequest({
      type: 'host.remoteFleetBootstrap.dispatchCommand',
      requestId: 'bootstrap-rpc-1',
      envelope,
    }, { bootstrapDispatcher: { dispatchCommand } });

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
    });
    expect(JSON.stringify(result)).not.toContain('sk-live-secret');
  });

  it('preserves structured bootstrap managedResources without retaining extra provider fields', async () => {
    const envelope = bootstrapEnvelope();
    const dispatchCommand = vi.fn<RemoteFleetBootstrapDispatcherPort['dispatchCommand']>(async () => ({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      remoteResourceId: 'container-legacy-1',
      managedResources: [
        {
          providerKind: 'docker',
          resourceKind: 'docker-container',
          remoteResourceId: 'container-1',
          remoteRefs: [
            {
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-1',
              name: 'matcha-runtime-agent',
            },
          ],
          ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
          cleanupPolicy: { mode: 'delete-on-environment-delete' },
          displayName: 'Runtime Agent Container',
          labels: ['runtime-agent'],
          providerRawStatus: 'created',
        },
      ],
    } as never));

    const result = await dispatchRemoteFleetHostRequest({
      type: 'host.remoteFleetBootstrap.dispatchCommand',
      requestId: 'bootstrap-rpc-1',
      envelope,
    }, { bootstrapDispatcher: { dispatchCommand } });

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      remoteResourceId: 'container-legacy-1',
      managedResources: [
        {
          providerKind: 'docker',
          resourceKind: 'docker-container',
          remoteResourceId: 'container-1',
          remoteRefs: [
            {
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-1',
              name: 'matcha-runtime-agent',
            },
          ],
          ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
          cleanupPolicy: { mode: 'delete-on-environment-delete' },
          displayName: 'Runtime Agent Container',
          labels: ['runtime-agent'],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('providerRawStatus');
  });

  it('rejects bootstrap managedResources containing plaintext secret fields', async () => {
    const envelope = bootstrapEnvelope();
    const dispatchCommand = vi.fn<RemoteFleetBootstrapDispatcherPort['dispatchCommand']>(async () => ({
      resultType: 'completed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      managedResources: [
        {
          providerKind: 'docker',
          resourceKind: 'docker-container',
          remoteResourceId: 'container-1',
          remoteRefs: [
            {
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-1',
            },
          ],
          ownership: { reason: 'unverified', message: 'created' },
          cleanupPolicy: { mode: 'delete-on-environment-delete' },
          displayName: 'Runtime Agent Container',
          token: 'sk-live-secret',
        },
      ],
    } as never));

    const result = await dispatchRemoteFleetHostRequest({
      type: 'host.remoteFleetBootstrap.dispatchCommand',
      requestId: 'bootstrap-rpc-1',
      envelope,
    }, { bootstrapDispatcher: { dispatchCommand } });

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'bootstrap-cmd-1',
      providerKind: 'docker',
      reason: 'unavailable',
      message: 'Remote Fleet bootstrap dispatcher returned an invalid result.',
    });
    expect(JSON.stringify(result)).not.toContain('sk-live-secret');
  });

  it('dispatches host.secret.write to the injected credential writer without projecting plaintext', async () => {
    const writeCredential = vi.fn<RemoteFleetCredentialWriterPort['writeCredential']>(async () => ({
      resultType: 'written',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
      writtenAt: '2026-07-08T00:00:00.000Z',
    }));

    const result = await dispatchRemoteFleetHostRequest(secretWriteRequest(), { credentialWriter: { writeCredential } });

    expect(result).toEqual({
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-write-rpc-1',
      resultType: 'written',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
      writtenAt: '2026-07-08T00:00:00.000Z',
    });
    expect(writeCredential).toHaveBeenCalledWith({
      operationId: 'credential-write-1',
      credentialId: 'node-1',
      credentialName: 'sshPassword',
      plaintextValue: 'ssh-secret-password',
      nowIso: '2026-07-08T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('ssh-secret-password');
  });

  it('returns unavailable when host.secret.write has no credential writer', async () => {
    await expect(dispatchRemoteFleetHostRequest(secretWriteRequest(), {})).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-write-rpc-1',
      resultType: 'unavailable',
    });
  });

  it('rejects invalid host.secret.write DTOs before calling the writer', async () => {
    const writeCredential = vi.fn<RemoteFleetCredentialWriterPort['writeCredential']>(async () => ({
      resultType: 'unavailable',
    }));

    const result = await dispatchRemoteFleetHostRequest(secretWriteRequest({
      input: {
        operationId: 'credential-write-1',
        credentialId: 'node-1',
        credentialName: 'sshPassword',
        plaintextValue: '',
        nowIso: '2026-07-08T00:00:00.000Z',
      },
    }), { credentialWriter: { writeCredential } });

    expect(result).toEqual({
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-write-rpc-1',
      resultType: 'invalidRequest',
      message: 'Remote Fleet credential value is required.',
    });
    expect(writeCredential).not.toHaveBeenCalled();
  });

  it('normalizes malformed host.secret.write results without leaking plaintext', async () => {
    const writeCredential = vi.fn<RemoteFleetCredentialWriterPort['writeCredential']>(async () => ({
      resultType: 'written',
      credentialName: 'sshPassword',
      plaintextSecretValue: 'ssh-secret-password',
    } as never));

    const result = await dispatchRemoteFleetHostRequest(secretWriteRequest(), { credentialWriter: { writeCredential } });

    expect(result).toEqual({
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-write-rpc-1',
      resultType: 'invalidRequest',
      message: 'Remote Fleet credential writer returned an invalid result.',
    });
    expect(JSON.stringify(result)).not.toContain('ssh-secret-password');
  });

  it('validates and dispatches host.secret.write.status without projecting private credential material', async () => {
    const lookupWriteReceipt = vi.fn<NonNullable<RemoteFleetCredentialWriterPort['lookupWriteReceipt']>>(async () => ({
      resultType: 'completed',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
      writtenAt: '2026-07-08T00:00:00.000Z',
    }));

    const result = await dispatchRemoteFleetHostRequest(
      secretWriteStatusRequest(),
      { credentialWriter: { writeCredential: vi.fn(), lookupWriteReceipt } },
    );

    expect(result).toEqual({
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-write-status-rpc-1',
      resultType: 'completed',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
      writtenAt: '2026-07-08T00:00:00.000Z',
    });
    expect(lookupWriteReceipt).toHaveBeenCalledWith({
      operationId: 'credential-write-1',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
    });

    const invalidResult = await dispatchRemoteFleetHostRequest(secretWriteStatusRequest({
      input: {
        operationId: 'credential-write-1',
        credentialName: 'sshPassword',
        credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-1/sshPassword' },
        plaintextValue: 'must-not-cross-the-status-boundary',
      },
    }), { credentialWriter: { writeCredential: vi.fn(), lookupWriteReceipt } });

    expect(invalidResult).toEqual({
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-write-status-rpc-1',
      resultType: 'invalidRequest',
      message: 'Unknown host.secret.write.status input field "plaintextValue".',
    });
    expect(lookupWriteReceipt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(invalidResult)).not.toContain('must-not-cross-the-status-boundary');
  });

  it('dispatches host.secret.resolve to the injected resolver', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'resolved',
      secretRef: 'remote-fleet://node-1/api-key',
      plaintextSecretValue: 'sk-live-secret',
    }));

    await expect(
      dispatchRemoteFleetHostRequest(secretResolveRequest(), { secretResolver: { resolveSecret } }),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'resolved',
      secretRef: 'remote-fleet://node-1/api-key',
      plaintextSecretValue: 'sk-live-secret',
    });
    expect(resolveSecret).toHaveBeenCalledWith({
      secretRef: 'remote-fleet://node-1/api-key',
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
      commandExecutionId: 'command-1',
      workerId: 'worker-1',
    });
  });

  it('returns unavailable when no secret resolver is wired for a safe Remote Fleet namespace', async () => {
    await expect(
      dispatchRemoteFleetHostRequest(secretResolveRequest(), {}),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'unavailable',
    });
  });

  it('denies unsafe secret namespaces before calling the resolver', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'resolved',
      secretRef: 'provider://anthropic/default',
      plaintextSecretValue: 'sk-live-secret',
    }));

    await expect(
      dispatchRemoteFleetHostRequest(
        secretResolveRequest({
          input: {
            secretRef: 'provider://anthropic/default',
            purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
            commandExecutionId: 'command-1',
          },
        }),
        { secretResolver: { resolveSecret } },
      ),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'accessDenied',
      secretRef: 'provider://anthropic/default',
    });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('denies legacy secret refs without a namespace before calling the resolver', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'resolved',
      secretRef: 'remote-fleet/node-1/api-key',
      plaintextSecretValue: 'sk-live-secret',
    }));

    await expect(
      dispatchRemoteFleetHostRequest(
        secretResolveRequest({
          input: {
            secretRef: 'remote-fleet/node-1/api-key',
            purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
            commandExecutionId: 'command-1',
          },
        }),
        { secretResolver: { resolveSecret } },
      ),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'accessDenied',
      secretRef: 'remote-fleet/node-1/api-key',
    });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('normalizes unknown resolver result types to unavailable without leaking plaintext', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'rotated',
      secretRef: 'remote-fleet://node-1/api-key',
      plaintextSecretValue: 'sk-live-secret',
    } as never));

    const result = await dispatchRemoteFleetHostRequest(secretResolveRequest(), { secretResolver: { resolveSecret } });

    expect(result).toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('sk-live-secret');
  });

  it('normalizes malformed resolved resolver outputs to invalidRequest', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'resolved',
      secretRef: 'remote-fleet://node-1/api-key',
    } as never));

    await expect(
      dispatchRemoteFleetHostRequest(secretResolveRequest(), { secretResolver: { resolveSecret } }),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'invalidRequest',
      validationReason: 'unknownField',
    });
  });

  it('normalizes resolver outputs with invalid secretRef fields to invalidRequest', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'accessDenied',
      secretRef: 123,
    } as never));

    await expect(
      dispatchRemoteFleetHostRequest(secretResolveRequest(), { secretResolver: { resolveSecret } }),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'invalidRequest',
      validationReason: 'unknownField',
    });
  });

  it('normalizes non-object resolver outputs to invalidRequest', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => undefined as never);

    await expect(
      dispatchRemoteFleetHostRequest(secretResolveRequest(), { secretResolver: { resolveSecret } }),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'invalidRequest',
      validationReason: 'unknownField',
    });
  });

  it('rejects invalid host.secret.resolve DTOs before calling the resolver', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'unavailable',
    }));

    await expect(
      dispatchRemoteFleetHostRequest(
        secretResolveRequest({
          input: {
            secretRef: 'remote-fleet://node-1/api-key',
            purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
            commandExecutionId: 'command-1',
            plaintextSecretValue: 'sk-live-secret',
          },
        }),
        { secretResolver: { resolveSecret } },
      ),
    ).resolves.toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'invalidRequest',
      validationReason: 'plaintextFieldNotAllowed',
    });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('throws a clear resolver error without echoing plaintext secret values', async () => {
    const resolveSecret = vi.fn<RemoteFleetSecretResolverPort['resolveSecret']>(async () => {
      throw new Error('backend leaked sk-live-secret');
    });

    await expect(
      dispatchRemoteFleetHostRequest(secretResolveRequest(), { secretResolver: { resolveSecret } }),
    ).rejects.toThrow('RemoteFleet secret resolver failed while resolving a secret reference.');
  });

  it('serializes worker failures as an opaque stable DTO and only rebuilds that failure', () => {
    const sensitiveError = new Error(
      'https://provider.example.test:8443 failed ERR_SSL_PROTOCOL_ERROR Authorization: Bearer worker-token',
    );
    sensitiveError.name = 'ProviderTlsError';
    sensitiveError.stack = 'ProviderTlsError: Bearer worker-token at https://provider.example.test:8443';

    const serialized = serializeRemoteFleetWorkerError(sensitiveError);
    const receivedWithLegacyErrorFields = {
      ...serialized,
      name: 'ProviderTlsError',
      stack: sensitiveError.stack,
    };
    const reconstructed = errorFromRemoteFleetWorker(receivedWithLegacyErrorFields);
    const serializedJson = JSON.stringify(serialized);

    expect(serialized).toEqual({ message: REMOTE_FLEET_WORKER_FAILURE_MESSAGE });
    expect(serializedJson).not.toContain('provider.example.test');
    expect(serializedJson).not.toContain('ERR_SSL');
    expect(serializedJson).not.toContain('Bearer');
    expect(serializedJson).not.toContain('worker-token');
    expect(serialized).not.toHaveProperty('stack');
    expect(reconstructed).toMatchObject({
      name: 'Error',
      message: REMOTE_FLEET_WORKER_FAILURE_MESSAGE,
    });
    expect(reconstructed.stack ?? '').not.toContain('provider.example.test');
    expect(reconstructed.stack ?? '').not.toContain('ERR_SSL');
    expect(reconstructed.stack ?? '').not.toContain('Bearer');
    expect(reconstructed.stack ?? '').not.toContain('worker-token');
  });
});

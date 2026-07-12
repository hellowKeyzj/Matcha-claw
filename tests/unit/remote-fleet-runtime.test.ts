import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteFleetRoutes } from '../../runtime-host/api/routes/remote-fleet-routes';
import {
  REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
  RemoteFleetRuntime,
  type RemoteFleetMetricsSnapshot,
} from '../../runtime-host/application/remote-fleet';
import { REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-contracts';
import {
  REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION,
  isRemoteFleetBootstrapCommandResult,
  type RemoteFleetBootstrapCommandEnvelope,
  type RemoteFleetBootstrapCommandResult,
  type RemoteFleetConnectionProbeEnvelope,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap';
import { FileRemoteFleetStateStore } from '../../runtime-host/application/remote-fleet/infrastructure/remote-fleet-file-state-store';
import { NodeRemoteFleetRuntimeIdentity } from '../../runtime-host/application/remote-fleet/infrastructure/remote-fleet-node-identity';
import { SystemRemoteFleetRuntimeClock } from '../../runtime-host/application/remote-fleet/infrastructure/remote-fleet-system-clock';
import type {
  RemoteFleetAuditEventRecord,
  RemoteFleetAuditEventSummary,
  RemoteFleetCommandRecord,
  RemoteFleetCommandSummary,
  RemoteFleetConnectionRecord,
  RemoteFleetLeaseRecord,
  RemoteFleetNodeRecord,
  RemoteFleetSnapshot,
  RemoteFleetTerminalSessionRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetManagedResourceRecord,
  RuntimeAgentRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import {
  emptyRemoteFleetPersistedState,
  type RemoteFleetPersistedState,
  type RemoteFleetStateStore,
} from '../../runtime-host/application/remote-fleet/remote-fleet-store';
import type { RemoteFleetHostRequestWithoutId } from '../../runtime-host/application/remote-fleet/remote-fleet-worker-contracts';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const tempDirs: string[] = [];
const runtimeAgentBootstrapEnrollmentTokens = new WeakMap<RemoteFleetRuntime, Map<string, string>>();
const runtimeAgentIngressCredentials = new WeakMap<RemoteFleetRuntime, Map<string, string>>();
const BOOTSTRAP_ENROLLMENT_SECRET_TOKEN = 'mrf_test_bootstrap_enrollment_secret_1234567890';

type RemoteFleetBootstrapHostRequestWithoutId = {
  readonly type: 'host.remoteFleetBootstrap.dispatchCommand';
  readonly envelope: RemoteFleetBootstrapCommandEnvelope;
};

type RemoteFleetConnectionProbeHostRequestWithoutId = {
  readonly type: 'host.remoteFleetConnectionProbe.dispatch';
  readonly envelope: RemoteFleetConnectionProbeEnvelope;
};

type RemoteFleetTestHostRequestWithoutId = RemoteFleetHostRequestWithoutId
  | RemoteFleetBootstrapHostRequestWithoutId
  | RemoteFleetConnectionProbeHostRequestWithoutId;

type RemoteFleetRuntimeWithConnectionProbe = RemoteFleetRuntime & {
  invoke(operationId: 'probeConnection', params: { readonly connectionId: string }): Promise<{
    readonly status: number;
    readonly data: unknown;
  }>;
};

async function createRuntimeDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matchaclaw-remote-fleet-'));
  tempDirs.push(root);
  return root;
}

async function readPersistedStateText(runtimeDataRootDir: string): Promise<string> {
  return readFile(join(runtimeDataRootDir, 'remote-fleet', 'state.json'), 'utf8');
}

async function readPersistedState(runtimeDataRootDir: string): Promise<{
  readonly connections?: readonly RemoteFleetConnectionRecord[];
  readonly environments?: readonly RemoteFleetEnvironmentRecord[];
  readonly managedResources?: readonly RemoteFleetManagedResourceRecord[];
  readonly nodes?: readonly RemoteFleetNodeRecord[];
  readonly agents?: readonly RuntimeAgentRecord[];
  readonly commands?: readonly RemoteFleetCommandRecord[];
  readonly leases?: readonly RemoteFleetLeaseRecord[];
  readonly sessions?: readonly RemoteFleetTerminalSessionRecord[];
  readonly auditEvents?: readonly RemoteFleetAuditEventRecord[];
}> {
  return JSON.parse(await readPersistedStateText(runtimeDataRootDir)) as {
    readonly connections?: readonly RemoteFleetConnectionRecord[];
    readonly environments?: readonly RemoteFleetEnvironmentRecord[];
    readonly managedResources?: readonly RemoteFleetManagedResourceRecord[];
    readonly nodes?: readonly RemoteFleetNodeRecord[];
    readonly agents?: readonly RuntimeAgentRecord[];
    readonly commands?: readonly RemoteFleetCommandRecord[];
    readonly leases?: readonly RemoteFleetLeaseRecord[];
    readonly sessions?: readonly RemoteFleetTerminalSessionRecord[];
    readonly auditEvents?: readonly RemoteFleetAuditEventRecord[];
  };
}

async function readPersistedCommandRecord(runtimeDataRootDir: string, commandId: string): Promise<RemoteFleetCommandRecord> {
  const state = JSON.parse(await readPersistedStateText(runtimeDataRootDir)) as {
    readonly commands?: readonly RemoteFleetCommandRecord[];
  };
  const command = state.commands?.find((command) => command.id === commandId);
  if (!command) {
    throw new Error(`Persisted Remote Fleet command not found: ${commandId}`);
  }
  return command;
}

async function readPersistedConnectionRecord(runtimeDataRootDir: string, connectionId: string): Promise<RemoteFleetConnectionRecord> {
  const state = JSON.parse(await readPersistedStateText(runtimeDataRootDir)) as {
    readonly connections?: readonly RemoteFleetConnectionRecord[];
  };
  const connection = state.connections?.find((connection) => connection.id === connectionId);
  if (!connection) {
    throw new Error(`Persisted Remote Fleet connection not found: ${connectionId}`);
  }
  return connection;
}

async function invokeSnapshot(runtime: RemoteFleetRuntime): Promise<RemoteFleetSnapshot> {
  const response = await runtime.invoke('snapshot', {});
  expect(response.status).toBe(200);
  return response.data as RemoteFleetSnapshot;
}

async function invokeMetrics(runtime: RemoteFleetRuntime): Promise<RemoteFleetMetricsSnapshot> {
  const response = await runtime.invoke('metrics', {});
  expect(response.status).toBe(200);
  return response.data as RemoteFleetMetricsSnapshot;
}

async function invokeCommandList(runtime: RemoteFleetRuntime): Promise<readonly RemoteFleetCommandSummary[]> {
  const response = await runtime.invoke('listCommands', {});
  expect(response.status).toBe(200);
  return (response.data as { readonly commands: readonly RemoteFleetCommandSummary[] }).commands;
}

async function invokeAuditEventList(runtime: RemoteFleetRuntime): Promise<readonly RemoteFleetAuditEventSummary[]> {
  const response = await runtime.invoke('listAuditEvents', {});
  expect(response.status).toBe(200);
  return (response.data as { readonly auditEvents: readonly RemoteFleetAuditEventSummary[] }).auditEvents;
}

function runtimeAgentRequestBase(agentId: string, requestId: string) {
  return {
    requestId,
    agentId,
    sentAt: '2026-07-06T00:00:00.000Z',
  } as const;
}

async function ingestRuntimeAgentHeartbeat(
  runtime: RemoteFleetRuntime,
  input: {
    readonly agentId: string;
    readonly requestId: string;
    readonly authorizationCredential: string;
    readonly enrollmentCredential?: string;
    readonly observedAt?: string;
    readonly status?: 'starting' | 'running' | 'draining' | 'stopping' | 'stopped' | 'degraded';
  },
) {
  return await runtime.invoke('ingestRuntimeAgentIngress', {
    rawRequest: {
      ...runtimeAgentRequestBase(input.agentId, input.requestId),
      type: 'runtime-agent.heartbeat',
      observedAt: input.observedAt ?? '2026-07-06T00:00:00.000Z',
      status: input.status ?? 'running',
    },
    authorizationCredential: input.authorizationCredential,
    ...(input.enrollmentCredential ? { enrollmentCredential: input.enrollmentCredential } : {}),
  });
}

async function ingestRuntimeAgentCommandResult(
  runtime: RemoteFleetRuntime,
  input: {
    readonly agentId: string;
    readonly requestId: string;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly authorizationCredential: string;
    readonly result: { readonly reason: 'succeeded' | 'failed' | 'cancelled' | 'timed-out'; readonly completedAt: string; readonly message?: string; readonly timeoutMs?: number };
  },
) {
  return await runtime.invoke('ingestRuntimeAgentIngress', {
    rawRequest: {
      ...runtimeAgentRequestBase(input.agentId, input.requestId),
      type: 'runtime-agent.command.result',
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      result: input.result,
    },
    authorizationCredential: input.authorizationCredential,
  });
}

async function ingestRuntimeAgentCommandProgress(
  runtime: RemoteFleetRuntime,
  input: {
    readonly agentId: string;
    readonly requestId: string;
    readonly commandId: string;
    readonly idempotencyKey: string;
    readonly authorizationCredential: string;
  },
) {
  return await runtime.invoke('ingestRuntimeAgentIngress', {
    rawRequest: {
      ...runtimeAgentRequestBase(input.agentId, input.requestId),
      type: 'runtime-agent.command.progress',
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      progress: { state: 'running' },
    },
    authorizationCredential: input.authorizationCredential,
  });
}

async function bootstrapRuntimeAgentEnrollment(
  runtime: RemoteFleetRuntime,
  nodeId: string,
): Promise<string> {
  if (!runtimeAgentBootstrapEnrollmentTokens.get(runtime)?.has(`${nodeId}:agent`)) {
    const registerResponse = await runtime.invoke('register', {
      node: {
        id: nodeId,
        targetKind: 'ssh-host',
        secretRefs: {
          sshPrivateKey: {
            kind: 'secret-ref',
            ref: `remote-fleet://test/${nodeId}/ssh-private-key`,
          },
          anthropicApiKey: {
            kind: 'secret-ref',
            ref: `remote-fleet://test/${nodeId}/anthropic-api-key`,
          },
        },
      },
    });
    expect(registerResponse.status).toBe(200);
    const installResponse = await runtime.invoke('installAgent', { nodeId });
    expect(installResponse.status).toBe(202);
  }
  const enrollmentToken = runtimeAgentBootstrapEnrollmentTokens.get(runtime)?.get(`${nodeId}:agent`);
  if (!enrollmentToken) {
    throw new Error(`RuntimeAgent bootstrap enrollment token is unavailable for node: ${nodeId}`);
  }
  return enrollmentToken;
}

async function enrollRuntimeAgent(
  runtime: RemoteFleetRuntime,
  nodeId: string,
  ingressCredential = `runtime-agent-${nodeId}-credential`,
): Promise<string> {
  const enrollmentToken = await bootstrapRuntimeAgentEnrollment(runtime, nodeId);
  const heartbeatResponse = await ingestRuntimeAgentHeartbeat(runtime, {
    agentId: `${nodeId}:agent`,
    requestId: `enroll-${nodeId}`,
    authorizationCredential: enrollmentToken,
    enrollmentCredential: ingressCredential,
  });
  expect(heartbeatResponse.status).toBe(200);
  const credentials = runtimeAgentIngressCredentials.get(runtime) ?? new Map<string, string>();
  credentials.set(`${nodeId}:agent`, ingressCredential);
  runtimeAgentIngressCredentials.set(runtime, credentials);
  return ingressCredential;
}

async function acknowledgeRuntimeAgentCommandResult(
  runtime: RemoteFleetRuntime,
  input: {
    readonly agentId?: string;
    readonly commandId: string;
    readonly idempotencyKey?: string;
    readonly result: { readonly reason: 'succeeded' | 'failed' | 'cancelled' | 'timed-out'; readonly completedAt: string; readonly message?: string; readonly timeoutMs?: number };
  },
) {
  if (!input.agentId) {
    return await ingestRuntimeAgentCommandResult(runtime, {
      ...input,
      agentId: '',
      requestId: `result-${input.commandId}`,
      authorizationCredential: '',
    });
  }
  const credentials = runtimeAgentIngressCredentials.get(runtime);
  const authorizationCredential = credentials?.get(input.agentId) ?? await enrollRuntimeAgent(runtime, input.agentId.replace(/:agent$/, ''));
  const response = await ingestRuntimeAgentCommandResult(runtime, {
    ...input,
    requestId: `result-${input.commandId}`,
    authorizationCredential,
  });
  if (response.status !== 200) return response;
  return {
    ...response,
    data: {
      ...(response.data as Record<string, unknown>),
      snapshot: await invokeSnapshot(runtime),
    },
  };
}

async function acknowledgeRuntimeAgentCommandProgress(
  runtime: RemoteFleetRuntime,
  input: {
    readonly agentId?: string;
    readonly commandId: string;
    readonly idempotencyKey?: string;
  },
) {
  if (!input.agentId) {
    return await ingestRuntimeAgentCommandProgress(runtime, {
      ...input,
      agentId: '',
      requestId: `progress-${input.commandId}`,
      authorizationCredential: '',
    });
  }
  const credentials = runtimeAgentIngressCredentials.get(runtime);
  const authorizationCredential = credentials?.get(input.agentId) ?? await enrollRuntimeAgent(runtime, input.agentId.replace(/:agent$/, ''));
  const response = await ingestRuntimeAgentCommandProgress(runtime, {
    ...input,
    requestId: `progress-${input.commandId}`,
    authorizationCredential,
  });
  if (response.status !== 200) return response;
  return {
    ...response,
    data: {
      ...(response.data as Record<string, unknown>),
      snapshot: await invokeSnapshot(runtime),
    },
  };
}

function captureBootstrapEnrollmentToken(
  cache: WeakMap<RemoteFleetRuntime, Map<string, string>>,
  runtime: RemoteFleetRuntime,
  request: RemoteFleetTestHostRequestWithoutId,
): void {
  if (!isRemoteFleetBootstrapHostRequest(request) || !request.envelope.enrollment) {
    return;
  }
  const tokens = cache.get(runtime) ?? new Map<string, string>();
  tokens.set(request.envelope.enrollment.agentId, request.envelope.enrollment.token);
  cache.set(runtime, tokens);
}

function defaultRemoteFleetHostResult(
  request: RemoteFleetTestHostRequestWithoutId,
): RemoteFleetBootstrapCommandResult | { readonly resultType: 'accepted'; readonly accepted: true } {
  if (isRemoteFleetBootstrapHostRequest(request)) {
    return {
      resultType: 'completed',
      commandId: request.envelope.commandId,
      providerKind: request.envelope.providerKind,
    };
  }
  return { resultType: 'accepted', accepted: true };
}

type RemoteFleetRuntimeOptions = {
  readonly runtimeDataRootDir: string;
  readonly host?: RemoteFleetTestHostRequestWithoutId[];
  readonly hostResult?: unknown;
  readonly handleHostRequest?: (request: RemoteFleetTestHostRequestWithoutId) => unknown | Promise<unknown>;
  readonly nowIso?: string;
  readonly runtimeAgentIngressUrl?: string;
};

type QueuedStartCommandTestContext = {
  readonly runtime: RemoteFleetRuntime;
  readonly commandId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly queuedSnapshot: RemoteFleetSnapshot;
  readonly queuedCommandSummary: unknown;
};

class InMemoryRemoteFleetStateStore implements RemoteFleetStateStore {
  state: RemoteFleetPersistedState | null;
  writes = 0;
  failWrites = 0;

  constructor(state: RemoteFleetPersistedState | null = null) {
    this.state = state;
  }

  async readState(): Promise<RemoteFleetPersistedState | null> {
    return this.state;
  }

  async writeState(state: RemoteFleetPersistedState): Promise<void> {
    this.writes += 1;
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error('Remote Fleet test state write failed.');
    }
    this.state = structuredClone(state);
  }
}

function createCredentialFailureWindowRuntime(input: {
  readonly store: InMemoryRemoteFleetStateStore;
  readonly request: (request: RemoteFleetHostRequestWithoutId) => unknown | Promise<unknown>;
}): RemoteFleetRuntime {
  return new RemoteFleetRuntime({
    host: { request: input.request },
    store: input.store,
    identity: {
      randomId: (prefix) => `${prefix}-credential-failure-window`,
      randomToken: () => 'credential-failure-window-token',
      hashSecret: async () => 'sha256:credential-failure-window',
    },
    clock: { nowIso: () => '2026-07-06T00:00:00.000Z' },
  });
}

function expectCredentialStateIsSafe(value: unknown, plaintext: string): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [plaintext, 'sha256:', 'ciphertext', 'iv', 'authTag', 'key']) {
    expect(serialized).not.toContain(forbidden);
  }
}

function createRemoteFleetRuntime(options: RemoteFleetRuntimeOptions): RemoteFleetRuntime {
  let runtime: RemoteFleetRuntime;
  runtime = new RemoteFleetRuntime({
    ...(options.host ? {
      host: {
        request: async (request) => {
          const capturedRequest = request as RemoteFleetTestHostRequestWithoutId;
          options.host!.push(capturedRequest);
          captureBootstrapEnrollmentToken(runtimeAgentBootstrapEnrollmentTokens, runtime, capturedRequest);
          const result = options.handleHostRequest
            ? await options.handleHostRequest(capturedRequest)
            : options.hostResult ?? defaultRemoteFleetHostResult(capturedRequest);
          return isRemoteFleetBootstrapHostRequest(capturedRequest)
            && !isRemoteFleetBootstrapCommandResult(result)
            ? defaultRemoteFleetHostResult(capturedRequest)
            : result;
        },
      },
    } : {}),
    store: new FileRemoteFleetStateStore({ runtimeDataRootDir: options.runtimeDataRootDir }),
    identity: new NodeRemoteFleetRuntimeIdentity(),
    clock: options.nowIso
      ? { nowIso: () => options.nowIso! }
      : new SystemRemoteFleetRuntimeClock(),
    runtimeAgentIngressUrl: options.runtimeAgentIngressUrl ?? 'https://fleet.example.test/api/remote-fleet/runtime-agent/ingress',
  });
  return runtime;
}

function createDeterministicRemoteFleetRuntime(options: RemoteFleetRuntimeOptions): RemoteFleetRuntime {
  let idIndex = 0;
  let runtime: RemoteFleetRuntime;
  runtime = new RemoteFleetRuntime({
    ...(options.host ? {
      host: {
        request: async (request) => {
          const capturedRequest = request as RemoteFleetTestHostRequestWithoutId;
          options.host!.push(capturedRequest);
          captureBootstrapEnrollmentToken(runtimeAgentBootstrapEnrollmentTokens, runtime, capturedRequest);
          const result = options.handleHostRequest
            ? await options.handleHostRequest(capturedRequest)
            : options.hostResult ?? defaultRemoteFleetHostResult(capturedRequest);
          return isRemoteFleetBootstrapHostRequest(capturedRequest)
            && !isRemoteFleetBootstrapCommandResult(result)
            ? defaultRemoteFleetHostResult(capturedRequest)
            : result;
        },
      },
    } : {}),
    store: new FileRemoteFleetStateStore({ runtimeDataRootDir: options.runtimeDataRootDir }),
    identity: {
      randomId: (prefix) => `${prefix}-bootstrap-${++idIndex}`,
      randomToken: () => BOOTSTRAP_ENROLLMENT_SECRET_TOKEN.slice('mrf_'.length),
      hashSecret: async () => 'sha256:deterministic-bootstrap-token-hash',
    },
    clock: { nowIso: () => options.nowIso ?? '2026-07-06T00:00:00.000Z' },
    runtimeAgentIngressUrl: options.runtimeAgentIngressUrl ?? 'https://fleet.example.test/api/remote-fleet/runtime-agent/ingress',
  });
  return runtime;
}

async function writePersistedState(runtimeDataRootDir: string, state: unknown): Promise<void> {
  await mkdir(join(runtimeDataRootDir, 'remote-fleet'), { recursive: true });
  await writeFile(join(runtimeDataRootDir, 'remote-fleet', 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function createCommandRecord(index: number): RemoteFleetCommandRecord {
  const timestamp = new Date(Date.UTC(2026, 6, 6, 0, 0, index)).toISOString();
  return {
    id: `cmd-history-${index.toString().padStart(3, '0')}`,
    idempotencyKey: `idem-history-${index}`,
    nodeId: 'node-history',
    command: 'history-command',
    state: { reason: 'succeeded', completedAt: timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
    message: `History command ${index}`,
  };
}

function createAuditEventRecord(index: number): RemoteFleetAuditEventRecord {
  const timestamp = new Date(Date.UTC(2026, 6, 6, 0, 0, index)).toISOString();
  return {
    id: `audit-history-${index.toString().padStart(3, '0')}`,
    eventName: 'remoteFleet.command.completed',
    occurredAt: timestamp,
    nodeId: 'node-history',
    commandId: `cmd-history-${index.toString().padStart(3, '0')}`,
    message: `History audit event ${index}`,
  };
}

async function createQueuedStartCommand(runtimeDataRootDir: string, nodeId: string): Promise<QueuedStartCommandTestContext> {
  const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: [] });

  await runtime.invoke('register', { node: { id: nodeId, displayName: 'ACK Ownership Node' } });
  const initialSnapshot = await invokeSnapshot(runtime);
  const runtimeId = initialSnapshot.runtimes[0]?.id;
  expect(runtimeId).toBe(`${nodeId}:openclaw`);

  const startResponse = await runtime.invoke('start', { runtimeId });
  expect(startResponse.status).toBe(202);
  const startData = startResponse.data as {
    readonly snapshot: RemoteFleetSnapshot;
    readonly command: { readonly id: string };
  };
  const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, startData.command.id);
  const agentId = commandRecord.agentId;
  if (!agentId) {
    throw new Error(`Queued Remote Fleet command is missing agentId: ${startData.command.id}`);
  }

  return {
    runtime,
    commandId: startData.command.id,
    agentId,
    idempotencyKey: commandRecord.idempotencyKey,
    queuedSnapshot: startData.snapshot,
    queuedCommandSummary: startData.command,
  };
}

function expectBadRequest(response: { readonly status: number; readonly data: unknown }, error: string): void {
  expect(response.status).toBe(400);
  expect(response.data).toEqual({ success: false, error });
}

function expectNoIdempotencyKeyProjection(value: unknown, idempotencyKey: string): void {
  expect(value).not.toHaveProperty('idempotencyKey');
  expect(JSON.stringify(value)).not.toContain(idempotencyKey);
}

function expectCommandSummariesDoNotExposeIdempotencyKey(snapshot: RemoteFleetSnapshot, idempotencyKey: string): void {
  for (const command of snapshot.commands) {
    expectNoIdempotencyKeyProjection(command, idempotencyKey);
  }
  expect(JSON.stringify(snapshot)).not.toContain(idempotencyKey);
}

function isRemoteFleetBootstrapHostRequest(request: RemoteFleetTestHostRequestWithoutId): request is RemoteFleetBootstrapHostRequestWithoutId {
  return request.type === 'host.remoteFleetBootstrap.dispatchCommand';
}

function isRemoteFleetConnectionProbeHostRequest(request: RemoteFleetTestHostRequestWithoutId): request is RemoteFleetConnectionProbeHostRequestWithoutId {
  return request.type === 'host.remoteFleetConnectionProbe.dispatch';
}

function expectBootstrapDispatchRequests(
  hostRequests: readonly RemoteFleetTestHostRequestWithoutId[],
  expectedCount: number,
): readonly RemoteFleetBootstrapHostRequestWithoutId[] {
  const bootstrapRequests = hostRequests.filter(isRemoteFleetBootstrapHostRequest);
  expect(bootstrapRequests).toHaveLength(expectedCount);
  expect(hostRequests).not.toContainEqual(expect.objectContaining({ type: 'host.runtimeAgent.dispatchCommand' }));
  return bootstrapRequests;
}

function expectSafeBootstrapEnvelope(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  expected: {
    readonly commandId: string;
    readonly commandName: 'probe-node' | 'install-agent';
    readonly providerKind: 'ssh' | 'docker' | 'k8s';
    readonly nodeId: string;
    readonly agentId: string;
  },
): void {
  expect(envelope).toEqual(expect.objectContaining({
    envelopeVersion: REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
    commandId: expected.commandId,
    commandName: expected.commandName,
    providerKind: expected.providerKind,
    nodeId: expected.nodeId,
    agentId: expected.agentId,
    node: expect.objectContaining({ id: expected.nodeId }),
    agent: expect.objectContaining({ id: expected.agentId, nodeId: expected.nodeId }),
  }));
  expect(envelope.node.publicConfig).toEqual(expect.any(Object));
  expect(envelope.node.secretRefs).toEqual(expect.any(Object));
}

async function expectEnrollmentTokenNotLeaked(input: {
  readonly runtimeDataRootDir: string;
  readonly token: string;
  readonly snapshot: RemoteFleetSnapshot;
  readonly command: unknown;
}): Promise<void> {
  expect(JSON.stringify(input.snapshot)).not.toContain(input.token);
  expect(JSON.stringify(input.command)).not.toContain(input.token);
  const persistedStateText = await readPersistedStateText(input.runtimeDataRootDir);
  expect(persistedStateText).not.toContain(input.token);
  const persistedState = JSON.parse(persistedStateText) as {
    readonly commands?: readonly RemoteFleetCommandRecord[];
    readonly auditEvents?: readonly RemoteFleetAuditEventRecord[];
  };
  for (const command of persistedState.commands ?? []) {
    expect(command.message ?? '').not.toContain(input.token);
  }
  for (const event of persistedState.auditEvents ?? []) {
    expect(event.message ?? '').not.toContain(input.token);
    expect(JSON.stringify(event.metadata ?? {})).not.toContain(input.token);
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('RemoteFleetRuntime persisted worker state', () => {
  it('dispatches the metrics route to the Remote Fleet service', async () => {
    const metrics = { nodes: { totalCount: 0 }, commands: { totalCount: 0 }, auditEvents: { totalCount: 0 } };
    const invoke = vi.fn(async () => ({ status: 200, data: metrics }));

    const response = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'GET',
      '/api/remote-fleet/metrics',
      {},
      { remoteFleetService: { invoke } },
    );

    expect(response).toEqual({ status: 200, data: metrics });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('metrics', {});
  });

  it('dispatches connection and environment routes to the Remote Fleet service', async () => {
    const invoke = vi.fn(async () => ({ status: 200, data: { snapshot: {} } }));

    const deleteConnectionResponse = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'POST',
      '/api/remote-fleet/delete-connection',
      { connectionId: 'connection-route' },
      { remoteFleetService: { invoke } },
    );
    const registerResponse = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'POST',
      '/api/remote-fleet/register-environment',
      { environment: { connectionId: 'connection-route-env' } },
      { remoteFleetService: { invoke } },
    );
    const deployResponse = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'POST',
      '/api/remote-fleet/deploy-environment',
      { environmentId: 'environment-route' },
      { remoteFleetService: { invoke } },
    );
    const deleteResponse = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'POST',
      '/api/remote-fleet/delete-environment',
      { environmentId: 'environment-route' },
      { remoteFleetService: { invoke } },
    );

    expect(deleteConnectionResponse).toEqual({ status: 200, data: { snapshot: {} } });
    expect(registerResponse).toEqual({ status: 200, data: { snapshot: {} } });
    expect(deployResponse).toEqual({ status: 200, data: { snapshot: {} } });
    expect(deleteResponse).toEqual({ status: 200, data: { snapshot: {} } });
    expect(invoke).toHaveBeenNthCalledWith(1, 'deleteConnection', { connectionId: 'connection-route' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'registerEnvironment', { environment: { connectionId: 'connection-route-env' } });
    expect(invoke).toHaveBeenNthCalledWith(3, 'deployEnvironment', { environmentId: 'environment-route' });
    expect(invoke).toHaveBeenNthCalledWith(4, 'deleteEnvironment', { environmentId: 'environment-route' });
  });

  it.each([
    ['top-level endpointUrl', (endpointUrl: string) => ({ endpointUrl })],
    ['nested publicConfig.docker.endpointUrl', (endpointUrl: string) => ({ publicConfig: { docker: { endpointUrl } } })],
  ])('authoritatively rejects each Docker local HTTPS 2375 mismatch in $0 without creating a connection', async (_location, connectionPatch) => {
    for (const endpointUrl of ['https://localhost:2375', 'https://127.0.0.1:2375', 'https://[::1]:2375']) {
      const runtimeDataRootDir = await createRuntimeDataRoot();
      const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });

      const response = await runtime.invoke('registerConnection', {
        connection: {
          id: `connection-rejected-${endpointUrl.replace(/[^a-z0-9]/gi, '-')}`,
          connectionKind: 'container',
          ...connectionPatch(endpointUrl),
        },
      });

      expectBadRequest(response, 'Remote Fleet Docker local port 2375 must use HTTP instead of HTTPS.');
      expect(JSON.stringify(response.data)).not.toContain(endpointUrl);
      expect(JSON.stringify(response.data)).not.toMatch(/tls|token/i);
      expect((await invokeSnapshot(runtime)).connections).toEqual([]);
      await expect(readPersistedStateText(runtimeDataRootDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await runtime.close();
    }
  });

  it('repairs a same-ID Docker connection without recreating it or its environment association', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const connectionId = 'connection-docker-repair';
    const environmentId = 'environment-docker-repair';
    const existingSecretRefs = {
      dockerBearerToken: { kind: 'secret-ref' as const, ref: 'remote-fleet://connections/docker-repair/bearer' },
    };
    const firstRuntime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      nowIso: '2026-07-06T00:00:00.000Z',
    });

    await firstRuntime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        connectionKind: 'container',
        endpointUrl: 'https://docker-before.example.test:2376',
        publicConfig: {
          docker: {
            endpointUrl: 'https://docker-before.example.test:2376',
            context: 'production',
            containerName: 'existing-matchaclaw-environment',
          },
        },
        secretRefs: existingSecretRefs,
      },
    });
    await firstRuntime.invoke('registerEnvironment', {
      environment: {
        id: environmentId,
        connectionId,
        environmentKind: 'docker-container',
      },
    });
    const originalConnection = await readPersistedConnectionRecord(runtimeDataRootDir, connectionId);
    await firstRuntime.close();

    const repairedTopLevelEndpointUrl = 'https://docker-repaired.example.test:2376';
    const repairedNestedEndpointUrl = 'https://docker-repaired-nested.example.test:2376';
    const repairRuntime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      nowIso: '2026-07-06T00:05:00.000Z',
    });
    const repairResponse = await repairRuntime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        connectionKind: 'container',
        endpointUrl: repairedTopLevelEndpointUrl,
        publicConfig: { docker: { endpointUrl: repairedNestedEndpointUrl } },
      },
    });

    expect(repairResponse.status).toBe(200);
    const repairSnapshot = (repairResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(repairSnapshot.connections).toEqual([
      expect.objectContaining({
        id: connectionId,
        endpointUrl: repairedTopLevelEndpointUrl,
        createdAt: originalConnection.createdAt,
      }),
    ]);
    expect(repairSnapshot.environments).toContainEqual(expect.objectContaining({
      id: environmentId,
      connectionId,
    }));
    expect(await readPersistedConnectionRecord(runtimeDataRootDir, connectionId)).toEqual(expect.objectContaining({
      id: connectionId,
      endpointUrl: repairedTopLevelEndpointUrl,
      createdAt: originalConnection.createdAt,
      updatedAt: '2026-07-06T00:05:00.000Z',
      secretRefs: existingSecretRefs,
      publicConfig: {
        docker: {
          endpointUrl: repairedNestedEndpointUrl,
          context: 'production',
          containerName: 'existing-matchaclaw-environment',
        },
      },
    }));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.environments).toContainEqual(expect.objectContaining({
      id: environmentId,
      connectionId,
    }));
    await repairRuntime.close();
  });

  it('merges SSH public config and preserves omitted credentials during a same-ID repair', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const connectionId = 'connection-ssh-repair';
    const originalSecretRefs = {
      sshPrivateKey: { kind: 'secret-ref' as const, ref: 'remote-fleet://connections/ssh-repair/private-key' },
    };
    const firstRuntime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });

    await firstRuntime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        connectionKind: 'ssh-host',
        endpointUrl: 'ssh://old-host.example.test:22',
        publicConfig: {
          ssh: {
            host: 'old-host.example.test',
            port: 22,
            username: 'deploy',
            installCommand: 'echo existing-bootstrap',
          },
        },
        secretRefs: originalSecretRefs,
      },
    });
    await firstRuntime.close();

    const repairRuntime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });
    const repairResponse = await repairRuntime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        connectionKind: 'ssh-host',
        endpointUrl: 'ssh://new-host.example.test:2222',
        publicConfig: {
          ssh: {
            host: 'new-host.example.test',
            port: 2222,
            username: 'ops',
          },
        },
      },
    });

    expect(repairResponse.status).toBe(200);
    expect(JSON.stringify(repairResponse.data)).not.toContain(originalSecretRefs.sshPrivateKey.ref);
    expect(await readPersistedConnectionRecord(runtimeDataRootDir, connectionId)).toEqual(expect.objectContaining({
      endpointUrl: 'ssh://new-host.example.test:2222',
      secretRefs: originalSecretRefs,
      publicConfig: {
        ssh: {
          host: 'new-host.example.test',
          port: 2222,
          username: 'ops',
          installCommand: 'echo existing-bootstrap',
        },
      },
    }));
    await repairRuntime.close();
  });

  it('merges partial same-ID connection secretRefs without discarding existing credentials after restart', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const connectionId = 'connection-secret-ref-repair';
    const firstRuntime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });
    const originalSecretRefs = {
      dockerBearerToken: { kind: 'secret-ref' as const, ref: 'remote-fleet://connections/secret-ref-repair/docker' },
      sshPrivateKey: { kind: 'secret-ref' as const, ref: 'remote-fleet://connections/secret-ref-repair/ssh' },
    };

    await firstRuntime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        connectionKind: 'container',
        secretRefs: originalSecretRefs,
      },
    });
    await firstRuntime.close();

    const replacementDockerBearerToken = {
      kind: 'secret-ref' as const,
      ref: 'remote-fleet://connections/secret-ref-repair/docker-replacement',
    };
    const repairRuntime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });
    await repairRuntime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        secretRefs: { dockerBearerToken: replacementDockerBearerToken },
      },
    });

    expect(await readPersistedConnectionRecord(runtimeDataRootDir, connectionId)).toEqual(expect.objectContaining({
      secretRefs: {
        dockerBearerToken: replacementDockerBearerToken,
        sshPrivateKey: originalSecretRefs.sshPrivateKey,
      },
    }));
    await repairRuntime.close();

    const restoredRuntime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });
    expect(await readPersistedConnectionRecord(runtimeDataRootDir, connectionId)).toEqual(expect.objectContaining({
      secretRefs: {
        dockerBearerToken: replacementDockerBearerToken,
        sshPrivateKey: originalSecretRefs.sshPrivateKey,
      },
    }));
    await invokeSnapshot(restoredRuntime);
    await restoredRuntime.close();
  });

  it('preserves omitted node and environment config and labels during same-ID updates while allowing explicit clears', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });
    const nodeSecretRef = { kind: 'secret-ref' as const, ref: 'remote-fleet://nodes/config-preservation/ssh' };
    const environmentSecretRef = { kind: 'secret-ref' as const, ref: 'remote-fleet://environments/config-preservation/docker' };

    await runtime.invoke('registerConnection', {
      connection: { id: 'connection-config-preservation', connectionKind: 'container' },
    });
    await runtime.invoke('register', {
      node: {
        id: 'node-config-preservation',
        displayName: 'Original node',
        labels: ['node-original'],
        publicConfig: { runtimeLaunch: { workdir: '/srv/matchaclaw' } },
        secretRefs: { sshPrivateKey: nodeSecretRef },
      },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-config-preservation',
        connectionId: 'connection-config-preservation',
        displayName: 'Original environment',
        labels: ['environment-original'],
        publicConfig: { docker: { containerName: 'matchaclaw-preserved' } },
        secretRefs: { dockerBearerToken: environmentSecretRef },
      },
    });

    await runtime.invoke('register', {
      node: { id: 'node-config-preservation', displayName: 'Renamed node' },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-config-preservation',
        connectionId: 'connection-config-preservation',
        displayName: 'Renamed environment',
      },
    });

    let persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.nodes).toContainEqual(expect.objectContaining({
      id: 'node-config-preservation',
      displayName: 'Renamed node',
      labels: ['node-original'],
      publicConfig: { runtimeLaunch: { workdir: '/srv/matchaclaw' } },
      secretRefs: { sshPrivateKey: nodeSecretRef },
    }));
    expect(persistedState.environments).toContainEqual(expect.objectContaining({
      id: 'environment-config-preservation',
      displayName: 'Renamed environment',
      labels: ['environment-original'],
      publicConfig: { docker: { containerName: 'matchaclaw-preserved' } },
      secretRefs: { dockerBearerToken: environmentSecretRef },
    }));

    await runtime.invoke('register', {
      node: { id: 'node-config-preservation', labels: [], publicConfig: {}, secretRefs: {} },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-config-preservation',
        connectionId: 'connection-config-preservation',
        labels: [],
        publicConfig: {},
        secretRefs: {},
      },
    });

    persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.nodes).toContainEqual(expect.objectContaining({
      id: 'node-config-preservation',
      labels: [],
      publicConfig: {},
      secretRefs: {},
    }));
    expect(persistedState.environments).toContainEqual(expect.objectContaining({
      id: 'environment-config-preservation',
      labels: [],
      publicConfig: {},
      secretRefs: {},
    }));
    await runtime.close();
  });

  it.each([
    'connections',
    'environments',
    'managedResources',
    'nodes',
    'agents',
    'runtimes',
    'endpoints',
    'capabilities',
    'commands',
    'leases',
    'sessions',
    'auditEvents',
  ] as const)('ignores invalid persisted %s records during startup', async (collection) => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    await writePersistedState(runtimeDataRootDir, {
      version: 1,
      [collection]: [null, 1, {}, { id: 1 }, { id: '  ' }],
    });
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir });

    expect(await invokeSnapshot(runtime)).toMatchObject({
      connections: [],
      environments: [],
      managedResources: [],
      nodes: [],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: [],
      leases: [],
      sessions: [],
      auditEvents: [],
    });
    await runtime.close();
  });

  it('returns zero-valued metrics for an empty runtime', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir });

    const metrics = await invokeMetrics(runtime);

    expect(metrics.nodes.totalCount).toBe(0);
    expect(metrics.nodes.countByStatus).toEqual({ unknown: 0, online: 0, offline: 0, disabled: 0, error: 0 });
    expect(metrics.commands.totalCount).toBe(0);
    expect(metrics.commands.countByStatus).toEqual({ queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 });
    expect(metrics.auditEvents.totalCount).toBe(0);
    await runtime.close();
  });

  it('registers an environment under a connection and binds the default node, agent, and runtime', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });

    await runtime.invoke('registerConnection', {
      connection: { id: 'connection-env', displayName: 'Docker Engine', connectionKind: 'container' },
    });
    const response = await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-docker',
        connectionId: 'connection-env',
        displayName: 'Docker Runtime Environment',
        environmentKind: 'docker-container',
        publicConfig: { docker: { containerName: 'matchaclaw-env' } },
        secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: 'vault://remote-fleet/docker/token' } },
      },
    });

    expect(response.status).toBe(200);
    const snapshot = (response.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(snapshot.environments).toContainEqual(expect.objectContaining({
      id: 'environment-docker',
      connectionId: 'connection-env',
      nodeId: 'environment-docker:node',
      environmentKind: 'docker-container',
      targetKind: 'container',
      status: 'registered',
    }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({
      id: 'environment-docker:node',
      connectionId: 'connection-env',
      environmentId: 'environment-docker',
      targetKind: 'container',
    }));
    expect(snapshot.agents).toContainEqual(expect.objectContaining({
      id: 'environment-docker:node:agent',
      connectionId: 'connection-env',
      environmentId: 'environment-docker',
      nodeId: 'environment-docker:node',
    }));
    expect(snapshot.runtimes).toContainEqual(expect.objectContaining({
      id: 'environment-docker:node:openclaw',
      connectionId: 'connection-env',
      environmentId: 'environment-docker',
      nodeId: 'environment-docker:node',
    }));
    expect(JSON.stringify(snapshot)).not.toContain('vault://remote-fleet/docker/token');
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.environments).toContainEqual(expect.objectContaining({ id: 'environment-docker', connectionId: 'connection-env' }));
    await runtime.close();
  });

  it('rejects removing an environment-owned node while preserving standalone node deletion', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });

    await runtime.invoke('registerConnection', {
      connection: { id: 'connection-remove-node-ownership', connectionKind: 'container' },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-remove-node-ownership',
        connectionId: 'connection-remove-node-ownership',
        environmentKind: 'docker-container',
      },
    });
    await runtime.invoke('register', { node: { id: 'node-standalone-remove', displayName: 'Standalone removable node' } });

    const ownedRemoval = await runtime.invoke('removeNode', { nodeId: 'environment-remove-node-ownership:node' });
    expectBadRequest(ownedRemoval, 'Remote Fleet node environment-remove-node-ownership:node is owned by environment environment-remove-node-ownership. Delete the environment instead.');

    const standaloneRemoval = await runtime.invoke('removeNode', { nodeId: 'node-standalone-remove' });
    expect(standaloneRemoval.status).toBe(200);
    const snapshot = (standaloneRemoval.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({
      id: 'environment-remove-node-ownership:node',
      environmentId: 'environment-remove-node-ownership',
    }));
    expect(snapshot.nodes).not.toContainEqual(expect.objectContaining({ id: 'node-standalone-remove' }));
    expect(snapshot.agents).not.toContainEqual(expect.objectContaining({ id: 'node-standalone-remove:agent' }));
    expect(snapshot.runtimes).not.toContainEqual(expect.objectContaining({ id: 'node-standalone-remove:openclaw' }));
    await runtime.close();
  });

  it('safely rejects deleting a restored environment whose historical bare node ID is now owned by another environment', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const now = '2026-07-06T00:00:00.000Z';
    const sharedNodeId = 'legacy-shared-bare-node';
    const environmentAId = 'legacy-environment-a';
    const environmentBId = 'legacy-environment-b';
    const environmentBResourceId = 'legacy-resource-b';
    const environmentBEndpointId = 'legacy-runtime-b:endpoint';
    const environmentBSessionId = 'legacy-terminal-b';
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    await writePersistedState(runtimeDataRootDir, {
      version: 1,
      connections: [{
        id: 'legacy-connection-a',
        displayName: 'Legacy connection A',
        connectionKind: 'container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: now,
        updatedAt: now,
      }, {
        id: 'legacy-connection-b',
        displayName: 'Legacy connection B',
        connectionKind: 'container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: now,
        updatedAt: now,
      }],
      environments: [{
        id: environmentAId,
        connectionId: 'legacy-connection-a',
        nodeId: sharedNodeId,
        displayName: 'Legacy environment A',
        environmentKind: 'docker-container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        lifecycle: { reason: 'ready', readyAt: now },
        managedResourceIds: ['legacy-resource-a'],
        createdAt: now,
        updatedAt: now,
      }, {
        id: environmentBId,
        connectionId: 'legacy-connection-b',
        nodeId: sharedNodeId,
        displayName: 'Legacy environment B',
        environmentKind: 'docker-container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        lifecycle: { reason: 'ready', readyAt: now },
        managedResourceIds: [environmentBResourceId],
        createdAt: now,
        updatedAt: now,
      }],
      managedResources: [{
        id: 'legacy-resource-a',
        connectionId: 'legacy-connection-a',
        environmentId: environmentAId,
        nodeId: sharedNodeId,
        providerKind: 'docker',
        resourceKind: 'docker-container',
        remoteResourceId: 'legacy-container-a',
        remoteRefs: [{ providerKind: 'docker', resourceKind: 'docker-container', remoteResourceId: 'legacy-container-a' }],
        displayName: 'Legacy container A',
        labels: [],
        ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
        cleanupPolicy: { mode: 'delete-on-environment-delete' },
        lifecycle: { reason: 'ready', observedAt: now },
        createdAt: now,
        updatedAt: now,
      }, {
        id: environmentBResourceId,
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        nodeId: sharedNodeId,
        providerKind: 'docker',
        resourceKind: 'docker-container',
        remoteResourceId: 'legacy-container-b',
        remoteRefs: [{ providerKind: 'docker', resourceKind: 'docker-container', remoteResourceId: 'legacy-container-b' }],
        displayName: 'Legacy container B',
        labels: [],
        ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
        cleanupPolicy: { mode: 'delete-on-environment-delete' },
        lifecycle: { reason: 'ready', observedAt: now },
        createdAt: now,
        updatedAt: now,
      }],
      nodes: [{
        id: sharedNodeId,
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        managedResourceId: environmentBResourceId,
        displayName: 'Legacy node B',
        targetKind: 'container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'online', lastSeenAt: now },
        createdAt: now,
        updatedAt: now,
      }],
      agents: [{
        id: `${sharedNodeId}:agent`,
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        managedResourceId: environmentBResourceId,
        nodeId: sharedNodeId,
        displayName: 'Legacy RuntimeAgent B',
        enrollment: { reason: 'environment-ready', readyAt: now },
        capabilities: [],
        createdAt: now,
        updatedAt: now,
      }],
      runtimes: [{
        id: 'legacy-runtime-b',
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        managedResourceId: environmentBResourceId,
        nodeId: sharedNodeId,
        agentId: `${sharedNodeId}:agent`,
        displayName: 'Legacy OpenClaw B',
        runtimeKind: 'openclaw',
        endpointId: environmentBEndpointId,
        lifecycle: { reason: 'running', startedAt: now },
        createdAt: now,
        updatedAt: now,
      }],
      endpoints: [{
        id: environmentBEndpointId,
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        managedResourceId: environmentBResourceId,
        nodeId: sharedNodeId,
        runtimeId: 'legacy-runtime-b',
        endpointRef: { kind: 'native-runtime', runtimeAdapterId: 'remote-fleet', runtimeInstanceId: 'legacy-runtime-b' },
        scope: { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'remote-fleet', runtimeInstanceId: 'legacy-runtime-b' } },
        protocol: 'remote-fleet',
        labels: [],
        health: { reason: 'ready', lastProbeAt: now },
        createdAt: now,
        updatedAt: now,
      }],
      capabilities: [{
        id: `${environmentBEndpointId}:capabilities`,
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        managedResourceId: environmentBResourceId,
        nodeId: sharedNodeId,
        runtimeId: 'legacy-runtime-b',
        endpointId: environmentBEndpointId,
        displayName: 'Legacy capabilities B',
        operationIds: ['remoteFleet.runtime.status'],
        descriptors: [],
        freshness: { reason: 'current', observedAt: now, descriptorHash: 'legacy-b-capability-hash' },
        observedAt: now,
      }],
      commands: [],
      leases: [{
        id: 'legacy-terminal-lease-b',
        endpointId: environmentBEndpointId,
        ownerKind: 'session',
        ownerId: environmentBSessionId,
        state: { reason: 'active', acquiredAt: now, expiresAt: '2026-07-06T01:00:00.000Z' },
        createdAt: now,
        updatedAt: now,
      }],
      sessions: [{
        id: environmentBSessionId,
        connectionId: 'legacy-connection-b',
        environmentId: environmentBId,
        managedResourceId: environmentBResourceId,
        nodeId: sharedNodeId,
        runtimeId: 'legacy-runtime-b',
        endpointId: environmentBEndpointId,
        targetKind: 'container',
        state: { reason: 'connected', connectedAt: now },
        createdAt: now,
        updatedAt: now,
        leaseId: 'legacy-terminal-lease-b',
      }],
      auditEvents: [],
    });
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests, nowIso: now });

    const deleteResponse = await runtime.invoke('deleteEnvironment', { environmentId: environmentAId });

    expect(deleteResponse.status).toBe(202);
    expect(hostRequests).toEqual([]);
    const snapshotAfterDelete = await invokeSnapshot(runtime);
    expect(snapshotAfterDelete.environments).toContainEqual(expect.objectContaining({ id: environmentAId, status: 'failed' }));
    expect(snapshotAfterDelete.managedResources).toContainEqual(expect.objectContaining({ id: 'legacy-resource-a', environmentId: environmentAId, status: 'failed' }));
    await runtime.close();

    const restoredRuntime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir, nowIso: now });
    const snapshotAfterReload = await invokeSnapshot(restoredRuntime);
    for (const snapshot of [snapshotAfterDelete, snapshotAfterReload]) {
      expect(snapshot.environments).toContainEqual(expect.objectContaining({ id: environmentBId, nodeId: sharedNodeId, status: 'ready' }));
      expect(snapshot.managedResources).toContainEqual(expect.objectContaining({ id: environmentBResourceId, environmentId: environmentBId, status: 'ready' }));
      expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: sharedNodeId, environmentId: environmentBId }));
      expect(snapshot.agents).toContainEqual(expect.objectContaining({ id: `${sharedNodeId}:agent`, environmentId: environmentBId }));
      expect(snapshot.runtimes).toContainEqual(expect.objectContaining({ id: 'legacy-runtime-b', environmentId: environmentBId, status: 'running' }));
      expect(snapshot.endpoints).toContainEqual(expect.objectContaining({ id: environmentBEndpointId, environmentId: environmentBId, status: 'ready' }));
      expect(snapshot.capabilities).toContainEqual(expect.objectContaining({ id: `${environmentBEndpointId}:capabilities`, environmentId: environmentBId, status: 'current' }));
      expect(snapshot.sessions).toContainEqual(expect.objectContaining({ id: environmentBSessionId, environmentId: environmentBId }));
    }
    await restoredRuntime.close();
  });

  it('rejects binding the same node to a different environment', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });

    await runtime.invoke('registerConnection', {
      connection: { id: 'connection-environment-ownership', connectionKind: 'container' },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-owner-a',
        connectionId: 'connection-environment-ownership',
        nodeId: 'environment-owner-shared-node',
        environmentKind: 'docker-container',
      },
    });

    const duplicateResponse = await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-owner-b',
        connectionId: 'connection-environment-ownership',
        nodeId: 'environment-owner-shared-node',
        environmentKind: 'docker-container',
      },
    });

    expect(duplicateResponse.status).toBe(400);
    expect(duplicateResponse.data).toEqual({
      success: false,
      error: 'Remote Fleet node environment-owner-shared-node is already bound to environment environment-owner-a.',
    });
    const snapshot = await invokeSnapshot(runtime);
    expect(snapshot.environments).toContainEqual(expect.objectContaining({
      id: 'environment-owner-a',
      nodeId: 'environment-owner-shared-node',
    }));
    expect(snapshot.environments).not.toContainEqual(expect.objectContaining({ id: 'environment-owner-b' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({
      id: 'environment-owner-shared-node',
      environmentId: 'environment-owner-a',
    }));
    expect(snapshot.agents).toContainEqual(expect.objectContaining({
      id: 'environment-owner-shared-node:agent',
      environmentId: 'environment-owner-a',
    }));
    expect(snapshot.runtimes).toContainEqual(expect.objectContaining({
      id: 'environment-owner-shared-node:openclaw',
      environmentId: 'environment-owner-a',
    }));
    await runtime.close();
  });

  it('rejects plaintext environment publicConfig during registration', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });

    await runtime.invoke('registerConnection', { connection: { id: 'connection-env-secret', connectionKind: 'container' } });
    const response = await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-secret',
        connectionId: 'connection-env-secret',
        publicConfig: { docker: { apiToken: 'plaintext-token' } },
      },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.data)).toContain('environment publicConfig must not contain plaintext credential key publicConfig.docker.apiToken');
    await runtime.close();
  });

  it('deploys an environment through bootstrap and binds returned managed resources', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
        expect(request.type).toBe('host.remoteFleetBootstrap.dispatchCommand');
        const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
        expect(envelope.commandName).toBe('deploy-environment');
        expect(envelope.environment).toEqual(expect.objectContaining({ id: 'environment-deploy', connectionId: 'connection-deploy' }));
        expect(JSON.stringify(envelope)).not.toContain('plaintext');
        return {
          resultType: 'completed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          message: 'Docker deploy completed.',
          managedResources: [{
            providerKind: 'docker',
            resourceKind: 'docker-container',
            remoteResourceId: 'container-deploy-1',
            remoteRefs: [{ providerKind: 'docker', resourceKind: 'docker-container', remoteResourceId: 'container-deploy-1', name: 'matchaclaw-env' }],
            ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
            cleanupPolicy: { mode: 'delete-on-environment-delete' },
            displayName: 'Docker container container-deploy-1',
            labels: ['runtime-agent'],
          }],
        };
      },
    });

    await runtime.invoke('registerConnection', { connection: { id: 'connection-deploy', connectionKind: 'container' } });
    await runtime.invoke('registerEnvironment', { environment: { id: 'environment-deploy', connectionId: 'connection-deploy', environmentKind: 'docker-container' } });
    hostRequests.length = 0;

    const response = await runtime.invoke('deployEnvironment', { environmentId: 'environment-deploy' });

    expect(response.status).toBe(202);
    const snapshot = (response.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    const managedResourceId = 'environment-deploy:docker:docker-container:container-deploy-1';
    expect(hostRequests).toHaveLength(1);
    expect(snapshot.environments).toContainEqual(expect.objectContaining({
      id: 'environment-deploy',
      status: 'ready',
      managedResourceIds: [managedResourceId],
    }));
    expect(snapshot.managedResources).toContainEqual(expect.objectContaining({
      id: managedResourceId,
      connectionId: 'connection-deploy',
      environmentId: 'environment-deploy',
      nodeId: 'environment-deploy:node',
      providerKind: 'docker',
      resourceKind: 'docker-container',
      ownership: 'matcha-managed',
      cleanupPolicy: 'delete-on-environment-delete',
      status: 'ready',
    }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'environment-deploy:node', managedResourceId }));
    expect(snapshot.agents).toContainEqual(expect.objectContaining({ id: 'environment-deploy:node:agent', managedResourceId }));
    expect(snapshot.runtimes).toContainEqual(expect.objectContaining({ id: 'environment-deploy:node:openclaw', managedResourceId }));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.managedResources).toContainEqual(expect.objectContaining({ id: managedResourceId, remoteResourceId: 'container-deploy-1' }));
    await runtime.close();
  });

  it('issues an ephemeral enrollment only for SSH, VM, and Kubernetes environment deploys', async () => {
    const targetKinds = [
      ['ssh-host', 'ssh-workdir'],
      ['vm', 'vm-workdir'],
      ['k8s-pod', 'k8s-workload'],
    ] as const;

    for (const [targetKind, environmentKind] of targetKinds) {
      const runtimeDataRootDir = await createRuntimeDataRoot();
      const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
      const runtime = createDeterministicRemoteFleetRuntime({
        runtimeDataRootDir,
        host: hostRequests,
        handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
          const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
          return {
            resultType: 'completed',
            commandId: envelope.commandId,
            providerKind: envelope.providerKind,
          };
        },
      });
      const connectionId = `connection-${targetKind}`;
      const environmentId = `environment-${targetKind}`;
      await runtime.invoke('registerConnection', {
        connection: { id: connectionId, connectionKind: targetKind },
      });
      await runtime.invoke('registerEnvironment', {
        environment: {
          id: environmentId,
          connectionId,
          environmentKind,
          targetKind,
        },
      });
      hostRequests.length = 0;

      const response = await runtime.invoke('deployEnvironment', { environmentId });

      expect(response.status).toBe(202);
      const [bootstrapRequest] = expectBootstrapDispatchRequests(hostRequests, 1);
      expect(bootstrapRequest.envelope).toEqual(expect.objectContaining({
        commandName: 'deploy-environment',
        enrollment: expect.objectContaining({
          nodeId: `${environmentId}:node`,
          token: BOOTSTRAP_ENROLLMENT_SECRET_TOKEN,
        }),
      }));
      const snapshot = (response.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
      expect(JSON.stringify(snapshot)).not.toContain(BOOTSTRAP_ENROLLMENT_SECRET_TOKEN);
      expect(snapshot.agents).toContainEqual(expect.objectContaining({
        id: `${environmentId}:node:agent`,
        status: 'installed',
      }));
      const persistedStateText = await readPersistedStateText(runtimeDataRootDir);
      expect(persistedStateText).not.toContain(BOOTSTRAP_ENROLLMENT_SECRET_TOKEN);
      expect(persistedStateText).toContain('sha256:deterministic-bootstrap-token-hash');
      await runtime.close();
    }
  });

  it('settles unsupported Custom environment deploys as failed without minting enrollment', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });
    await runtime.invoke('registerConnection', {
      connection: { id: 'connection-custom', connectionKind: 'custom' },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-custom',
        connectionId: 'connection-custom',
        environmentKind: 'custom',
        targetKind: 'custom',
      },
    });
    hostRequests.length = 0;

    const response = await runtime.invoke('deployEnvironment', { environmentId: 'environment-custom' });

    expect(response.status).toBe(202);
    expect(hostRequests).toEqual([]);
    const snapshot = (response.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(snapshot.environments).toContainEqual(expect.objectContaining({
      id: 'environment-custom',
      status: 'failed',
    }));
    expect(snapshot.agents).toContainEqual(expect.objectContaining({
      id: 'environment-custom:node:agent',
      status: 'failed',
    }));
    expect(JSON.stringify(snapshot)).not.toContain(BOOTSTRAP_ENROLLMENT_SECRET_TOKEN);
    await runtime.close();
  });

  it('removes an environment and all related canonical records after eligible cleanup while retaining external remote resources', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
        expect(request.type).toBe('host.remoteFleetBootstrap.dispatchCommand');
        const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
        if (envelope.commandName === 'deploy-environment') {
          return {
            resultType: 'completed',
            commandId: envelope.commandId,
            providerKind: envelope.providerKind,
            managedResources: [{
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-delete-managed',
              remoteRefs: [{ providerKind: 'docker', resourceKind: 'docker-container', remoteResourceId: 'container-delete-managed' }],
              ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
              cleanupPolicy: { mode: 'delete-on-environment-delete' },
              displayName: 'Managed container',
            }, {
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-delete-external',
              remoteRefs: [{ providerKind: 'docker', resourceKind: 'docker-container', remoteResourceId: 'container-delete-external' }],
              ownership: { reason: 'external', message: 'user-owned container' },
              cleanupPolicy: { mode: 'delete-on-environment-delete' },
              displayName: 'External container',
            }],
          };
        }
        expect(envelope.commandName).toBe('delete-environment');
        expect(envelope.managedResource).toEqual(expect.objectContaining({ remoteResourceId: 'container-delete-managed' }));
        return {
          resultType: 'completed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          remoteResourceId: envelope.managedResource?.remoteResourceId,
        };
      },
    });

    await runtime.invoke('registerConnection', { connection: { id: 'connection-delete', connectionKind: 'container' } });
    await runtime.invoke('registerEnvironment', { environment: { id: 'environment-delete', connectionId: 'connection-delete', environmentKind: 'docker-container' } });
    await runtime.invoke('deployEnvironment', { environmentId: 'environment-delete' });
    hostRequests.length = 0;

    const deleteResponse = await runtime.invoke('deleteEnvironment', { environmentId: 'environment-delete' });

    expect(deleteResponse.status).toBe(202);
    const deleteSnapshot = (deleteResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0]).toEqual(expect.objectContaining({
      type: 'host.remoteFleetBootstrap.dispatchCommand',
      envelope: expect.objectContaining({ commandName: 'delete-environment' }),
    }));
    expect(deleteSnapshot.environments).not.toContainEqual(expect.objectContaining({ id: 'environment-delete' }));
    expect(deleteSnapshot.managedResources).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(deleteSnapshot.nodes).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(deleteSnapshot.agents).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(deleteSnapshot.runtimes).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(deleteSnapshot.endpoints).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(deleteSnapshot.capabilities).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(deleteSnapshot.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventName: 'remoteFleet.managedResource.cleanupSkipped' }),
      expect.objectContaining({ eventName: 'remoteFleet.managedResource.deleted' }),
      expect.objectContaining({ eventName: 'remoteFleet.environment.deleted' }),
    ]));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.environments).not.toContainEqual(expect.objectContaining({ id: 'environment-delete' }));
    expect(persistedState.managedResources).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(persistedState.nodes).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    expect(persistedState.agents).not.toContainEqual(expect.objectContaining({ environmentId: 'environment-delete' }));
    await runtime.close();
  });

  it('retains canonical environment records as failed when eligible cleanup fails', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
        const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
        if (envelope.commandName === 'deploy-environment') {
          return {
            resultType: 'completed',
            commandId: envelope.commandId,
            providerKind: envelope.providerKind,
            managedResources: [{
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-cleanup-failed',
              remoteRefs: [{ providerKind: 'docker', resourceKind: 'docker-container', remoteResourceId: 'container-cleanup-failed' }],
              ownership: { reason: 'matcha-managed', evidence: { label: 'matchaclaw.remoteFleet=true' } },
              cleanupPolicy: { mode: 'delete-on-environment-delete' },
              displayName: 'Cleanup failure container',
            }],
          };
        }
        return {
          resultType: 'failed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          reason: 'unavailable',
          message: 'Remote cleanup failed.',
        };
      },
    });

    await runtime.invoke('registerConnection', { connection: { id: 'connection-cleanup-failed', connectionKind: 'container' } });
    await runtime.invoke('registerEnvironment', { environment: { id: 'environment-cleanup-failed', connectionId: 'connection-cleanup-failed', environmentKind: 'docker-container' } });
    await runtime.invoke('deployEnvironment', { environmentId: 'environment-cleanup-failed' });
    hostRequests.length = 0;

    const deleteResponse = await runtime.invoke('deleteEnvironment', { environmentId: 'environment-cleanup-failed' });

    expect(deleteResponse.status).toBe(202);
    expect(hostRequests).toHaveLength(1);
    const snapshot = await invokeSnapshot(runtime);
    expect(snapshot.environments).toContainEqual(expect.objectContaining({ id: 'environment-cleanup-failed', status: 'failed' }));
    expect(snapshot.managedResources).toContainEqual(expect.objectContaining({ environmentId: 'environment-cleanup-failed', status: 'failed' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ environmentId: 'environment-cleanup-failed' }));
    expect(snapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.environment.failed' }));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.environments).toContainEqual(expect.objectContaining({ id: 'environment-cleanup-failed' }));
    expect(persistedState.managedResources).toContainEqual(expect.objectContaining({ environmentId: 'environment-cleanup-failed' }));
    await runtime.close();
  });

  it('returns conflict for an associated connection and removes an unassociated connection from persistence', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir });
    await runtime.invoke('registerConnection', { connection: { id: 'connection-associated', connectionKind: 'container' } });
    await runtime.invoke('registerEnvironment', { environment: { id: 'environment-associated', connectionId: 'connection-associated', environmentKind: 'docker-container' } });

    const blockedResponse = await runtime.invoke('deleteConnection', { connectionId: 'connection-associated' });

    expect(blockedResponse).toEqual({
      status: 409,
      data: {
        success: false,
        error: 'Remote Fleet connection cannot be deleted while it still has associated resources. Delete those resources first.',
      },
    });
    expect((await invokeSnapshot(runtime)).connections).toContainEqual(expect.objectContaining({ id: 'connection-associated' }));

    await runtime.invoke('registerConnection', { connection: { id: 'connection-unassociated', connectionKind: 'ssh-host' } });
    const deletedResponse = await runtime.invoke('deleteConnection', { connectionId: 'connection-unassociated' });

    expect(deletedResponse.status).toBe(200);
    expect((await invokeSnapshot(runtime)).connections).not.toContainEqual(expect.objectContaining({ id: 'connection-unassociated' }));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.connections).not.toContainEqual(expect.objectContaining({ id: 'connection-unassociated' }));
    expect(persistedState.auditEvents).toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.connection.deleted',
      connectionId: 'connection-unassociated',
    }));
    await runtime.close();
  });

  it('rolls back an unpersisted credential intent before host write and allows the same operation retry', async () => {
    const plaintext = 'credential-intent-plaintext';
    const store = new InMemoryRemoteFleetStateStore(emptyRemoteFleetPersistedState());
    store.failWrites = 1;
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createCredentialFailureWindowRuntime({
      store,
      request: (request) => {
        hostRequests.push(request);
        return {
          type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
          requestId: 'credential-intent-retry-write',
          resultType: 'written',
          credentialName: 'sshPassword',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/credential-intent/sshPassword' },
          writtenAt: '2026-07-06T00:00:00.000Z',
        };
      },
    });
    const request = {
      operationId: 'credential-intent-retry',
      credentialId: 'credential-intent',
      credentialName: 'sshPassword',
      plaintextValue: plaintext,
    } as const;

    await expect(runtime.invoke('writeCredential', request)).rejects.toThrow('Remote Fleet test state write failed.');
    expect(hostRequests).toEqual([]);
    expectCredentialStateIsSafe(store.state, plaintext);
    expectCredentialStateIsSafe(await invokeSnapshot(runtime), plaintext);

    const retry = await runtime.invoke('writeCredential', request);
    expect(retry.status).toBe(200);
    expect(hostRequests).toHaveLength(1);
    expect(store.state?.credentialWriteOperations).toContainEqual(expect.objectContaining({
      id: request.operationId,
      state: expect.objectContaining({ reason: 'completed' }),
    }));
    expectCredentialStateIsSafe(store.state, plaintext);
    expectCredentialStateIsSafe(await invokeSnapshot(runtime), plaintext);
    expectCredentialStateIsSafe(await invokeAuditEventList(runtime), plaintext);
  });

  it('retries final credential completion persistence without repeating the successful host write', async () => {
    const plaintext = 'credential-completion-plaintext';
    const store = new InMemoryRemoteFleetStateStore(emptyRemoteFleetPersistedState());
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createCredentialFailureWindowRuntime({
      store,
      request: (request) => {
        hostRequests.push(request);
        store.failWrites += 1;
        return {
          type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
          requestId: 'credential-completion-retry-write',
          resultType: 'written',
          credentialName: 'sshPassword',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/credential-completion/sshPassword' },
          writtenAt: '2026-07-06T00:00:00.000Z',
        };
      },
    });
    const request = {
      operationId: 'credential-completion-retry',
      credentialId: 'credential-completion',
      credentialName: 'sshPassword',
      plaintextValue: plaintext,
    } as const;

    await expect(runtime.invoke('writeCredential', request)).rejects.toThrow('Remote Fleet test state write failed.');
    expect(hostRequests).toHaveLength(1);
    expect(store.state?.credentialWriteOperations).toContainEqual(expect.objectContaining({
      id: request.operationId,
      state: expect.objectContaining({ reason: 'pending' }),
    }));

    const retry = await runtime.invoke('writeCredential', request);
    expect(retry.status).toBe(200);
    expect(hostRequests).toHaveLength(1);
    expect(store.state?.credentialWriteOperations).toContainEqual(expect.objectContaining({
      id: request.operationId,
      state: expect.objectContaining({ reason: 'completed' }),
    }));
    expect((await invokeAuditEventList(runtime)).filter((event) => event.eventName === 'remoteFleet.credential.written')).toHaveLength(1);
    expectCredentialStateIsSafe(store.state, plaintext);
    expectCredentialStateIsSafe(await invokeSnapshot(runtime), plaintext);
    expectCredentialStateIsSafe(await invokeAuditEventList(runtime), plaintext);
  });

  it('restores a pending credential write as completed from host status without duplicate audit on retry', async () => {
    const plaintext = 'credential-restart-plaintext';
    const operationId = 'credential-restart-status';
    const credentialRef = { kind: 'secret-ref' as const, ref: 'remote-fleet://credentials/credential-restart/sshPassword' };
    const store = new InMemoryRemoteFleetStateStore({
      ...emptyRemoteFleetPersistedState(),
      credentialWriteOperations: [{
        id: operationId,
        credentialId: 'credential-restart',
        credentialName: 'sshPassword',
        credentialRef,
        state: { reason: 'pending', requestedAt: '2026-07-06T00:00:00.000Z' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }],
    });
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createCredentialFailureWindowRuntime({
      store,
      request: (request) => {
        hostRequests.push(request);
        if (request.type === 'host.secret.write.status') {
          return {
            type: 'host.secret.write.status.result',
            requestId: 'credential-restart-status-read',
            resultType: 'completed',
            credentialName: 'sshPassword',
            credentialRef,
            writtenAt: '2026-07-06T00:01:00.000Z',
          };
        }
        throw new Error(`Unexpected credential host request: ${request.type}`);
      },
    });

    const restoredSnapshot = await invokeSnapshot(runtime);
    expect(hostRequests).toEqual([expect.objectContaining({
      type: 'host.secret.write.status',
      input: expect.objectContaining({ operationId, credentialName: 'sshPassword', credentialRef }),
    })]);
    expect(store.state?.credentialWriteOperations).toContainEqual(expect.objectContaining({
      id: operationId,
      state: expect.objectContaining({ reason: 'completed' }),
    }));
    expect(restoredSnapshot.auditEvents.filter((event) => event.eventName === 'remoteFleet.credential.written')).toHaveLength(1);

    const retry = await runtime.invoke('writeCredential', {
      operationId,
      credentialId: 'credential-restart',
      credentialName: 'sshPassword',
      plaintextValue: plaintext,
    });
    expect(retry.status).toBe(200);
    expect(hostRequests).toHaveLength(1);
    const auditEvents = await invokeAuditEventList(runtime);
    expect(auditEvents.filter((event) => event.eventName === 'remoteFleet.credential.written')).toHaveLength(1);
    expectCredentialStateIsSafe(store.state, plaintext);
    expectCredentialStateIsSafe(await invokeSnapshot(runtime), plaintext);
    expectCredentialStateIsSafe(auditEvents, plaintext);
  });

  it('writes credentials through the host seam without persisting plaintext in fleet state', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request) => {
        if (request.type !== 'host.secret.write') {
          throw new Error(`Unexpected host request: ${request.type}`);
        }
        return {
          type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
          requestId: 'secret-write-rpc-1',
          resultType: 'written',
          credentialName: request.input.credentialName,
          credentialRef: { kind: 'secret-ref', ref: `remote-fleet://credentials/${request.input.credentialId}/${request.input.credentialName}` },
          writtenAt: '2026-07-06T00:00:00.000Z',
        };
      },
    });

    const response = await runtime.invoke('writeCredential', {
      operationId: 'credential-write-1',
      credentialId: 'node-secret',
      credentialName: 'sshPassword',
      plaintextValue: 'ssh-secret-password',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-secret/sshPassword' },
      secretRefs: {
        sshPassword: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-secret/sshPassword' },
      },
    });
    expect(hostRequests).toEqual([{
      type: 'host.secret.write',
      input: {
        operationId: 'credential-write-1',
        credentialId: 'node-secret',
        credentialName: 'sshPassword',
        plaintextValue: 'ssh-secret-password',
        nowIso: '2026-07-06T00:00:00.000Z',
      },
    }]);
    const persistedStateText = await readPersistedStateText(runtimeDataRootDir);
    expect(persistedStateText).not.toContain('ssh-secret-password');
    expect(JSON.stringify(await invokeSnapshot(runtime))).not.toContain('ssh-secret-password');
    expect(await invokeAuditEventList(runtime)).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.credential.written' }));
    await runtime.close();
  });

  it('returns node, command, and audit buckets from runtime state', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir });

    await runtime.invoke('register', {
      node: {
        id: 'node-metrics',
        displayName: 'Metrics Node',
        targetKind: 'container',
      },
    });
    const metrics = await invokeMetrics(runtime);

    expect(metrics.nodes.totalCount).toBe(1);
    expect(metrics.nodes.countByStatus.unknown).toBe(1);
    expect(metrics.nodes.countByTargetKind.container).toBe(1);
    expect(metrics.commands.totalCount).toBe(1);
    expect(metrics.commands.countByStatus.succeeded).toBe(1);
    expect(metrics.auditEvents.totalCount).toBe(2);
    expect(metrics.auditEvents.countByEventName['remoteFleet.node.registered']).toBe(1);
    expect(metrics.auditEvents.countByEventName['remoteFleet.command.completed']).toBe(1);
    await runtime.close();
  });

  it('projects only the recent bounded command history in snapshot and listCommands', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const commandRecords = Array.from({ length: 300 }, (_, index) => createCommandRecord(index));
    await writePersistedState(runtimeDataRootDir, {
      version: 1,
      nodes: [],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: commandRecords,
      leases: [],
      auditEvents: [],
    });
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir });

    const snapshot = await invokeSnapshot(runtime);
    const commandList = await invokeCommandList(runtime);
    const newestCommand = commandRecords[commandRecords.length - 1]!;
    const oldestCommand = commandRecords[0]!;
    for (const projection of [snapshot.commands, commandList]) {
      const projectedCreatedAt = projection.map((command) => command.createdAt);
      expect(projection.length).toBeGreaterThan(0);
      expect(projection.length).toBeLessThan(commandRecords.length);
      expect(projection[0]).toEqual(expect.objectContaining({ id: newestCommand.id, createdAt: newestCommand.createdAt }));
      expect(projection).toContainEqual(expect.objectContaining({ id: newestCommand.id }));
      expect(projection).not.toContainEqual(expect.objectContaining({ id: oldestCommand.id }));
      expect(projectedCreatedAt).toEqual([...projectedCreatedAt].sort((left, right) => right.localeCompare(left)));
    }
    expect(commandList.map((command) => command.id)).toEqual(snapshot.commands.map((command) => command.id));
    await runtime.close();
  });

  it('projects only the recent bounded audit event history in snapshot and listAuditEvents', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const auditEventRecords = Array.from({ length: 300 }, (_, index) => createAuditEventRecord(index));
    await writePersistedState(runtimeDataRootDir, {
      version: 1,
      nodes: [],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: [],
      leases: [],
      auditEvents: auditEventRecords,
    });
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir });

    const snapshot = await invokeSnapshot(runtime);
    const auditEventList = await invokeAuditEventList(runtime);
    const newestAuditEvent = auditEventRecords[auditEventRecords.length - 1]!;
    const oldestAuditEvent = auditEventRecords[0]!;
    for (const projection of [snapshot.auditEvents, auditEventList]) {
      const projectedOccurredAt = projection.map((event) => event.occurredAt);
      expect(projection.length).toBeGreaterThan(0);
      expect(projection.length).toBeLessThan(auditEventRecords.length);
      expect(projection[0]).toEqual(expect.objectContaining({ id: newestAuditEvent.id, occurredAt: newestAuditEvent.occurredAt }));
      expect(projection).toContainEqual(expect.objectContaining({ id: newestAuditEvent.id }));
      expect(projection).not.toContainEqual(expect.objectContaining({ id: oldestAuditEvent.id }));
      expect(projectedOccurredAt).toEqual([...projectedOccurredAt].sort((left, right) => right.localeCompare(left)));
    }
    expect(auditEventList.map((event) => event.id)).toEqual(snapshot.auditEvents.map((event) => event.id));
    await runtime.close();
  });

  it('restores registered nodes, agents, and runtimes from FileRemoteFleetStateStore in a new runtime', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const firstRuntime = createRemoteFleetRuntime({ runtimeDataRootDir });

    await firstRuntime.invoke('register', {
      node: {
        id: 'node-persisted',
        displayName: 'Persisted Worker Node',
        targetKind: 'container',
        labels: ['worker', 'production'],
        endpointUrl: 'ssh://worker.example.test',
      },
    });
    await firstRuntime.close();

    const restoredRuntime = createRemoteFleetRuntime({ runtimeDataRootDir });
    const snapshot = await invokeSnapshot(restoredRuntime);

    expect(snapshot.nodes).toEqual([
      expect.objectContaining({
        id: 'node-persisted',
        displayName: 'Persisted Worker Node',
        endpointUrl: 'ssh://worker.example.test',
        labels: ['production', 'worker'],
        status: 'unknown',
      }),
    ]);
    expect(snapshot.agents).toEqual([
      expect.objectContaining({ id: 'node-persisted:agent', nodeId: 'node-persisted', status: 'not-installed' }),
    ]);
    expect(snapshot.runtimes).toEqual([
      expect.objectContaining({ id: 'node-persisted:openclaw', nodeId: 'node-persisted', status: 'stopped' }),
    ]);
    await restoredRuntime.close();
  });

  it('preserves loaded state when a restored runtime closes before any invocation', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const firstRuntime = createRemoteFleetRuntime({ runtimeDataRootDir });

    await firstRuntime.invoke('register', {
      node: { id: 'node-close-without-invoke', displayName: 'Close Without Invoke Node' },
    });
    await firstRuntime.close();

    const restoredWithoutInvoke = createRemoteFleetRuntime({ runtimeDataRootDir });
    await restoredWithoutInvoke.close();

    const verifyingRuntime = createRemoteFleetRuntime({ runtimeDataRootDir });
    const snapshot = await invokeSnapshot(verifyingRuntime);
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'node-close-without-invoke' }));
    expect(snapshot.agents).toContainEqual(expect.objectContaining({
      id: 'node-close-without-invoke:agent',
      nodeId: 'node-close-without-invoke',
    }));
    expect(snapshot.runtimes).toContainEqual(expect.objectContaining({
      id: 'node-close-without-invoke:openclaw',
      nodeId: 'node-close-without-invoke',
    }));
    await verifyingRuntime.close();
  });

  it('scrubs unsafe persisted publicConfig and endpointUrl before projecting or persisting loaded state', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const plaintextSecret = 'Authorization: Bearer persisted-runtime-secret';
    await writePersistedState(runtimeDataRootDir, {
      version: 1,
      nodes: [{
        id: 'node-unsafe-persisted',
        displayName: 'Unsafe Persisted Node',
        targetKind: 'ssh-host',
        endpointUrl: 'https://node.example.test/callback?api_key=persisted-secret',
        labels: [],
        enabled: true,
        publicConfig: { runtimeLaunch: { env: { PROVIDER_AUTH: plaintextSecret } } },
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: [],
      leases: [],
      auditEvents: [],
    });

    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, nowIso: '2026-07-06T00:05:00.000Z' });
    const snapshot = await invokeSnapshot(runtime);
    const persistedStateText = await readPersistedStateText(runtimeDataRootDir);
    const persistedState = JSON.parse(persistedStateText) as { readonly nodes: readonly [{ readonly endpointUrl?: string; readonly publicConfig: Record<string, unknown>; readonly updatedAt: string }]; readonly auditEvents: readonly unknown[] };

    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'node-unsafe-persisted', displayName: 'Unsafe Persisted Node' }));
    expect(snapshot.nodes[0]).not.toHaveProperty('endpointUrl');
    expect(persistedState.nodes[0]).not.toHaveProperty('endpointUrl');
    expect(persistedState.nodes[0].publicConfig).toEqual({});
    expect(persistedState.nodes[0].updatedAt).toBe('2026-07-06T00:05:00.000Z');
    expect(persistedState.auditEvents).toEqual([]);
    expect(persistedStateText).not.toContain('api_key');
    expect(persistedStateText).not.toContain('PROVIDER_AUTH');
    expect(persistedStateText).not.toContain(plaintextSecret);
    await runtime.close();
  });

  it('persists only credential hashes after a bootstrap enrollment heartbeat', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const enrollmentToken = 'mrf_runtime_agent_enrollment_token';
    const ingressCredential = 'runtime-agent-long-lived-credential';
    const bootstrapTokens = new Map<string, string>();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = new RemoteFleetRuntime({
      host: {
        request: async (request) => {
          const capturedRequest = request as RemoteFleetTestHostRequestWithoutId;
          hostRequests.push(capturedRequest);
          captureBootstrapEnrollmentToken(runtimeAgentBootstrapEnrollmentTokens, runtime, capturedRequest);
          if (isRemoteFleetBootstrapHostRequest(capturedRequest)) {
            const enrollment = capturedRequest.envelope.enrollment;
            if (enrollment) {
              bootstrapTokens.set(enrollment.agentId, enrollment.token);
            }
            return {
              resultType: 'completed',
              commandId: capturedRequest.envelope.commandId,
              providerKind: capturedRequest.envelope.providerKind,
            };
          }
          return { resultType: 'accepted', accepted: true };
        },
      },
      store: new FileRemoteFleetStateStore({ runtimeDataRootDir }),
      identity: {
        randomId: (prefix) => `${prefix}-enroll`,
        randomToken: () => enrollmentToken.slice('mrf_'.length),
        hashSecret: async (secret) => `sha256:${createHash('sha256').update(secret).digest('hex')}`,
      },
      clock: { nowIso: () => '2026-07-06T00:00:00.000Z' },
      runtimeAgentIngressUrl: 'https://fleet.example.test/api/remote-fleet/runtime-agent/ingress',
    });

    await runtime.invoke('register', {
      node: {
        id: 'node-enroll',
        displayName: 'Enrollment Node',
        targetKind: 'ssh-host',
        secretRefs: {
          sshPrivateKey: {
            kind: 'secret-ref',
            ref: 'remote-fleet://test/node-enroll/ssh-private-key',
          },
        },
      },
    });
    const issuedEnrollmentToken = await bootstrapRuntimeAgentEnrollment(runtime, 'node-enroll');
    expect(hostRequests).toContainEqual(expect.objectContaining({
      type: 'host.remoteFleetBootstrap.dispatchCommand',
      envelope: expect.objectContaining({
        agentId: 'node-enroll:agent',
        enrollment: expect.objectContaining({
          callbackUrl: 'https://fleet.example.test/api/remote-fleet/runtime-agent/ingress',
        }),
      }),
    }));
    expect(bootstrapTokens.get('node-enroll:agent')).toBe(issuedEnrollmentToken);

    const firstHeartbeat = await ingestRuntimeAgentHeartbeat(runtime, {
      agentId: 'node-enroll:agent',
      requestId: 'heartbeat-enroll',
      authorizationCredential: issuedEnrollmentToken,
      enrollmentCredential: ingressCredential,
    });
    expect(firstHeartbeat.status).toBe(200);
    expect(firstHeartbeat.data).toMatchObject({
      type: 'runtime-agent.heartbeat.response',
      resultType: 'recorded',
      agentId: 'node-enroll:agent',
    });
    const snapshot = await invokeSnapshot(runtime);
    expect(snapshot.agents).toContainEqual(expect.objectContaining({ id: 'node-enroll:agent', status: 'enrolled' }));
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ id: 'node-enroll', status: 'online' }));
    const persistedStateText = await readPersistedStateText(runtimeDataRootDir);
    expect(persistedStateText).not.toContain(enrollmentToken);
    expect(persistedStateText).not.toContain(ingressCredential);
    expect(JSON.stringify(snapshot)).not.toContain(enrollmentToken);
    expect(JSON.stringify(snapshot)).not.toContain(ingressCredential);

    const replay = await ingestRuntimeAgentHeartbeat(runtime, {
      agentId: 'node-enroll:agent',
      requestId: 'heartbeat-replay',
      authorizationCredential: enrollmentToken,
      enrollmentCredential: ingressCredential,
    });
    expect(replay.status).toBe(401);

    const subsequentHeartbeat = await ingestRuntimeAgentHeartbeat(runtime, {
      agentId: 'node-enroll:agent',
      requestId: 'heartbeat-long-lived',
      authorizationCredential: ingressCredential,
    });
    expect(subsequentHeartbeat.status).toBe(200);
    await runtime.close();
  });

  it('rejects expired enrollment credentials and secret-like publicConfig keys', async () => {
    vi.useFakeTimers();
    try {
      const runtimeDataRootDir = await createRuntimeDataRoot();
      const runtime = createRemoteFleetRuntime({ runtimeDataRootDir });

      vi.setSystemTime(new Date('2026-07-06T00:00:00.000Z'));
      const registerResponse = await runtime.invoke('register', {
        node: {
          id: 'node-unsafe-config',
          displayName: 'Unsafe Config Node',
          publicConfig: { runtimeLaunch: { env: { API_TOKEN: 'plaintext-token' } } },
        },
      });
      expect(registerResponse.status).toBe(400);
      expect(JSON.stringify(registerResponse.data)).toContain('publicConfig must not contain plaintext credential key publicConfig.runtimeLaunch.env.API_TOKEN');

      const unsafeValueResponse = await runtime.invoke('register', {
        node: {
          id: 'node-unsafe-config-value',
          displayName: 'Unsafe Config Value Node',
          publicConfig: { runtimeLaunch: { env: { PROVIDER_AUTH: 'Authorization: Bearer runtime-secret' } } },
        },
      });
      expect(unsafeValueResponse.status).toBe(400);
      expect(JSON.stringify(unsafeValueResponse.data)).toContain('publicConfig must not contain plaintext credential key publicConfig.runtimeLaunch.env.PROVIDER_AUTH');

      const unsafeEndpointUrlResponse = await runtime.invoke('register', {
        node: {
          id: 'node-unsafe-endpoint-url',
          displayName: 'Unsafe Endpoint URL Node',
          endpointUrl: 'https://node.example.test/callback?api_key=runtime-secret',
        },
      });
      expect(unsafeEndpointUrlResponse.status).toBe(400);
      expect(JSON.stringify(unsafeEndpointUrlResponse.data)).toContain('endpointUrl must not contain plaintext credential material endpointUrl');

      const enrollmentToken = 'mrf_expired_runtime_agent_token';
      const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
      const runtimeWithEnrollment = new RemoteFleetRuntime({
        host: {
          request: async (request) => {
            const capturedRequest = request as RemoteFleetTestHostRequestWithoutId;
            hostRequests.push(capturedRequest);
            captureBootstrapEnrollmentToken(runtimeAgentBootstrapEnrollmentTokens, runtimeWithEnrollment, capturedRequest);
            if (isRemoteFleetBootstrapHostRequest(capturedRequest)) {
              return {
                resultType: 'completed',
                commandId: capturedRequest.envelope.commandId,
                providerKind: capturedRequest.envelope.providerKind,
              };
            }
            return { resultType: 'accepted', accepted: true };
          },
        },
        store: new FileRemoteFleetStateStore({ runtimeDataRootDir }),
        identity: {
          randomId: (prefix) => `${prefix}-expired`,
          randomToken: () => enrollmentToken.slice('mrf_'.length),
          hashSecret: async (secret) => `sha256:${secret}`,
        },
        clock: { nowIso: () => new Date().toISOString() },
        runtimeAgentIngressUrl: 'https://fleet.example.test/api/remote-fleet/runtime-agent/ingress',
      });
      await runtimeWithEnrollment.invoke('register', {
        node: {
          id: 'node-expired',
          displayName: 'Expired Token Node',
          targetKind: 'ssh-host',
          secretRefs: {
            sshPrivateKey: {
              kind: 'secret-ref',
              ref: 'remote-fleet://test/node-expired/ssh-private-key',
            },
          },
        },
      });
      await bootstrapRuntimeAgentEnrollment(runtimeWithEnrollment, 'node-expired');
      expect(hostRequests).toContainEqual(expect.objectContaining({
        type: 'host.remoteFleetBootstrap.dispatchCommand',
        envelope: expect.objectContaining({ agentId: 'node-expired:agent' }),
      }));

      vi.setSystemTime(new Date('2026-07-06T00:11:00.000Z'));
      const expiredHeartbeatResponse = await ingestRuntimeAgentHeartbeat(runtimeWithEnrollment, {
        agentId: 'node-expired:agent',
        requestId: 'expired-heartbeat',
        authorizationCredential: enrollmentToken,
        enrollmentCredential: 'runtime-agent-candidate-credential',
      });
      expect(expiredHeartbeatResponse.status).toBe(401);
      expect(await invokeSnapshot(runtimeWithEnrollment)).toMatchObject({
        agents: [expect.objectContaining({ id: 'node-expired:agent', status: 'installed' })],
      });
      await runtimeWithEnrollment.close();
      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches queued start-runtime commands to host.runtimeAgent.dispatchCommand without exposing idempotency in projections', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', { node: { id: 'node-dispatch-start', displayName: 'Dispatch Start Node' } });
    const startResponse = await runtime.invoke('start', { runtimeId: 'node-dispatch-start:openclaw' });
    expect(startResponse.status).toBe(202);
    const startData = startResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: { readonly id: string } };
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, startData.command.id);
    const dispatchRequests = hostRequests.filter((request) => request.type === 'host.runtimeAgent.dispatchCommand');

    expect(dispatchRequests).toHaveLength(1);
    expect(dispatchRequests[0]).toEqual(expect.objectContaining({
      type: 'host.runtimeAgent.dispatchCommand',
      envelope: expect.objectContaining({
        commandId: commandRecord.id,
        idempotencyKey: commandRecord.idempotencyKey,
        agentId: 'node-dispatch-start:agent',
        nodeId: 'node-dispatch-start',
        runtimeId: 'node-dispatch-start:openclaw',
        endpointId: 'node-dispatch-start:openclaw:endpoint',
        commandName: 'start-runtime',
        request: expect.objectContaining({ commandId: commandRecord.id, kind: 'start-runtime' }),
      }),
    }));
    expect(startData.snapshot.commands).toContainEqual(expect.objectContaining({ id: commandRecord.id, status: 'queued' }));
    expectCommandSummariesDoNotExposeIdempotencyKey(startData.snapshot, commandRecord.idempotencyKey);
    await runtime.close();
  });

  it('dispatches queued probe-node commands to host.runtimeAgent.dispatchCommand when a RuntimeAgent endpoint exists', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', {
      node: {
        id: 'node-dispatch-probe',
        displayName: 'Dispatch Probe Node',
        publicConfig: {
          runtimeAgent: {
            endpointUrl: 'https://runtime-agent.example.test/command',
          },
        },
        secretRefs: {
          runtimeAgentToken: { kind: 'secret-ref', ref: 'remote-fleet://node-dispatch-probe/runtime-agent-token' },
        },
      },
    });
    const probeResponse = await runtime.invoke('probe', { nodeId: 'node-dispatch-probe' });
    expect(probeResponse.status).toBe(200);
    const probeData = probeResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: { readonly id: string } };
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, probeData.command.id);
    const dispatchRequests = hostRequests.filter((request) => request.type === 'host.runtimeAgent.dispatchCommand');

    expect(dispatchRequests).toHaveLength(1);
    expect(hostRequests).not.toContainEqual(expect.objectContaining({ type: 'host.remoteFleetBootstrap.dispatchCommand' }));
    expect(dispatchRequests[0]).toEqual(expect.objectContaining({
      type: 'host.runtimeAgent.dispatchCommand',
      envelope: expect.objectContaining({
        commandId: commandRecord.id,
        idempotencyKey: commandRecord.idempotencyKey,
        agentId: 'node-dispatch-probe:agent',
        nodeId: 'node-dispatch-probe',
        commandName: 'probe-node',
        dispatchTarget: expect.objectContaining({
          endpointUrl: 'https://runtime-agent.example.test/command',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://node-dispatch-probe/runtime-agent-token' },
        }),
        request: expect.objectContaining({ commandId: commandRecord.id, kind: 'probe-node' }),
      }),
    }));
    expect(probeData.snapshot.commands).toContainEqual(expect.objectContaining({ id: commandRecord.id, status: 'queued' }));
    await runtime.close();
  });

  it('fails start-runtime and degrades the runtime when the host dispatcher is unavailable', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      hostResult: { resultType: 'unavailable', accepted: false },
    });

    await runtime.invoke('register', { node: { id: 'node-no-dispatcher', displayName: 'No Dispatcher Node' } });
    const startResponse = await runtime.invoke('start', { runtimeId: 'node-no-dispatcher:openclaw' });
    expect(startResponse.status).toBe(202);
    const startData = startResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: { readonly id: string } };

    expect(hostRequests).toContainEqual(expect.objectContaining({
      type: 'host.runtimeAgent.dispatchCommand',
      envelope: expect.objectContaining({ commandId: startData.command.id, commandName: 'start-runtime' }),
    }));
    expect(startData.command).toEqual(expect.objectContaining({
      id: startData.command.id,
      command: 'start-runtime',
      status: 'failed',
    }));
    expect(startData.snapshot.commands).toContainEqual(expect.objectContaining({
      id: startData.command.id,
      command: 'start-runtime',
      status: 'failed',
    }));
    expect(startData.snapshot.runtimes).toContainEqual(expect.objectContaining({
      id: 'node-no-dispatcher:openclaw',
      status: 'degraded',
    }));
    await runtime.close();
  });

  it('settles a stale start ACK without overriding the newer stop lifecycle', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });
    const runtimeId = 'node-stale-start-ack:openclaw';
    const endpointId = `${runtimeId}:endpoint`;

    await runtime.invoke('register', { node: { id: 'node-stale-start-ack', displayName: 'Stale Start ACK Node' } });
    const startResponse = await runtime.invoke('start', { runtimeId });
    const startData = startResponse.data as { readonly command: { readonly id: string } };
    const startCommand = await readPersistedCommandRecord(runtimeDataRootDir, startData.command.id);

    const stopResponse = await runtime.invoke('stop', { runtimeId });
    const stopData = stopResponse.data as { readonly command: { readonly id: string } };
    const stopCommand = await readPersistedCommandRecord(runtimeDataRootDir, stopData.command.id);

    const staleStartAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: startCommand.id,
      agentId: 'node-stale-start-ack:agent',
      idempotencyKey: startCommand.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:00:00.000Z' },
    });
    expect(staleStartAckResponse.status).toBe(200);
    const staleStartAckSnapshot = (staleStartAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(staleStartAckSnapshot.commands).toContainEqual(expect.objectContaining({ id: startCommand.id, status: 'succeeded' }));
    expect(staleStartAckSnapshot.runtimes).toContainEqual(expect.objectContaining({ id: runtimeId, status: 'stopping' }));
    expect((await readPersistedState(runtimeDataRootDir)).runtimes).toContainEqual(expect.objectContaining({
      id: runtimeId,
      lifecycle: { reason: 'stopping', commandId: stopCommand.id },
    }));
    expect(staleStartAckSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'draining' }));
    expect(staleStartAckSnapshot.auditEvents).not.toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.runtime.started',
      commandId: startCommand.id,
    }));

    const stopAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: stopCommand.id,
      agentId: 'node-stale-start-ack:agent',
      idempotencyKey: stopCommand.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:01:00.000Z' },
    });
    expect(stopAckResponse.status).toBe(200);
    expect((stopAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot.runtimes).toContainEqual(expect.objectContaining({
      id: runtimeId,
      status: 'stopped',
    }));
    await runtime.close();
  });

  it('settles a stale stop ACK without overriding the newer restart lifecycle', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });
    const runtimeId = 'node-stale-stop-ack:openclaw';
    const endpointId = `${runtimeId}:endpoint`;

    await runtime.invoke('register', { node: { id: 'node-stale-stop-ack', displayName: 'Stale Stop ACK Node' } });
    const initialStartResponse = await runtime.invoke('start', { runtimeId });
    const initialStartData = initialStartResponse.data as { readonly command: { readonly id: string } };
    const initialStartCommand = await readPersistedCommandRecord(runtimeDataRootDir, initialStartData.command.id);
    await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: initialStartCommand.id,
      agentId: 'node-stale-stop-ack:agent',
      idempotencyKey: initialStartCommand.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:00:00.000Z' },
    });

    const stopResponse = await runtime.invoke('stop', { runtimeId });
    const stopData = stopResponse.data as { readonly command: { readonly id: string } };
    const stopCommand = await readPersistedCommandRecord(runtimeDataRootDir, stopData.command.id);
    const restartResponse = await runtime.invoke('start', { runtimeId });
    const restartData = restartResponse.data as { readonly command: { readonly id: string } };
    const restartCommand = await readPersistedCommandRecord(runtimeDataRootDir, restartData.command.id);

    const staleStopAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: stopCommand.id,
      agentId: 'node-stale-stop-ack:agent',
      idempotencyKey: stopCommand.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:01:00.000Z' },
    });
    expect(staleStopAckResponse.status).toBe(200);
    const staleStopAckSnapshot = (staleStopAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(staleStopAckSnapshot.commands).toContainEqual(expect.objectContaining({ id: stopCommand.id, status: 'succeeded' }));
    expect(staleStopAckSnapshot.runtimes).toContainEqual(expect.objectContaining({ id: runtimeId, status: 'starting' }));
    expect((await readPersistedState(runtimeDataRootDir)).runtimes).toContainEqual(expect.objectContaining({
      id: runtimeId,
      lifecycle: { reason: 'starting', commandId: restartCommand.id },
    }));
    expect(staleStopAckSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'unknown' }));
    expect(staleStopAckSnapshot.leases).toContainEqual(expect.objectContaining({
      endpointId,
      ownerKind: 'runtime-start',
      ownerId: restartCommand.id,
      status: 'active',
    }));
    expect(staleStopAckSnapshot.auditEvents).not.toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.runtime.stopped',
      commandId: stopCommand.id,
    }));

    const restartAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: restartCommand.id,
      agentId: 'node-stale-stop-ack:agent',
      idempotencyKey: restartCommand.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:02:00.000Z' },
    });
    expect(restartAckResponse.status).toBe(200);
    expect((restartAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot.runtimes).toContainEqual(expect.objectContaining({
      id: runtimeId,
      status: 'running',
    }));
    await runtime.close();
  });

  it('records endpoint, capability, lease, and audit state across start, sync, drain, and retire', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', {
      node: {
        id: 'node-lifecycle',
        displayName: 'Lifecycle Node',
        targetKind: 'ssh-host',
        publicConfig: {
          runtimeLaunch: {
            secretEnv: { ANTHROPIC_API_KEY: 'anthropicApiKey' },
          },
        },
        secretRefs: {
          anthropicApiKey: { kind: 'secret-ref', ref: 'vault://remote-fleet/node-lifecycle/anthropic' },
          sshPrivateKey: { kind: 'secret-ref', ref: 'vault://remote-fleet/node-lifecycle/ssh-private-key' },
        },
      },
    });
    await enrollRuntimeAgent(runtime, 'node-lifecycle');
    const initialSnapshot = await invokeSnapshot(runtime);
    const runtimeId = initialSnapshot.runtimes[0]?.id;
    expect(runtimeId).toBe('node-lifecycle:openclaw');

    const startResponse = await runtime.invoke('start', { runtimeId });
    expect(startResponse.status).toBe(202);
    const queuedStartSnapshot = (startResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    const endpointId = queuedStartSnapshot.endpoints[0]?.id;
    const startCommandId = (startResponse.data as { readonly command: { readonly id: string } }).command.id;
    expect(endpointId).toBe('node-lifecycle:openclaw:endpoint');
    expect(queuedStartSnapshot.runtimes).toContainEqual(expect.objectContaining({ id: runtimeId, status: 'starting', endpointId }));
    expect(queuedStartSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'unknown', protocol: 'remote-fleet' }));
    expect(queuedStartSnapshot.leases).toContainEqual(expect.objectContaining({ endpointId, ownerKind: 'runtime-start', status: 'active' }));
    expect(queuedStartSnapshot.capabilities).toEqual([]);
    expect(hostRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'host.capability.pruneEndpointScope',
        scope: expect.objectContaining({ kind: 'runtime-instance' }),
      }),
    ]));
    expect(queuedStartSnapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.command.queued', runtimeId, endpointId }));
    expect(hostRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'host.runtimeAgent.dispatchCommand',
        envelope: expect.objectContaining({ commandId: startCommandId, commandName: 'start-runtime' }),
      }),
    ]));

    const startCommandRecord = await readPersistedCommandRecord(runtimeDataRootDir, startCommandId);
    const startAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: startCommandId,
      agentId: 'node-lifecycle:agent',
      idempotencyKey: startCommandRecord.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:00:00.000Z' },
    });
    expect(startAckResponse.status).toBe(200);
    const startedSnapshot = (startAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(startedSnapshot.runtimes).toContainEqual(expect.objectContaining({ id: runtimeId, status: 'running', endpointId }));
    expect(startedSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'ready', protocol: 'remote-fleet' }));
    expect(startedSnapshot.capabilities).toContainEqual(expect.objectContaining({
      endpointId,
      runtimeId,
      operationIds: ['remoteFleet.capabilities.sync', 'remoteFleet.runtime.start', 'remoteFleet.runtime.status', 'remoteFleet.runtime.stop'],
      status: 'current',
    }));
    expect(hostRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'host.capability.replaceForEndpointScope',
        descriptors: [expect.objectContaining({
          id: 'remote-fleet.runtime-control',
          scopeKind: 'runtime-instance',
          ownerModuleId: 'remote-fleet',
          routeOwnerId: 'remote-fleet',
        })],
      }),
    ]));
    expect(startedSnapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.runtime.started', runtimeId, endpointId }));

    const syncResponse = await runtime.invoke('sync', { runtimeId });
    expect(syncResponse.status).toBe(200);
    const syncedSnapshot = (syncResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(syncedSnapshot.capabilities).toContainEqual(expect.objectContaining({
      endpointId,
      runtimeId,
      operationIds: ['remoteFleet.capabilities.sync', 'remoteFleet.runtime.start', 'remoteFleet.runtime.status', 'remoteFleet.runtime.stop'],
      status: 'current',
    }));
    expect(hostRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'host.capability.replaceForEndpointScope',
        descriptors: [expect.objectContaining({
          id: 'remote-fleet.runtime-control',
          scopeKind: 'runtime-instance',
          ownerModuleId: 'remote-fleet',
          routeOwnerId: 'remote-fleet',
        })],
      }),
    ]));
    expect(syncedSnapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.endpoint.capabilitiesSynced', runtimeId, endpointId }));

    const stopResponse = await runtime.invoke('stop', { runtimeId });
    expect(stopResponse.status).toBe(202);
    const queuedStopSnapshot = (stopResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    const stopCommandId = (stopResponse.data as { readonly command: { readonly id: string } }).command.id;
    expect(queuedStopSnapshot.runtimes).toContainEqual(expect.objectContaining({ id: runtimeId, status: 'stopping', endpointId }));
    expect(queuedStopSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'draining' }));
    expect(queuedStopSnapshot.capabilities).toContainEqual(expect.objectContaining({ endpointId, status: 'pruned' }));
    expect(hostRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'host.runtimeAgent.dispatchCommand',
        envelope: expect.objectContaining({ commandId: stopCommandId, commandName: 'stop-runtime' }),
      }),
    ]));

    const stopCommandRecord = await readPersistedCommandRecord(runtimeDataRootDir, stopCommandId);
    const stopAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: stopCommandId,
      agentId: 'node-lifecycle:agent',
      idempotencyKey: stopCommandRecord.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:01:00.000Z' },
    });
    expect(stopAckResponse.status).toBe(200);
    const stoppedSnapshot = (stopAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(stoppedSnapshot.runtimes).toContainEqual(expect.objectContaining({ id: runtimeId, status: 'stopped', endpointId }));
    expect(stoppedSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'retired' }));
    expect(stoppedSnapshot.leases).toContainEqual(expect.objectContaining({ endpointId, ownerKind: 'runtime-start', status: 'released' }));
    expect(stoppedSnapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.runtime.stopped', runtimeId, endpointId }));

    const restartResponse = await runtime.invoke('start', { runtimeId });
    expect(restartResponse.status).toBe(202);
    const restartCommandId = (restartResponse.data as { readonly command: { readonly id: string } }).command.id;
    const restartCommandRecord = await readPersistedCommandRecord(runtimeDataRootDir, restartCommandId);
    await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: restartCommandId,
      agentId: 'node-lifecycle:agent',
      idempotencyKey: restartCommandRecord.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:02:00.000Z' },
    });

    const drainResponse = await runtime.invoke('drainEndpoint', { endpointId });
    expect(drainResponse.status).toBe(200);
    const drainedSnapshot = (drainResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(drainedSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'draining' }));
    expect(drainedSnapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.endpoint.drained', runtimeId, endpointId }));

    const retireResponse = await runtime.invoke('retireEndpoint', { endpointId });
    expect(retireResponse.status).toBe(200);
    const retiredSnapshot = (retireResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(retiredSnapshot.endpoints).toContainEqual(expect.objectContaining({ id: endpointId, status: 'retired' }));
    expect(hostRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'host.capability.pruneEndpointScope',
        scope: expect.objectContaining({ kind: 'runtime-instance' }),
      }),
    ]));
    expect(retiredSnapshot.leases).toContainEqual(expect.objectContaining({ endpointId, ownerKind: 'runtime-start', status: 'released' }));
    expect(retiredSnapshot.auditEvents).toContainEqual(expect.objectContaining({ eventName: 'remoteFleet.endpoint.retired', runtimeId, endpointId }));
    expect(retiredSnapshot.commands.map((command) => command.command)).toEqual(expect.arrayContaining([
      'register-node',
      'start-runtime',
      'sync-capabilities',
      'drain-endpoint',
      'retire-endpoint',
    ]));
    await runtime.close();
  });

  it('passes the linked Docker environment to terminal ticket issuance without persisting its configuration', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request) => {
        if (request.type === 'host.remoteFleetTerminal.issueTicket') {
          return {
            type: REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
            requestId: 'docker-environment-terminal-ticket',
            resultType: 'issued',
            terminalConnection: {
              sessionId: request.input.session.id,
              ticket: 'docker-environment-terminal-ticket',
              websocketPath: `/api/remote-fleet/terminal/stream?sessionId=${request.input.session.id}&ticket=docker-environment-terminal-ticket`,
              expiresAt: '2026-07-06T00:00:30.000Z',
            },
          };
        }
        return { resultType: 'accepted', accepted: true };
      },
    });

    await runtime.invoke('registerConnection', {
      connection: {
        id: 'connection-docker-terminal',
        connectionKind: 'container',
        publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376' } },
      },
    });
    await runtime.invoke('registerEnvironment', {
      environment: {
        id: 'environment-docker-terminal',
        connectionId: 'connection-docker-terminal',
        environmentKind: 'docker-container',
        publicConfig: { docker: { containerName: 'environment-terminal-container' } },
      },
    });
    const startResponse = await runtime.invoke('start', { runtimeId: 'environment-docker-terminal:node:openclaw' });
    const startCommandId = (startResponse.data as { readonly command: { readonly id: string } }).command.id;
    const startCommandRecord = await readPersistedCommandRecord(runtimeDataRootDir, startCommandId);
    const startResult = await ingestRuntimeAgentCommandResult(runtime, {
      commandId: startCommandId,
      agentId: 'environment-docker-terminal:node:agent',
      idempotencyKey: startCommandRecord.idempotencyKey,
      authorizationCredential: '',
      requestId: 'docker-environment-start-result',
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:00:00.000Z' },
    });
    expect(startResult.status).toBe(401);
    hostRequests.length = 0;

    const openResponse = await runtime.invoke('openTerminalSession', {
      endpointId: 'environment-docker-terminal:node:openclaw:endpoint',
    });

    expect(openResponse.status).toBe(200);
    expect(hostRequests).toContainEqual(expect.objectContaining({
      type: 'host.remoteFleetTerminal.issueTicket',
      input: expect.objectContaining({
        environment: expect.objectContaining({
          id: 'environment-docker-terminal',
          publicConfig: { docker: { containerName: 'environment-terminal-container' } },
        }),
      }),
    }));
    expect(JSON.stringify(openResponse.data)).not.toContain('environment-terminal-container');
    expect(JSON.stringify(await invokeSnapshot(runtime))).not.toContain('environment-terminal-container');
    await runtime.close();
  });

  it('opens, reconnects, closes, and lists terminal sessions through the host seam without persisting tickets', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request) => {
        if (request.type === 'host.remoteFleetTerminal.issueTicket') {
          return {
            type: REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
            requestId: 'terminal-ticket-rpc-1',
            resultType: 'issued',
            terminalConnection: {
              sessionId: request.input.session.id,
              ticket: `terminal-ticket-${request.input.reason}`,
              websocketPath: `/api/remote-fleet/terminal/stream?sessionId=${request.input.session.id}&ticket=terminal-ticket-${request.input.reason}`,
              expiresAt: '2026-07-06T00:00:30.000Z',
            },
          };
        }
        if (request.type === 'host.remoteFleetTerminal.closeSession') {
          return {
            type: 'host.remoteFleetTerminal.closeSession.result',
            requestId: 'terminal-close-rpc-1',
            resultType: 'closed',
          };
        }
        return { resultType: 'accepted', accepted: true };
      },
    });

    await runtime.invoke('register', { node: { id: 'node-terminal', displayName: 'Terminal Node' } });
    const startResponse = await runtime.invoke('start', { runtimeId: 'node-terminal:openclaw' });
    const startCommandId = (startResponse.data as { readonly command: { readonly id: string } }).command.id;
    const startCommandRecord = await readPersistedCommandRecord(runtimeDataRootDir, startCommandId);
    await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId: startCommandId,
      agentId: 'node-terminal:agent',
      idempotencyKey: startCommandRecord.idempotencyKey,
      result: { reason: 'succeeded', completedAt: '2026-07-06T00:00:00.000Z' },
    });
    hostRequests.length = 0;

    const openResponse = await runtime.invoke('openTerminalSession', { endpointId: 'node-terminal:openclaw:endpoint' });

    expect(openResponse.status).toBe(200);
    const openData = openResponse.data as {
      readonly session: { readonly id: string; readonly status: string; readonly endpointId?: string };
      readonly terminalConnection: { readonly sessionId: string; readonly ticket: string; readonly websocketPath: string; readonly expiresAt: string };
    };
    expect(openData.session).toEqual(expect.objectContaining({ status: 'connected', endpointId: 'node-terminal:openclaw:endpoint' }));
    expect(openData.terminalConnection).toEqual(expect.objectContaining({
      sessionId: openData.session.id,
      ticket: 'terminal-ticket-open',
      expiresAt: '2026-07-06T00:00:30.000Z',
    }));
    expect(hostRequests).toContainEqual(expect.objectContaining({
      type: 'host.remoteFleetTerminal.issueTicket',
      input: expect.objectContaining({
        reason: 'open',
        session: expect.objectContaining({ id: openData.session.id, status: 'opening' }),
      }),
    }));

    const reconnectResponse = await runtime.invoke('reconnectTerminalSession', { sessionId: openData.session.id });
    expect(reconnectResponse.status).toBe(200);
    expect((reconnectResponse.data as { readonly terminalConnection: { readonly ticket: string } }).terminalConnection.ticket).toBe('terminal-ticket-reconnect');

    const listResponse = await runtime.invoke('listTerminalSessions', {});
    expect(listResponse.status).toBe(200);
    expect((listResponse.data as { readonly sessions: readonly unknown[] }).sessions).toContainEqual(expect.objectContaining({
      id: openData.session.id,
      status: 'connected',
      endpointId: 'node-terminal:openclaw:endpoint',
    }));

    const closeResponse = await runtime.invoke('closeTerminalSession', { sessionId: openData.session.id });
    expect(closeResponse.status).toBe(200);
    expect(closeResponse.data).toEqual({ session: expect.objectContaining({ id: openData.session.id, status: 'closed' }) });
    expect(hostRequests).toContainEqual(expect.objectContaining({
      type: 'host.remoteFleetTerminal.closeSession',
      input: expect.objectContaining({ session: expect.objectContaining({ id: openData.session.id, status: 'closing' }) }),
    }));

    const snapshot = await invokeSnapshot(runtime);
    expect(snapshot.sessions).toContainEqual(expect.objectContaining({ id: openData.session.id, status: 'closed' }));
    expect(JSON.stringify(snapshot)).not.toContain('terminal-ticket-open');
    expect(JSON.stringify(snapshot)).not.toContain('terminal-ticket-reconnect');
    const persistedStateText = await readPersistedStateText(runtimeDataRootDir);
    expect(persistedStateText).not.toContain('terminal-ticket-open');
    expect(persistedStateText).not.toContain('terminal-ticket-reconnect');
    expect(persistedStateText).not.toContain('stdout');
    expect(persistedStateText).not.toContain('stderr');
    await runtime.close();
  });

  it('expires restored live terminal sessions and releases only their session leases', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    await writePersistedState(runtimeDataRootDir, {
      version: 1,
      nodes: [{
        id: 'node-restored-terminal',
        displayName: 'Restored Terminal Node',
        targetKind: 'container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }],
      agents: [],
      runtimes: [],
      endpoints: [{
        id: 'endpoint-restored-terminal',
        nodeId: 'node-restored-terminal',
        runtimeId: 'runtime-restored-terminal',
        endpointRef: { kind: 'native-runtime', runtimeAdapterId: 'remote-fleet', runtimeInstanceId: 'runtime-restored-terminal' },
        scope: { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'remote-fleet', runtimeInstanceId: 'runtime-restored-terminal' } },
        protocol: 'remote-fleet',
        labels: [],
        health: { reason: 'ready', lastProbeAt: '2026-07-06T00:00:00.000Z' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }],
      capabilities: [],
      commands: [],
      leases: [{
        id: 'lease-terminal-session',
        endpointId: 'endpoint-restored-terminal',
        ownerKind: 'session',
        ownerId: 'terminal-session-restored',
        state: { reason: 'active', acquiredAt: '2026-07-06T00:00:00.000Z', expiresAt: '2026-07-06T01:00:00.000Z' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }, {
        id: 'lease-runtime-start',
        endpointId: 'endpoint-restored-terminal',
        ownerKind: 'runtime-start',
        ownerId: 'cmd-runtime-start',
        state: { reason: 'active', acquiredAt: '2026-07-06T00:00:00.000Z', expiresAt: '2026-07-06T01:00:00.000Z' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }],
      sessions: [{
        id: 'terminal-session-restored',
        nodeId: 'node-restored-terminal',
        runtimeId: 'runtime-restored-terminal',
        endpointId: 'endpoint-restored-terminal',
        targetKind: 'container',
        state: { reason: 'connected', connectedAt: '2026-07-06T00:00:00.000Z' },
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
        leaseId: 'lease-terminal-session',
      }],
      auditEvents: [],
    });
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, nowIso: '2026-07-06T00:10:00.000Z' });

    const snapshot = await invokeSnapshot(runtime);
    const persistedState = await readPersistedState(runtimeDataRootDir);

    expect(snapshot.sessions).toContainEqual(expect.objectContaining({
      id: 'terminal-session-restored',
      status: 'expired',
      reason: 'Remote Fleet terminal session expired during runtime restore.',
    }));
    expect(persistedState.sessions).toContainEqual(expect.objectContaining({
      id: 'terminal-session-restored',
      state: expect.objectContaining({ reason: 'expired' }),
    }));
    expect(persistedState.leases).toContainEqual(expect.objectContaining({
      id: 'lease-terminal-session',
      state: expect.objectContaining({ reason: 'released' }),
    }));
    expect(persistedState.leases).toContainEqual(expect.objectContaining({
      id: 'lease-runtime-start',
      state: expect.objectContaining({ reason: 'active' }),
    }));
    await runtime.close();
  });

  it('rejects terminal open for custom nodes without an endpoint', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', { node: { id: 'node-terminal-custom', displayName: 'Custom Terminal Node', targetKind: 'custom' } });
    const response = await runtime.invoke('openTerminalSession', { nodeId: 'node-terminal-custom' });

    expectBadRequest(response, 'Remote Fleet custom terminal sessions require an endpoint so the provider can validate capability.');
    expect(hostRequests).toEqual([]);
    await runtime.close();
  });

  it('dispatches the terminal session routes to the Remote Fleet service', async () => {
    const invoke = vi.fn(async () => ({ status: 200, data: { sessions: [] } }));

    const openResponse = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'POST',
      '/api/remote-fleet/terminal/open',
      { endpointId: 'endpoint-route-terminal' },
      { remoteFleetService: { invoke } },
    );
    const listResponse = await dispatchRuntimeRouteDefinition(
      remoteFleetRoutes,
      'GET',
      '/api/remote-fleet/terminal/sessions',
      {},
      { remoteFleetService: { invoke } },
    );

    expect(openResponse).toEqual({ status: 200, data: { sessions: [] } });
    expect(listResponse).toEqual({ status: 200, data: { sessions: [] } });
    expect(invoke).toHaveBeenNthCalledWith(1, 'openTerminalSession', { endpointId: 'endpoint-route-terminal' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'listTerminalSessions', {});
  });

  it('syncs capabilities only for the targeted runtime endpoint', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', { node: { id: 'node-sync-a', displayName: 'Sync Node A' } });
    await runtime.invoke('register', { node: { id: 'node-sync-b', displayName: 'Sync Node B' } });
    await runtime.invoke('start', { runtimeId: 'node-sync-a:openclaw' });
    await runtime.invoke('start', { runtimeId: 'node-sync-b:openclaw' });
    hostRequests.length = 0;

    const syncResponse = await runtime.invoke('sync', { runtimeId: 'node-sync-a:openclaw' });

    expect(syncResponse.status).toBe(200);
    const syncData = syncResponse.data as {
      readonly snapshot: RemoteFleetSnapshot;
      readonly commands: readonly RemoteFleetCommandSummary[];
    };
    expect(syncData.commands).toHaveLength(1);
    expect(syncData.commands[0]).toEqual(expect.objectContaining({
      command: 'sync-capabilities',
      runtimeId: 'node-sync-a:openclaw',
      endpointId: 'node-sync-a:openclaw:endpoint',
    }));
    expect(syncData.snapshot.capabilities).toContainEqual(expect.objectContaining({
      runtimeId: 'node-sync-a:openclaw',
      endpointId: 'node-sync-a:openclaw:endpoint',
      status: 'current',
    }));
    expect(syncData.snapshot.capabilities).not.toContainEqual(expect.objectContaining({ runtimeId: 'node-sync-b:openclaw' }));
    expect(syncData.snapshot.auditEvents).toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.endpoint.capabilitiesSynced',
      runtimeId: 'node-sync-a:openclaw',
      endpointId: 'node-sync-a:openclaw:endpoint',
    }));
    expect(syncData.snapshot.auditEvents).not.toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.endpoint.capabilitiesSynced',
      runtimeId: 'node-sync-b:openclaw',
    }));
    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0]).toEqual(expect.objectContaining({
      type: 'host.capability.replaceForEndpointScope',
      scope: expect.objectContaining({
        kind: 'runtime-instance',
        endpoint: expect.objectContaining({ runtimeInstanceId: 'node-sync-a:openclaw' }),
      }),
    }));
    await runtime.close();
  });
});

describe('RemoteFleetRuntime bootstrap install/probe behavior', () => {
  it.each([
    { targetKind: 'ssh-host' as const, providerKind: 'ssh' as const, secretRefs: { sshPrivateKey: { kind: 'secret-ref' as const, ref: 'vault://remote-fleet/node-bootstrap-ssh/ssh-private-key' } }, expectedAgentStatus: 'installed', expectedCommandMessage: 'RuntimeAgent install completed.' },
    { targetKind: 'vm' as const, providerKind: 'ssh' as const, secretRefs: { sshPassword: { kind: 'secret-ref' as const, ref: 'remote-fleet://credentials/node-bootstrap-vm/sshPassword' } }, expectedAgentStatus: 'installed', expectedCommandMessage: 'RuntimeAgent install completed.' },
    { targetKind: 'container' as const, providerKind: 'docker' as const, secretRefs: {}, expectedAgentStatus: 'environment-ready', expectedCommandMessage: 'Docker environment bootstrap completed.' },
    { targetKind: 'k8s-pod' as const, providerKind: 'k8s' as const, secretRefs: {}, expectedAgentStatus: 'installed', expectedCommandMessage: 'RuntimeAgent install completed.' },
  ])('dispatches $targetKind install-agent through the bootstrap host seam and closes succeeded state', async ({ targetKind, providerKind, secretRefs, expectedAgentStatus, expectedCommandMessage }) => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const nodeId = `node-bootstrap-${providerKind}`;
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
        expect(request.type).toBe('host.remoteFleetBootstrap.dispatchCommand');
        const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
        return {
          resultType: 'completed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          message: 'Bootstrap install completed.',
        };
      },
    });

    const registerResponse = await runtime.invoke('register', {
      node: {
        id: nodeId,
        displayName: `Bootstrap ${providerKind} Node`,
        targetKind,
        publicConfig: {
          runtimeLaunch: {
            secretEnv: { PROVIDER_API_KEY: 'providerApiKey' },
          },
          ...(providerKind === 'docker'
            ? {
                docker: {
                  endpointUrl: 'https://docker.example.internal:2376',
                  containerName: 'matchaclaw-debian-node-1',
                  image: 'debian:bookworm-slim',
                  imageCandidates: [
                    'docker.m.daocloud.io/library/debian:bookworm-slim',
                    'debian:bookworm-slim',
                  ],
                },
              }
            : {}),
        },
        secretRefs: {
          ...secretRefs,
          providerApiKey: { kind: 'secret-ref', ref: `vault://remote-fleet/${nodeId}/provider-api-key` },
        },
      },
    });
    expect(registerResponse.status).toBe(200);
    hostRequests.length = 0;

    const installResponse = await runtime.invoke('installAgent', { nodeId });

    expect(installResponse.status).toBe(202);
    const installData = installResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: RemoteFleetCommandSummary };
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, installData.command.id);
    const bootstrapRequests = expectBootstrapDispatchRequests(hostRequests, 1);
    expectSafeBootstrapEnvelope(bootstrapRequests[0].envelope, {
      commandId: commandRecord.id,
      commandName: 'install-agent',
      providerKind,
      nodeId,
      agentId: `${nodeId}:agent`,
    });
    expect(bootstrapRequests[0].envelope.node.publicConfig).toEqual({
      runtimeLaunch: { secretEnv: { PROVIDER_API_KEY: 'providerApiKey' } },
      ...(providerKind === 'docker'
        ? {
            docker: {
              endpointUrl: 'https://docker.example.internal:2376',
              containerName: 'matchaclaw-debian-node-1',
              image: 'debian:bookworm-slim',
              imageCandidates: [
                'docker.m.daocloud.io/library/debian:bookworm-slim',
                'debian:bookworm-slim',
              ],
            },
          }
        : {}),
    });
    expect(bootstrapRequests[0].envelope.node.secretRefs).toEqual({
      ...secretRefs,
      providerApiKey: { kind: 'secret-ref', ref: `vault://remote-fleet/${nodeId}/provider-api-key` },
    });
    if (providerKind === 'docker') {
      expect(bootstrapRequests[0].envelope.enrollment).toBeUndefined();
    } else {
      expect(bootstrapRequests[0].envelope.enrollment).toEqual(expect.objectContaining({
        agentId: `${nodeId}:agent`,
        nodeId,
        token: BOOTSTRAP_ENROLLMENT_SECRET_TOKEN,
        expiresAt: '2026-07-06T00:10:00.000Z',
      }));
    }
    expect(installData.snapshot.commands).toContainEqual(expect.objectContaining({
      id: commandRecord.id,
      command: 'install-agent',
      status: 'succeeded',
      message: expectedCommandMessage,
    }));
    expect(installData.snapshot.agents).toContainEqual(expect.objectContaining({
      id: `${nodeId}:agent`,
      nodeId,
      status: expectedAgentStatus,
    }));
    await expectEnrollmentTokenNotLeaked({
      runtimeDataRootDir,
      token: BOOTSTRAP_ENROLLMENT_SECRET_TOKEN,
      snapshot: installData.snapshot,
      command: installData.command,
    });
    await runtime.close();
  });

  it('dispatches probe-node through the bootstrap host seam and closes node health from the bootstrap result', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
        expect(request.type).toBe('host.remoteFleetBootstrap.dispatchCommand');
        const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
        return {
          resultType: 'completed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          message: 'Bootstrap probe completed.',
        };
      },
    });

    await runtime.invoke('register', {
      node: {
        id: 'node-bootstrap-probe',
        displayName: 'Bootstrap Probe Node',
        targetKind: 'container',
        publicConfig: { docker: { context: 'default' } },
        secretRefs: {},
      },
    });
    hostRequests.length = 0;

    const probeResponse = await runtime.invoke('probe', { nodeId: 'node-bootstrap-probe' });

    expect(probeResponse.status).toBe(200);
    const probeData = probeResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: RemoteFleetCommandSummary };
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, probeData.command.id);
    const bootstrapRequests = expectBootstrapDispatchRequests(hostRequests, 1);
    expectSafeBootstrapEnvelope(bootstrapRequests[0].envelope, {
      commandId: commandRecord.id,
      commandName: 'probe-node',
      providerKind: 'docker',
      nodeId: 'node-bootstrap-probe',
      agentId: 'node-bootstrap-probe:agent',
    });
    expect(bootstrapRequests[0].envelope).not.toHaveProperty('enrollment');
    expect(probeData.snapshot.commands).toContainEqual(expect.objectContaining({
      id: commandRecord.id,
      command: 'probe-node',
      status: 'succeeded',
    }));
    expect(probeData.snapshot.nodes).toContainEqual(expect.objectContaining({
      id: 'node-bootstrap-probe',
      status: 'online',
    }));
    await runtime.close();
  });

  it('probes a Docker connection through the connection-only host RPC and leaves node health unchanged', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request) => {
        expect(request.type).toBe('host.remoteFleetConnectionProbe.dispatch');
        return {
          resultType: 'completed' as const,
          commandId: (request as RemoteFleetConnectionProbeHostRequestWithoutId).envelope.commandId,
          providerKind: 'docker' as const,
        };
      },
    });
    const connectionId = 'connection-probe-docker';
    const nodeId = 'node-probe-must-stay-unknown';

    await runtime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        displayName: 'Docker probe connection',
        connectionKind: 'container',
        publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376' } },
        secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connections/docker-probe/bearer' } },
      },
    });
    await runtime.invoke('register', {
      node: {
        id: nodeId,
        connectionId,
        displayName: 'Unrelated node health sentinel',
        targetKind: 'container',
      },
    });
    hostRequests.length = 0;

    const probeResponse = await (runtime as RemoteFleetRuntimeWithConnectionProbe).invoke('probeConnection', { connectionId });

    expect(probeResponse.status).toBe(200);
    const probeData = probeResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: RemoteFleetCommandSummary };
    const probeRequest = hostRequests.filter(isRemoteFleetConnectionProbeHostRequest);
    expect(probeRequest).toHaveLength(1);
    expect(hostRequests).not.toContainEqual(expect.objectContaining({ type: 'host.remoteFleetBootstrap.dispatchCommand' }));
    expect(hostRequests).not.toContainEqual(expect.objectContaining({ type: 'host.runtimeAgent.dispatchCommand' }));
    const envelope = probeRequest[0].envelope;
    expect(envelope).toEqual({
      envelopeVersion: REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION,
      commandId: probeData.command.id,
      idempotencyKey: expect.any(String),
      providerKind: 'docker',
      connection: expect.objectContaining({
        id: connectionId,
        connectionKind: 'container',
        publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376' } },
        secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connections/docker-probe/bearer' } },
      }),
    });
    expect(envelope).not.toHaveProperty('node');
    expect(envelope).not.toHaveProperty('nodeId');
    expect(envelope).not.toHaveProperty('agent');
    expect(envelope).not.toHaveProperty('agentId');
    expect(JSON.stringify(envelope)).not.toContain(nodeId);
    expect(probeData.snapshot.connections).toContainEqual(expect.objectContaining({
      id: connectionId,
      status: 'online',
      lastSeenAt: '2026-07-06T00:00:00.000Z',
    }));
    expect(probeData.snapshot.nodes).toContainEqual(expect.objectContaining({ id: nodeId, status: 'unknown' }));
    expect(probeData.command).toEqual(expect.objectContaining({
      id: envelope.commandId,
      connectionId,
      status: 'succeeded',
    }));
    const persistedCommand = await readPersistedCommandRecord(runtimeDataRootDir, envelope.commandId);
    expect(persistedCommand).toEqual(expect.objectContaining({ connectionId }));
    expect(persistedCommand).not.toHaveProperty('nodeId');
    expect(persistedCommand).not.toHaveProperty('agentId');
    expect(await readPersistedConnectionRecord(runtimeDataRootDir, connectionId)).toEqual(expect.objectContaining({
      health: { reason: 'online', lastSeenAt: '2026-07-06T00:00:00.000Z' },
    }));
    await runtime.close();
  });

  it('records a token-bearing connection probe failure as a redacted offline connection without changing node health', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const providerToken = 'docker-provider-failure-token-9472';
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request) => {
        expect(request.type).toBe('host.remoteFleetConnectionProbe.dispatch');
        return {
          resultType: 'failed' as const,
          commandId: (request as RemoteFleetConnectionProbeHostRequestWithoutId).envelope.commandId,
          providerKind: 'docker' as const,
          reason: 'remote-error' as const,
          message: `Docker daemon denied bearer ${providerToken}.`,
        };
      },
    });
    const connectionId = 'connection-probe-failed';
    const nodeId = 'node-probe-failure-sentinel';

    await runtime.invoke('registerConnection', {
      connection: {
        id: connectionId,
        connectionKind: 'container',
        publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376' } },
        secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connections/docker-failure/bearer' } },
      },
    });
    await runtime.invoke('register', { node: { id: nodeId, connectionId, targetKind: 'container' } });
    hostRequests.length = 0;

    const probeResponse = await (runtime as RemoteFleetRuntimeWithConnectionProbe).invoke('probeConnection', { connectionId });

    expect(probeResponse.status).toBe(200);
    const probeData = probeResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: RemoteFleetCommandSummary };
    const probeRequest = hostRequests.filter(isRemoteFleetConnectionProbeHostRequest);
    expect(probeRequest).toHaveLength(1);
    expect(probeData.snapshot.connections).toContainEqual(expect.objectContaining({
      id: connectionId,
      status: 'offline',
      reason: 'Remote Fleet connection probe was rejected by the remote endpoint.',
    }));
    expect(probeData.snapshot.nodes).toContainEqual(expect.objectContaining({ id: nodeId, status: 'unknown' }));
    expect(probeData.command).toEqual(expect.objectContaining({
      id: probeRequest[0].envelope.commandId,
      connectionId,
      status: 'failed',
      message: 'Remote Fleet connection probe was rejected by the remote endpoint.',
    }));
    expect(JSON.stringify(probeData)).not.toContain(providerToken);
    const persistedStateText = await readPersistedStateText(runtimeDataRootDir);
    expect(persistedStateText).not.toContain(providerToken);
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.commands).toContainEqual(expect.objectContaining({
      id: probeRequest[0].envelope.commandId,
      connectionId,
      state: expect.objectContaining({ reason: 'failed' }),
      message: 'Remote Fleet connection probe was rejected by the remote endpoint.',
    }));
    expect(persistedState.auditEvents).toContainEqual(expect.objectContaining({
      connectionId,
      commandId: probeRequest[0].envelope.commandId,
      message: 'Remote Fleet connection probe was rejected by the remote endpoint.',
    }));
    expect(JSON.stringify(persistedState.auditEvents)).not.toContain(providerToken);
    await runtime.close();
  });

  it('records failed bootstrap install-agent results without leaking enrollment tokens', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const runtime = createDeterministicRemoteFleetRuntime({
      runtimeDataRootDir,
      host: hostRequests,
      handleHostRequest: (request): RemoteFleetBootstrapCommandResult => {
        expect(request.type).toBe('host.remoteFleetBootstrap.dispatchCommand');
        const envelope = (request as RemoteFleetBootstrapHostRequestWithoutId).envelope;
        return {
          resultType: 'failed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          reason: 'remote-error',
          message: `Bootstrap install failed for token ${BOOTSTRAP_ENROLLMENT_SECRET_TOKEN}.`,
        };
      },
    });

    await runtime.invoke('register', {
      node: {
        id: 'node-bootstrap-failed',
        displayName: 'Bootstrap Failed Node',
        targetKind: 'container',
      },
    });
    hostRequests.length = 0;

    const installResponse = await runtime.invoke('installAgent', { nodeId: 'node-bootstrap-failed' });

    expect(installResponse.status).toBe(202);
    const installData = installResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: RemoteFleetCommandSummary };
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, installData.command.id);
    const bootstrapRequests = expectBootstrapDispatchRequests(hostRequests, 1);
    expectSafeBootstrapEnvelope(bootstrapRequests[0].envelope, {
      commandId: commandRecord.id,
      commandName: 'install-agent',
      providerKind: 'docker',
      nodeId: 'node-bootstrap-failed',
      agentId: 'node-bootstrap-failed:agent',
    });
    expect(installData.snapshot.commands).toContainEqual(expect.objectContaining({
      id: commandRecord.id,
      command: 'install-agent',
      status: 'failed',
      message: 'Docker environment bootstrap failed. Bootstrap install failed for token [REDACTED].',
    }));
    expect(installData.snapshot.agents).toContainEqual(expect.objectContaining({
      id: 'node-bootstrap-failed:agent',
      status: 'failed',
    }));
    await expectEnrollmentTokenNotLeaked({
      runtimeDataRootDir,
      token: BOOTSTRAP_ENROLLMENT_SECRET_TOKEN,
      snapshot: installData.snapshot,
      command: installData.command,
    });
    await runtime.close();
  });

  it('keeps custom bootstrap install unsupported instead of fake-succeeding', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const nodeId = 'node-bootstrap-custom';
    const runtime = createDeterministicRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', {
      node: {
        id: nodeId,
        displayName: 'Unsupported custom Node',
        targetKind: 'custom',
      },
    });
    hostRequests.length = 0;

    const installResponse = await runtime.invoke('installAgent', { nodeId });

    expect(installResponse.status).toBe(202);
    const installData = installResponse.data as { readonly snapshot: RemoteFleetSnapshot; readonly command: RemoteFleetCommandSummary };
    expect(hostRequests).toEqual([]);
    expect(installData.snapshot.commands).toContainEqual(expect.objectContaining({
      id: installData.command.id,
      command: 'install-agent',
      status: 'failed',
      message: 'Remote Fleet bootstrap provider unsupported for this node target.',
    }));
    expect(installData.snapshot.agents).toContainEqual(expect.objectContaining({
      id: `${nodeId}:agent`,
      status: 'failed',
    }));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    expect(persistedState.commands).toContainEqual(expect.objectContaining({
      id: installData.command.id,
      command: 'install-agent',
      state: expect.objectContaining({ reason: 'failed' }),
    }));
    await runtime.close();
  });
});

describe('RemoteFleetRuntime command ACK ownership and idempotency', () => {
  it('rejects command progress ACKs without matching agent ownership and idempotency key', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const { runtime, commandId, agentId, idempotencyKey, queuedSnapshot, queuedCommandSummary } = await createQueuedStartCommand(
      runtimeDataRootDir,
      'node-progress-ack',
    );

    expectNoIdempotencyKeyProjection(queuedCommandSummary, idempotencyKey);
    expectCommandSummariesDoNotExposeIdempotencyKey(queuedSnapshot, idempotencyKey);

    const credential = await enrollRuntimeAgent(runtime, 'node-progress-ack');
    expect((await ingestRuntimeAgentCommandProgress(runtime, {
      agentId: 'wrong-agent',
      requestId: 'wrong-agent-progress',
      commandId,
      idempotencyKey,
      authorizationCredential: credential,
    })).status).toBe(401);
    expect((await acknowledgeRuntimeAgentCommandProgress(runtime, { commandId, agentId, idempotencyKey: 'wrong-idempotency-key' })).status).toBe(409);

    const progressResponse = await acknowledgeRuntimeAgentCommandProgress(runtime, { commandId, agentId, idempotencyKey });
    expect(progressResponse.status).toBe(200);
    const progressSnapshot = await invokeSnapshot(runtime);
    expect(progressSnapshot.commands).toContainEqual(expect.objectContaining({ id: commandId, status: 'running' }));
    expectCommandSummariesDoNotExposeIdempotencyKey(progressSnapshot, idempotencyKey);
    await runtime.close();
  });

  it('rejects command result ACKs without matching agent ownership and idempotency key', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const { runtime, commandId, agentId, idempotencyKey, queuedSnapshot, queuedCommandSummary } = await createQueuedStartCommand(
      runtimeDataRootDir,
      'node-result-ack',
    );
    const result = { reason: 'succeeded' as const, completedAt: '2026-07-06T00:00:00.000Z' };

    expectNoIdempotencyKeyProjection(queuedCommandSummary, idempotencyKey);
    expectCommandSummariesDoNotExposeIdempotencyKey(queuedSnapshot, idempotencyKey);

    const credential = await enrollRuntimeAgent(runtime, 'node-result-ack');
    expect((await ingestRuntimeAgentCommandResult(runtime, {
      agentId: 'wrong-agent',
      requestId: 'wrong-agent-result',
      commandId,
      idempotencyKey,
      authorizationCredential: credential,
      result,
    })).status).toBe(401);
    expect((await acknowledgeRuntimeAgentCommandResult(runtime, { commandId, agentId, idempotencyKey: 'wrong-idempotency-key', result })).status).toBe(409);

    const resultResponse = await acknowledgeRuntimeAgentCommandResult(runtime, { commandId, agentId, idempotencyKey, result });
    expect(resultResponse.status).toBe(200);
    const resultSnapshot = await invokeSnapshot(runtime);
    expect(resultSnapshot.commands).toContainEqual(expect.objectContaining({ id: commandId, status: 'succeeded' }));
    expectCommandSummariesDoNotExposeIdempotencyKey(resultSnapshot, idempotencyKey);
    await runtime.close();
  });

  it('records a failed SSH RuntimeAgent command ACK without persisting sensitive message material', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetTestHostRequestWithoutId[] = [];
    const nodeId = 'node-ingress-failure-redaction';
    const runtimeId = `${nodeId}:openclaw`;
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', {
      node: {
        id: nodeId,
        targetKind: 'ssh-host',
        secretRefs: {
          sshPrivateKey: { kind: 'secret-ref', ref: `remote-fleet://test/${nodeId}/ssh-private-key` },
        },
      },
    });
    const ingressCredential = await enrollRuntimeAgent(runtime, nodeId);
    expect(hostRequests).toContainEqual(expect.objectContaining({
      type: 'host.remoteFleetBootstrap.dispatchCommand',
      envelope: expect.objectContaining({
        commandName: 'install-agent',
        providerKind: 'ssh',
        agentId: `${nodeId}:agent`,
      }),
    }));

    const startResponse = await runtime.invoke('start', { runtimeId });
    expect(startResponse.status).toBe(202);
    const commandId = (startResponse.data as { readonly command: { readonly id: string } }).command.id;
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, commandId);
    const unsafeMessage = [
      'Remote runtime start failed; verify the remote runtime configuration before retrying.',
      'Authorization: Bearer test-secret',
      'mrf_runtime_agent_ingress_secret_1234567890',
      'stdout=ssh bootstrap terminal output should never persist',
      'stderr=ssh bootstrap error output should never persist',
    ].join('; ');
    const sensitiveFragments = [
      'Authorization: Bearer test-secret',
      'Bearer test-secret',
      'test-secret',
      'mrf_runtime_agent_ingress_secret_1234567890',
      'stdout=ssh bootstrap terminal output should never persist',
      'stderr=ssh bootstrap error output should never persist',
    ];

    const ingressResponse = await ingestRuntimeAgentCommandResult(runtime, {
      agentId: `${nodeId}:agent`,
      requestId: 'failed-command-result-redaction',
      commandId,
      idempotencyKey: commandRecord.idempotencyKey,
      authorizationCredential: ingressCredential,
      result: {
        reason: 'failed',
        completedAt: '2026-07-06T00:00:00.000Z',
        message: unsafeMessage,
      },
    });

    expect(ingressResponse).toEqual(expect.objectContaining({
      status: 200,
      data: expect.objectContaining({
        type: 'runtime-agent.command.result.response',
        resultType: 'recorded',
        agentId: `${nodeId}:agent`,
        commandId,
      }),
    }));
    const persistedState = await readPersistedState(runtimeDataRootDir);
    const snapshot = await invokeSnapshot(runtime);
    const commandList = await invokeCommandList(runtime);
    const auditEvents = await invokeAuditEventList(runtime);
    const persistedCommand = persistedState.commands?.find((command) => command.id === commandId);
    const runtimeProjection = snapshot.runtimes.find((item) => item.id === runtimeId);

    expect(JSON.stringify(ingressResponse.data)).not.toContain('stdout=ssh bootstrap terminal output should never persist');
    expect(JSON.stringify(ingressResponse.data)).not.toContain('stderr=ssh bootstrap error output should never persist');
    expect(persistedCommand).toEqual(expect.objectContaining({
      state: expect.objectContaining({ reason: 'failed' }),
      message: expect.stringContaining('Remote runtime start failed'),
    }));
    expect(runtimeProjection).toEqual(expect.objectContaining({
      status: 'degraded',
      reason: expect.stringContaining('Remote runtime start failed'),
    }));
    expect(snapshot.commands).toContainEqual(expect.objectContaining({
      id: commandId,
      status: 'failed',
      message: expect.stringContaining('Remote runtime start failed'),
    }));
    expect(commandList).toContainEqual(expect.objectContaining({
      id: commandId,
      status: 'failed',
      message: expect.stringContaining('Remote runtime start failed'),
    }));
    expect(snapshot.auditEvents).toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.command.completed',
      commandId,
      message: expect.stringContaining('Remote runtime start failed'),
    }));
    expect(auditEvents).toContainEqual(expect.objectContaining({
      eventName: 'remoteFleet.command.completed',
      commandId,
      message: expect.stringContaining('Remote runtime start failed'),
    }));

    for (const projection of [
      JSON.stringify(persistedState),
      JSON.stringify(snapshot),
      JSON.stringify(commandList),
      JSON.stringify(auditEvents),
      JSON.stringify(runtimeProjection),
    ]) {
      for (const sensitiveFragment of sensitiveFragments) {
        expect(projection).not.toContain(sensitiveFragment);
      }
    }
    await runtime.close();
  });

  it('treats replayed terminal command result ACKs as no-op snapshots', async () => {
    const runtimeDataRootDir = await createRuntimeDataRoot();
    const hostRequests: RemoteFleetHostRequestWithoutId[] = [];
    const runtime = createRemoteFleetRuntime({ runtimeDataRootDir, host: hostRequests });

    await runtime.invoke('register', { node: { id: 'node-result-replay', displayName: 'Result Replay Node' } });
    const startResponse = await runtime.invoke('start', { runtimeId: 'node-result-replay:openclaw' });
    const startData = startResponse.data as { readonly command: { readonly id: string } };
    const commandId = startData.command.id;
    const commandRecord = await readPersistedCommandRecord(runtimeDataRootDir, commandId);
    const firstResult = { reason: 'succeeded' as const, completedAt: '2026-07-06T00:00:00.000Z' };

    const firstAckResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId,
      agentId: 'node-result-replay:agent',
      idempotencyKey: commandRecord.idempotencyKey,
      result: firstResult,
    });
    expect(firstAckResponse.status).toBe(200);
    const firstAckSnapshot = (firstAckResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    const persistedAfterFirstAck = await readPersistedStateText(runtimeDataRootDir);
    const hostRequestCountAfterFirstAck = hostRequests.length;
    const auditEventCountAfterFirstAck = firstAckSnapshot.auditEvents.length;

    const replayResponse = await acknowledgeRuntimeAgentCommandResult(runtime, {
      commandId,
      agentId: 'node-result-replay:agent',
      idempotencyKey: commandRecord.idempotencyKey,
      result: { reason: 'failed' as const, completedAt: '2026-07-06T00:09:00.000Z', message: 'replayed failure should not apply' },
    });

    expect(replayResponse.status).toBe(200);
    const replaySnapshot = (replayResponse.data as { readonly snapshot: RemoteFleetSnapshot }).snapshot;
    expect(replaySnapshot.commands).toContainEqual(expect.objectContaining({
      id: commandId,
      status: 'succeeded',
    }));
    expect(replaySnapshot.auditEvents).toHaveLength(auditEventCountAfterFirstAck);
    expect(hostRequests).toHaveLength(hostRequestCountAfterFirstAck);
    expect(await readPersistedStateText(runtimeDataRootDir)).toBe(persistedAfterFirstAck);
    expect(JSON.stringify(replaySnapshot)).not.toContain('replayed failure should not apply');
    await runtime.close();
  });
});

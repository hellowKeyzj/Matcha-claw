import { accepted, applicationResponse, badRequest, conflict, ok, notFound, unavailable, type ApplicationResponseOf } from '../common/application-response';
import { buildCapabilityScopeKey, runtimeInstanceScope, type RuntimeEndpointRef, type RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { RemoteFleetOperationId } from './remote-fleet-operation-id';
import {
  REMOTE_FLEET_CREDENTIAL_TEXT_LIMIT,
  REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
  isRemoteFleetWritableCredentialName,
  isValidRemoteFleetCredentialPathSegment,
  type RemoteFleetCredentialWriteRequestInput,
  type RemoteFleetSecretWriteHostRpcResponse,
  type RemoteFleetSecretWriteStatusHostRpcResponse,
} from './remote-fleet-credential-host-rpc';
import { createRemoteFleetAuditEventRecord, redactRemoteFleetMessage, summarizeRemoteFleetAuditEvent } from './remote-fleet-audit';
import {
  findUnsafeRemoteFleetEndpointUrlKey,
  findUnsafeRemoteFleetPublicConfigKey,
  evaluateRemoteFleetCommandPolicy,
  type RemoteFleetCommandPolicyDecision,
} from './remote-fleet-command-policy';
import {
  bootstrapProviderKindForTargetKind,
  createRemoteFleetBootstrapCommandEnvelope,
  createRemoteFleetConnectionProbeEnvelope,
  createUnavailableBootstrapResult,
  createUnavailableConnectionProbeResult,
  isRemoteFleetBootstrapCommandResult,
  isRemoteFleetConnectionProbeResult,
  type RemoteFleetBootstrapCommandEnvelope,
  type RemoteFleetBootstrapCommandName,
  type RemoteFleetBootstrapCommandResult,
  type RemoteFleetBootstrapEnrollmentContext,
  type RemoteFleetConnectionProbeEnvelope,
  type RemoteFleetConnectionProbeResult,
} from './remote-fleet-bootstrap';
import { buildRemoteFleetCommandDispatchEnvelope } from './remote-fleet-command-dispatch';
import {
  createRuntimeAgentIngressRejectedResponse,
  normalizeRuntimeAgentIngressOperation,
  type RuntimeAgentIngressResponse,
} from './remote-fleet-agent-ingress';
import type {
  RuntimeAgentHeartbeatRequest,
  RuntimeAgentReportCommandProgressRequest,
  RuntimeAgentReportCommandResultRequest,
} from './remote-fleet-agent-client';
import { isRemoteFleetDockerLoopbackHttps2375Endpoint } from './remote-fleet-docker-target-config';
import {
  hashCapabilityDescriptorsStable,
  markCapabilitySnapshotPruned,
  normalizeCapabilityDescriptorsForEndpoint,
  shouldReplaceCapabilityProjection,
} from './remote-fleet-capability-projection';
import { acquireLeaseRecord, expireLeases, releaseLeaseRecordsForEndpoint } from './remote-fleet-lease-manager';
import { buildRemoteFleetMetricsSnapshot } from './remote-fleet-metrics';
import { buildRemoteFleetReconcilePlan } from './remote-fleet-reconcile';
import type { RemoteFleetHostRequestWithoutId } from './remote-fleet-worker-contracts';
import {
  emptyRemoteFleetPersistedState,
  type RemoteFleetPersistedState,
  type RemoteFleetStateStore,
} from './remote-fleet-store';
import {
  REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_METHOD,
  REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_METHOD,
  REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE,
  normalizeTerminalSize,
  resolveRemoteFleetTerminalProviderKind,
  validateRemoteFleetTerminalSessionTarget,
  type RemoteFleetTerminalCloseSessionHostRpcResponse,
  type RemoteFleetTerminalConnection,
  type RemoteFleetTerminalIssueTicketHostRpcResponse,
  type RemoteFleetTerminalIssueTicketReason,
  type RemoteFleetTerminalProviderKind,
  type RemoteFleetTerminalSize,
} from './remote-fleet-terminal-contracts';
import type {
  CapabilitySnapshotFreshnessState,
  RemoteCapabilitySnapshotRecord,
  RemoteCapabilitySnapshotSummary,
  RemoteFleetAuditEventName,
  RemoteFleetAuditEventRecord,
  RemoteFleetAuditEventSummary,
  RemoteFleetCommandRecord,
  RemoteFleetCommandState,
  RemoteFleetCommandSummary,
  RemoteFleetConnectionRecord,
  RemoteFleetCredentialWriteOperationRecord,
  RemoteFleetCredentialWriteReceipt,
  RemoteFleetConnectionRegistrationInput,
  RemoteFleetConnectionSummary,
  RemoteFleetEnvironmentRecord,
  RemoteFleetEnvironmentRegistrationInput,
  RemoteFleetEnvironmentSummary,
  RemoteFleetLeaseRecord,
  RemoteFleetLeaseSummary,
  RemoteFleetManagedResourceRecord,
  RemoteFleetManagedResourceSummary,
  RemoteFleetNodeRecord,
  RemoteFleetNodeRegistrationInput,
  RemoteFleetNodeSummary,
  RemoteFleetSecretRef,
  RemoteFleetSnapshot,
  RemoteFleetTerminalSessionRecord,
  RemoteFleetTerminalSessionState,
  RemoteFleetTerminalSessionSummary,
  RemoteRuntimeEndpointHealthState,
  RemoteRuntimeEndpointRecord,
  RemoteRuntimeEndpointSummary,
  RuntimeAgentEnrollmentState,
  RuntimeAgentRecord,
  RuntimeAgentSummary,
  RuntimeInstanceLifecycleState,
  RuntimeInstanceRecord,
  RuntimeInstanceSummary,
} from './remote-fleet-model';

type RemoteFleetCommandResultInput = {
  readonly reason: 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  readonly completedAt?: string;
  readonly message?: string;
  readonly timeoutMs?: number;
  readonly managedResources?: Extract<RemoteFleetBootstrapCommandResult, { readonly resultType: 'completed' }>['managedResources'];
};

type RemoteFleetCredentialWriteInputReadResult =
  | { readonly resultType: 'valid'; readonly value: RemoteFleetCredentialWriteRequestInput }
  | { readonly resultType: 'invalid'; readonly message: string };

const REMOTE_FLEET_ACK_IDEMPOTENCY_KEY_FIELD = 'idempotencyKey';
const REMOTE_FLEET_HISTORY_PROJECTION_LIMIT = 100;
const REMOTE_FLEET_TERMINAL_SESSION_LEASE_TTL_MS = 30 * 60_000;

interface RemoteFleetRuntimeState {
  readonly connections: Map<string, RemoteFleetConnectionRecord>;
  readonly environments: Map<string, RemoteFleetEnvironmentRecord>;
  readonly managedResources: Map<string, RemoteFleetManagedResourceRecord>;
  readonly nodes: Map<string, RemoteFleetNodeRecord>;
  readonly agents: Map<string, RuntimeAgentRecord>;
  readonly runtimes: Map<string, RuntimeInstanceRecord>;
  readonly endpoints: Map<string, RemoteRuntimeEndpointRecord>;
  readonly capabilities: Map<string, RemoteCapabilitySnapshotRecord>;
  readonly commands: Map<string, RemoteFleetCommandRecord>;
  readonly commandProjectionOrder: string[];
  readonly credentialWriteOperations: Map<string, RemoteFleetCredentialWriteOperationRecord>;
  readonly leases: Map<string, RemoteFleetLeaseRecord>;
  readonly sessions: Map<string, RemoteFleetTerminalSessionRecord>;
  readonly auditEvents: Map<string, RemoteFleetAuditEventRecord>;
  readonly auditEventProjectionOrder: string[];
}

export interface RemoteFleetHostPort {
  request(request: RemoteFleetHostRequestWithoutId): Promise<unknown>;
}

export interface RemoteFleetRuntimeIdentityPort {
  randomId(prefix: string): string;
  randomToken(byteLength: number): string;
  hashSecret(secret: string): Promise<string>;
}

export interface RemoteFleetRuntimeClockPort {
  nowIso(): string;
}

export interface RemoteFleetRuntimeDeps {
  readonly host?: RemoteFleetHostPort;
  readonly store: RemoteFleetStateStore;
  readonly identity: RemoteFleetRuntimeIdentityPort;
  readonly clock: RemoteFleetRuntimeClockPort;
  readonly runtimeAgentIngressUrl?: string;
}

export class RemoteFleetRuntime {
  private readonly state: RemoteFleetRuntimeState = createEmptyRuntimeState();
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly deps: RemoteFleetRuntimeDeps) {}

  async invoke(operationId: RemoteFleetOperationId, params: unknown): Promise<ApplicationResponseOf> {
    await this.ensureLoaded();
    this.reapExpiredLeases(this.deps.clock.nowIso());
    switch (operationId) {
      case 'snapshot':
        return ok(this.snapshot());
      case 'metrics':
        return ok(buildRemoteFleetMetricsSnapshot(this.toPersistedState()));
      case 'registerConnection':
        return this.registerConnection(params);
      case 'deleteConnection':
        return await this.deleteConnection(params);
      case 'registerEnvironment':
        return this.registerEnvironment(params);
      case 'deployEnvironment':
        return await this.deployEnvironment(params);
      case 'deleteEnvironment':
        return await this.deleteEnvironment(params);
      case 'register':
        return this.registerNode(params);
      case 'writeCredential':
        return await this.writeCredential(params);
      case 'removeNode':
        return this.removeNode(params);
      case 'probe':
        return ok(await this.probeNode(params));
      case 'probeConnection':
        return ok(await this.probeConnection(params));
      case 'installAgent':
        return this.installAgent(params);
      case 'ingestRuntimeAgentIngress':
        return await this.ingestRuntimeAgentIngress(params);
      case 'revokeAgent':
        return this.revokeAgent(params);
      case 'start':
        return this.startRuntime(params);
      case 'stop':
        return this.stopRuntime(params);
      case 'drainEndpoint':
        return this.drainEndpoint(params);
      case 'retireEndpoint':
        return this.retireEndpoint(params);
      case 'sync':
        return await this.syncCapabilities(params);
      case 'openTerminalSession':
        return await this.openTerminalSession(params);
      case 'reconnectTerminalSession':
        return await this.reconnectTerminalSession(params);
      case 'closeTerminalSession':
        return await this.closeTerminalSession(params);
      case 'listTerminalSessions':
        return ok({ sessions: this.listTerminalSessions() });
      case 'listCommands':
        return ok({ commands: this.listCommands() });
      case 'listAuditEvents':
        return ok({ auditEvents: this.listAuditEvents() });
    }
  }

  async close(): Promise<void> {
    await this.ensureLoaded();
    await this.persist();
    this.state.connections.clear();
    this.state.environments.clear();
    this.state.managedResources.clear();
    this.state.nodes.clear();
    this.state.agents.clear();
    this.state.runtimes.clear();
    this.state.endpoints.clear();
    this.state.capabilities.clear();
    this.state.commands.clear();
    this.state.commandProjectionOrder.length = 0;
    this.state.credentialWriteOperations.clear();
    this.state.leases.clear();
    this.state.sessions.clear();
    this.state.auditEvents.clear();
    this.state.auditEventProjectionOrder.length = 0;
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    const persisted = await this.deps.store.readState() ?? emptyRemoteFleetPersistedState();
    replaceMapValues(this.state.connections, persisted.connections);
    replaceMapValues(this.state.environments, persisted.environments);
    replaceMapValues(this.state.managedResources, persisted.managedResources);
    replaceMapValues(this.state.nodes, persisted.nodes);
    replaceMapValues(this.state.agents, persisted.agents);
    replaceMapValues(this.state.runtimes, persisted.runtimes);
    replaceMapValues(this.state.endpoints, persisted.endpoints);
    replaceMapValues(this.state.capabilities, persisted.capabilities);
    replaceMapValues(this.state.commands, persisted.commands);
    replaceMapValues(this.state.credentialWriteOperations, persisted.credentialWriteOperations);
    this.state.commandProjectionOrder.splice(0, this.state.commandProjectionOrder.length, ...buildRecentProjectionOrder(persisted.commands, (command) => command.createdAt));
    replaceMapValues(this.state.leases, persisted.leases);
    replaceMapValues(this.state.sessions, persisted.sessions);
    replaceMapValues(this.state.auditEvents, persisted.auditEvents);
    this.state.auditEventProjectionOrder.splice(0, this.state.auditEventProjectionOrder.length, ...buildRecentProjectionOrder(persisted.auditEvents, (event) => event.occurredAt));
    await this.reconcilePersistedStateAfterLoad();
  }

  private async persist(): Promise<void> {
    await this.deps.store.writeState(this.toPersistedState());
  }

  private toPersistedState(): RemoteFleetPersistedState {
    return {
      version: 1,
      connections: Array.from(this.state.connections.values()),
      environments: Array.from(this.state.environments.values()),
      managedResources: Array.from(this.state.managedResources.values()),
      nodes: Array.from(this.state.nodes.values()),
      agents: Array.from(this.state.agents.values()),
      runtimes: Array.from(this.state.runtimes.values()),
      endpoints: Array.from(this.state.endpoints.values()),
      capabilities: Array.from(this.state.capabilities.values()),
      commands: Array.from(this.state.commands.values()),
      credentialWriteOperations: Array.from(this.state.credentialWriteOperations.values()),
      leases: Array.from(this.state.leases.values()),
      sessions: Array.from(this.state.sessions.values()),
      auditEvents: Array.from(this.state.auditEvents.values()),
    };
  }

  private async registerConnection(params: unknown): Promise<ApplicationResponseOf> {
    const input = readConnectionRegistrationInput(readRecord(params).connection ?? params);
    const unsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.publicConfig ?? {});
    if (unsafePublicConfigKey) {
      return badRequest(`Remote Fleet connection publicConfig must not contain plaintext credential key ${unsafePublicConfigKey}. Use secretRefs instead.`);
    }
    const unsafeEndpointUrlKey = findUnsafeRemoteFleetEndpointUrlKey(input.endpointUrl);
    if (unsafeEndpointUrlKey) {
      return badRequest(`Remote Fleet connection endpointUrl must not contain plaintext credential material ${unsafeEndpointUrlKey}. Use secretRefs instead.`);
    }

    const now = this.deps.clock.nowIso();
    const connectionId = input.id ?? this.deps.identity.randomId('connection');
    const existingConnection = this.state.connections.get(connectionId);
    const connectionKind = input.connectionKind ?? input.targetKind ?? existingConnection?.connectionKind ?? 'ssh-host';
    if (isRemoteFleetDockerConnectionProtocolMismatch(input, connectionKind)) {
      return badRequest('Remote Fleet Docker local port 2375 must use HTTP instead of HTTPS.');
    }
    const connection: RemoteFleetConnectionRecord = {
      id: connectionId,
      displayName: input.displayName ?? existingConnection?.displayName ?? connectionId,
      ...(input.description ? { description: input.description } : existingConnection?.description ? { description: existingConnection.description } : {}),
      connectionKind,
      ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : existingConnection?.endpointUrl ? { endpointUrl: existingConnection.endpointUrl } : {}),
      labels: normalizeLabels(input.labels ?? existingConnection?.labels),
      enabled: input.enabled ?? existingConnection?.enabled ?? true,
      publicConfig: mergeRemoteFleetConnectionPublicConfig(
        existingConnection?.publicConfig,
        input.publicConfig,
        connectionKind,
      ),
      secretRefs: {
        ...(existingConnection?.secretRefs ?? {}),
        ...(input.secretRefs ?? {}),
      },
      health: existingConnection?.health ?? { reason: 'unknown' },
      createdAt: existingConnection?.createdAt ?? now,
      updatedAt: now,
    };
    this.state.connections.set(connection.id, connection);
    const command = this.completeCommand({ command: 'register-connection', message: 'Remote Fleet connection registered.' });
    this.audit('remoteFleet.connection.registered', { commandId: command.id, metadata: { connectionId: connection.id } });
    await this.persist();
    return ok({ snapshot: this.snapshot(), connection: summarizeConnection(connection) });
  }

  private async deleteConnection(params: unknown): Promise<ApplicationResponseOf> {
    const connectionId = readRequiredString(readRecord(params), 'connectionId');
    const connection = this.state.connections.get(connectionId);
    if (!connection) {
      return notFound(`Remote Fleet connection not found: ${connectionId}`);
    }
    if (this.connectionHasAssociatedRecords(connectionId)) {
      return conflict('Remote Fleet connection cannot be deleted while it still has associated resources. Delete those resources first.');
    }

    this.state.connections.delete(connection.id);
    const command = this.completeCommand({
      command: 'delete-connection',
      connectionId: connection.id,
      message: 'Remote Fleet connection deleted.',
    });
    this.audit('remoteFleet.connection.deleted', {
      connectionId: connection.id,
      commandId: command.id,
    });
    await this.persist();
    return ok({ snapshot: this.snapshot(), command: summarizeCommand(command) });
  }

  private async registerNode(params: unknown): Promise<ApplicationResponseOf> {
    const input = readNodeRegistrationInput(readRecord(params).node ?? params);
    const unsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.publicConfig ?? {});
    if (unsafePublicConfigKey) {
      return badRequest(`Remote Fleet publicConfig must not contain plaintext credential key ${unsafePublicConfigKey}. Use secretRefs instead.`);
    }
    const unsafeEndpointUrlKey = findUnsafeRemoteFleetEndpointUrlKey(input.endpointUrl);
    if (unsafeEndpointUrlKey) {
      return badRequest(`Remote Fleet endpointUrl must not contain plaintext credential material ${unsafeEndpointUrlKey}. Use secretRefs instead.`);
    }
    if (input.connectionId && !this.state.connections.has(input.connectionId)) {
      return notFound(`Remote Fleet connection not found: ${input.connectionId}`);
    }
    if (input.environmentId && !this.state.environments.has(input.environmentId)) {
      return notFound(`Remote Fleet environment not found: ${input.environmentId}`);
    }
    if (input.managedResourceId && !this.state.managedResources.has(input.managedResourceId)) {
      return notFound(`Remote Fleet managed resource not found: ${input.managedResourceId}`);
    }
    const now = this.deps.clock.nowIso();
    const nodeId = input.id ?? this.deps.identity.randomId('node');
    const existingNode = this.state.nodes.get(nodeId);
    if (input.environmentId && existingNode?.environmentId && existingNode.environmentId !== input.environmentId) {
      return badRequest(`Remote Fleet node ${nodeId} is already bound to environment ${existingNode.environmentId}.`);
    }
    const environment = input.environmentId ? this.state.environments.get(input.environmentId) : existingNode?.environmentId ? this.state.environments.get(existingNode.environmentId) : undefined;
    const managedResource = input.managedResourceId ? this.state.managedResources.get(input.managedResourceId) : existingNode?.managedResourceId ? this.state.managedResources.get(existingNode.managedResourceId) : undefined;
    const connectionId = input.connectionId ?? environment?.connectionId ?? managedResource?.connectionId ?? existingNode?.connectionId;
    const node: RemoteFleetNodeRecord = {
      id: nodeId,
      ...(connectionId ? { connectionId } : {}),
      ...(environment ? { environmentId: environment.id } : {}),
      ...(managedResource ? { managedResourceId: managedResource.id } : {}),
      displayName: input.displayName ?? existingNode?.displayName ?? nodeId,
      ...(input.description ? { description: input.description } : existingNode?.description ? { description: existingNode.description } : {}),
      targetKind: input.targetKind ?? existingNode?.targetKind ?? 'ssh-host',
      ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : existingNode?.endpointUrl ? { endpointUrl: existingNode.endpointUrl } : {}),
      labels: normalizeLabels(input.labels ?? existingNode?.labels),
      enabled: input.enabled ?? existingNode?.enabled ?? true,
      publicConfig: input.publicConfig ?? existingNode?.publicConfig ?? {},
      secretRefs: input.secretRefs ?? existingNode?.secretRefs ?? {},
      health: existingNode?.health ?? { reason: 'unknown' },
      createdAt: existingNode?.createdAt ?? now,
      updatedAt: now,
    };
    const agent = this.state.agents.get(`${node.id}:agent`) ?? createDefaultAgent(node, now);
    const runtime = this.state.runtimes.get(`${node.id}:openclaw`) ?? createDefaultRuntime(node, agent, now);
    this.state.nodes.set(node.id, node);
    this.state.agents.set(agent.id, {
      ...agent,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
      ...(node.environmentId ? { environmentId: node.environmentId } : {}),
      ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
      displayName: `${node.displayName} RuntimeAgent`,
      updatedAt: now,
    });
    this.state.runtimes.set(runtime.id, {
      ...runtime,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
      ...(node.environmentId ? { environmentId: node.environmentId } : {}),
      ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
      displayName: `${node.displayName} OpenClaw`,
      updatedAt: now,
    });
    const command = this.completeCommand({ command: 'register-node', nodeId: node.id, message: 'Remote Fleet node registered.' });
    this.audit('remoteFleet.node.registered', { nodeId: node.id, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), node: summarizeNode(node) });
  }

  private async registerEnvironment(params: unknown): Promise<ApplicationResponseOf> {
    const input = readEnvironmentRegistrationInput(readRecord(params).environment ?? params);
    const unsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.publicConfig ?? {});
    if (unsafePublicConfigKey) {
      return badRequest(`Remote Fleet environment publicConfig must not contain plaintext credential key ${unsafePublicConfigKey}. Use secretRefs instead.`);
    }
    const connection = this.state.connections.get(input.connectionId);
    if (!connection) {
      return notFound(`Remote Fleet connection not found: ${input.connectionId}`);
    }

    const now = this.deps.clock.nowIso();
    const environmentId = input.id ?? this.deps.identity.randomId('environment');
    const existingEnvironment = this.state.environments.get(environmentId);
    const environmentKind = input.environmentKind ?? environmentKindForTargetKind(input.targetKind ?? connection.connectionKind);
    const targetKind = input.targetKind ?? targetKindForEnvironmentKind(environmentKind);
    const nodeId = input.nodeId ?? existingEnvironment?.nodeId ?? `${environmentId}:node`;
    const existingNode = this.state.nodes.get(nodeId);
    if (existingNode?.environmentId && existingNode.environmentId !== environmentId) {
      return badRequest(`Remote Fleet node ${nodeId} is already bound to environment ${existingNode.environmentId}.`);
    }
    const owningEnvironment = findEnvironmentByNodeId(this.state.environments, nodeId, environmentId);
    if (owningEnvironment) {
      return badRequest(`Remote Fleet node ${nodeId} is already bound to environment ${owningEnvironment.id}.`);
    }
    const environment: RemoteFleetEnvironmentRecord = {
      id: environmentId,
      connectionId: connection.id,
      nodeId,
      displayName: input.displayName ?? existingEnvironment?.displayName ?? environmentId,
      ...(input.description ? { description: input.description } : existingEnvironment?.description ? { description: existingEnvironment.description } : {}),
      environmentKind,
      labels: normalizeLabels(input.labels ?? existingEnvironment?.labels),
      enabled: input.enabled ?? existingEnvironment?.enabled ?? true,
      publicConfig: input.publicConfig ?? existingEnvironment?.publicConfig ?? {},
      secretRefs: input.secretRefs ?? existingEnvironment?.secretRefs ?? {},
      lifecycle: existingEnvironment?.lifecycle ?? { reason: 'registered' },
      managedResourceIds: existingEnvironment?.managedResourceIds ?? [],
      createdAt: existingEnvironment?.createdAt ?? now,
      updatedAt: now,
    };
    const node = this.upsertDefaultNodeForEnvironment({ environment, targetKind, now });
    const agent = this.upsertDefaultAgentForNode(node, now);
    const runtime = this.upsertDefaultRuntimeForNode(node, agent, now);
    this.state.environments.set(environment.id, environment);
    const command = this.completeCommand({
      command: 'register-environment',
      connectionId: connection.id,
      environmentId: environment.id,
      nodeId: node.id,
      agentId: agent.id,
      runtimeId: runtime.id,
      message: 'Remote Fleet environment registered.',
    });
    this.audit('remoteFleet.environment.registered', { connectionId: connection.id, environmentId: environment.id, nodeId: node.id, agentId: agent.id, runtimeId: runtime.id, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), environment: summarizeEnvironment(environment), node: summarizeNode(node), agent: summarizeAgent(agent), runtime: summarizeRuntime(runtime) });
  }

  private async deployEnvironment(params: unknown): Promise<ApplicationResponseOf> {
    const environmentId = readEnvironmentId(params, 'Remote Fleet deployEnvironment requires environmentId.');
    const environment = this.state.environments.get(environmentId);
    if (!environment) {
      return notFound(`Remote Fleet environment not found: ${environmentId}`);
    }
    const now = this.deps.clock.nowIso();
    const { node: ownedNode, agent: ownedAgent, runtime: ownedRuntime } =
      this.resolveEnvironmentOwnedGraph(environment);
    if (environment.nodeId && !ownedNode) {
      return await this.failEnvironmentDeployWithoutOwnedGraph(environment, now);
    }
    const node = ownedNode ?? this.upsertDefaultNodeForEnvironment({
      environment,
      targetKind: targetKindForEnvironmentKind(environment.environmentKind),
      now,
    });
    const agent = ownedAgent ?? this.upsertDefaultAgentForNode(node, now);
    const runtime = ownedRuntime ?? this.upsertDefaultRuntimeForNode(node, agent, now);
    const providerKind = bootstrapProviderKindForTargetKind(node.targetKind);
    const requiresRuntimeAgentIngress = providerKind !== undefined && node.targetKind !== 'container';
    if (requiresRuntimeAgentIngress && !this.deps.runtimeAgentIngressUrl) {
      return badRequest('Remote Fleet RuntimeAgent ingress URL must be configured before deployment.');
    }
    const issuedEnrollment = requiresRuntimeAgentIngress
      ? await this.createEnrollmentContext(agent, node.id, now)
      : undefined;
    const command = this.queueCommand({
      command: 'deploy-environment',
      connectionId: environment.connectionId,
      environmentId: environment.id,
      nodeId: node.id,
      agentId: agent.id,
      runtimeId: runtime.id,
      message: 'Remote Fleet environment deploy command queued.',
    });
    this.state.environments.set(environment.id, { ...environment, nodeId: node.id, lifecycle: { reason: 'deploying', commandId: command.id }, updatedAt: now });
    if (providerKind) {
      this.state.agents.set(agent.id, {
        ...agent,
        enrollment: { reason: 'installing', commandId: command.id },
        enrollmentTokenHash: issuedEnrollment?.tokenHash,
        enrollmentTokenExpiresAt: issuedEnrollment?.enrollment.expiresAt,
        updatedAt: now,
      });
      if (issuedEnrollment) {
        this.audit('remoteFleet.agent.enrollmentIssued', { nodeId: node.id, agentId: agent.id });
      }
    }
    const updatedEnvironment = this.state.environments.get(environment.id)!;
    const projectedCommand = await this.dispatchBootstrapCommandAndApplyResult(
      'deploy-environment',
      command,
      node,
      this.state.agents.get(agent.id)!,
      issuedEnrollment?.enrollment,
      updatedEnvironment,
    );
    this.audit('remoteFleet.environment.deployQueued', { connectionId: environment.connectionId, environmentId: environment.id, nodeId: node.id, agentId: agent.id, runtimeId: runtime.id, commandId: command.id });
    await this.persist();
    return accepted({
      snapshot: this.snapshot(),
      environment: summarizeEnvironment(this.state.environments.get(environment.id)!),
      command: summarizeCommand(projectedCommand),
    });
  }

  private async failEnvironmentDeployWithoutOwnedGraph(
    environment: RemoteFleetEnvironmentRecord,
    now: string,
  ): Promise<ApplicationResponseOf> {
    const message = 'Remote Fleet environment deploy requires a node and RuntimeAgent owned by the environment.';
    const command = this.completeCommand({
      command: 'deploy-environment',
      connectionId: environment.connectionId,
      environmentId: environment.id,
      didSucceed: false,
      message,
    });
    const failedEnvironment: RemoteFleetEnvironmentRecord = {
      ...environment,
      lifecycle: { reason: 'failed', message },
      updatedAt: now,
    };
    this.state.environments.set(environment.id, failedEnvironment);
    this.audit('remoteFleet.environment.failed', {
      connectionId: environment.connectionId,
      environmentId: environment.id,
      commandId: command.id,
      message,
    });
    await this.persist();
    return accepted({
      snapshot: this.snapshot(),
      environment: summarizeEnvironment(failedEnvironment),
      command: summarizeCommand(command),
    });
  }

  private async deleteEnvironment(params: unknown): Promise<ApplicationResponseOf> {
    const environmentId = readEnvironmentId(params, 'Remote Fleet deleteEnvironment requires environmentId.');
    const environment = this.state.environments.get(environmentId);
    if (!environment) {
      return notFound(`Remote Fleet environment not found: ${environmentId}`);
    }

    const now = this.deps.clock.nowIso();
    const { node, agent, runtime } = this.resolveEnvironmentOwnedGraph(environment);
    const managedResources = this.listManagedResourcesForEnvironment(environment.id);
    const cleanupCommands: RemoteFleetCommandRecord[] = [];
    let failedCleanupCount = 0;

    for (const managedResource of managedResources) {
      if (!shouldDispatchManagedResourceCleanup(managedResource)) {
        this.audit('remoteFleet.managedResource.cleanupSkipped', {
          connectionId: managedResource.connectionId,
          environmentId: managedResource.environmentId,
          managedResourceId: managedResource.id,
          nodeId: managedResource.nodeId,
          message: skippedManagedResourceCleanupMessage(managedResource),
        });
        continue;
      }
      if (!node || !agent) {
        failedCleanupCount += 1;
        this.state.managedResources.set(managedResource.id, {
          ...managedResource,
          lifecycle: { reason: 'failed', message: 'Remote Fleet environment cleanup requires a bound node and RuntimeAgent.' },
          updatedAt: now,
        });
        this.audit('remoteFleet.managedResource.failed', {
          connectionId: managedResource.connectionId,
          environmentId: managedResource.environmentId,
          managedResourceId: managedResource.id,
          message: 'Remote Fleet environment cleanup requires a bound node and RuntimeAgent.',
        });
        continue;
      }
      const command = this.queueCommand({
        command: 'delete-environment',
        connectionId: managedResource.connectionId,
        environmentId: managedResource.environmentId,
        managedResourceId: managedResource.id,
        nodeId: node.id,
        agentId: agent.id,
        runtimeId: runtime?.id,
        message: 'Remote Fleet environment delete command queued.',
      });
      cleanupCommands.push(command);
      this.state.environments.set(environment.id, { ...this.state.environments.get(environment.id)!, lifecycle: { reason: 'deleting', commandId: command.id }, updatedAt: now });
      this.state.managedResources.set(managedResource.id, { ...managedResource, lifecycle: { reason: 'deleting', commandId: command.id }, updatedAt: now });
      this.audit('remoteFleet.managedResource.deleteQueued', {
        connectionId: managedResource.connectionId,
        environmentId: managedResource.environmentId,
        managedResourceId: managedResource.id,
        nodeId: node.id,
        agentId: agent.id,
        runtimeId: runtime?.id,
        commandId: command.id,
      });
      const projectedCommand = await this.dispatchBootstrapCommandAndApplyResult('delete-environment', command, node, agent, undefined, this.state.environments.get(environment.id)!, managedResource);
      if (projectedCommand.state.reason !== 'succeeded') {
        failedCleanupCount += 1;
      }
    }

    const deletionCommand = cleanupCommands[0] ?? this.completeCommand({
      command: 'delete-environment',
      connectionId: environment.connectionId,
      environmentId: environment.id,
      nodeId: node?.id,
      agentId: agent?.id,
      runtimeId: runtime?.id,
      didSucceed: failedCleanupCount === 0,
      message: failedCleanupCount === 0 ? 'Remote Fleet environment deleted.' : 'Remote Fleet environment delete failed.',
    });
    if (failedCleanupCount > 0) {
      const failedEnvironment = this.markEnvironmentDeletionFailed(environment.id, now);
      this.audit('remoteFleet.environment.failed', {
        connectionId: environment.connectionId,
        environmentId: environment.id,
        nodeId: node?.id,
        agentId: agent?.id,
        runtimeId: runtime?.id,
        commandId: deletionCommand.id,
        message: failedEnvironment.lifecycle.message,
      });
      await this.persist();
      return accepted({
        snapshot: this.snapshot(),
        environment: summarizeEnvironment(failedEnvironment),
        commands: cleanupCommands.length > 0 ? cleanupCommands.map(summarizeCommand) : [summarizeCommand(deletionCommand)],
      });
    }

    await this.closeTerminalSessionsForEnvironment(environment, now);
    await this.removeEnvironmentCanonicalRecords(environment.id, now);
    this.audit('remoteFleet.environment.deleted', {
      connectionId: environment.connectionId,
      environmentId: environment.id,
      nodeId: node?.id,
      agentId: agent?.id,
      runtimeId: runtime?.id,
      commandId: deletionCommand.id,
    });
    await this.persist();
    return accepted({
      snapshot: this.snapshot(),
      commands: cleanupCommands.length > 0 ? cleanupCommands.map(summarizeCommand) : [summarizeCommand(deletionCommand)],
    });
  }

  private async writeCredential(params: unknown): Promise<ApplicationResponseOf> {
    const input = readCredentialWriteInput(params, this.deps.clock.nowIso());
    if (input.resultType === 'invalid') {
      return badRequest(input.message);
    }

    const credentialRef: RemoteFleetSecretRef = {
      kind: 'secret-ref',
      ref: `remote-fleet://credentials/${input.value.credentialId}/${input.value.credentialName}`,
    };
    const existingOperation = this.state.credentialWriteOperations.get(input.value.operationId);
    if (existingOperation) {
      if (!isMatchingCredentialWriteOperation(existingOperation, input.value, credentialRef)) {
        return conflict('Remote Fleet credential write operation conflicts with an existing credential target.');
      }
      if (existingOperation.state.reason === 'completed') {
        await this.persist();
        return ok(credentialWriteResponse(existingOperation.state.receipt));
      }
    } else {
      const operation: RemoteFleetCredentialWriteOperationRecord = {
        id: input.value.operationId,
        credentialId: input.value.credentialId,
        credentialName: input.value.credentialName,
        credentialRef,
        state: { reason: 'pending', requestedAt: input.value.nowIso },
        createdAt: input.value.nowIso,
        updatedAt: input.value.nowIso,
      };
      this.state.credentialWriteOperations.set(operation.id, operation);
      try {
        await this.persist();
      } catch (error) {
        this.state.credentialWriteOperations.delete(operation.id);
        throw error;
      }
    }

    if (!this.deps.host) {
      return unavailable({ success: false, error: 'Remote Fleet credential writer is unavailable.' });
    }

    const result = await this.deps.host.request({
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_METHOD,
      input: input.value,
    }) as RemoteFleetSecretWriteHostRpcResponse;
    if (!isCredentialWriteResult(result)) {
      return unavailable({ success: false, error: 'Remote Fleet credential writer returned an invalid result.' });
    }
    if (result.resultType === 'invalidRequest') {
      return badRequest(result.message);
    }
    if (result.resultType === 'unavailable') {
      return unavailable({ success: false, error: 'Remote Fleet credential writer is unavailable.' });
    }

    if (result.credentialName !== input.value.credentialName || result.credentialRef.ref !== credentialRef.ref) {
      return unavailable({ success: false, error: 'Remote Fleet credential writer returned a receipt for a different credential target.' });
    }
    const receipt: RemoteFleetCredentialWriteReceipt = {
      operationId: input.value.operationId,
      credentialName: result.credentialName,
      credentialRef: result.credentialRef,
      writtenAt: result.writtenAt,
    };
    if (!this.completeCredentialWriteOperation(input.value, receipt)) {
      return unavailable({ success: false, error: 'Remote Fleet credential writer returned a receipt that could not be applied.' });
    }
    await this.persist();
    return ok(credentialWriteResponse(receipt));
  }

  private async removeNode(params: unknown): Promise<ApplicationResponseOf> {
    const nodeId = readRequiredString(readRecord(params), 'nodeId');
    const node = this.state.nodes.get(nodeId);
    if (!node) {
      return notFound(`Remote Fleet node not found: ${nodeId}`);
    }
    if (node.environmentId) {
      return badRequest(`Remote Fleet node ${nodeId} is owned by environment ${node.environmentId}. Delete the environment instead.`);
    }
    const endpointScopes = Array.from(this.state.endpoints.values())
      .filter((endpoint) => endpoint.nodeId === nodeId && !endpoint.environmentId)
      .map((endpoint) => endpoint.scope);
    for (const scope of endpointScopes) {
      await this.pruneCapabilityProjection(scope);
    }
    for (const runtime of this.state.runtimes.values()) {
      if (runtime.nodeId === nodeId && !runtime.environmentId) {
        this.state.runtimes.delete(runtime.id);
      }
    }
    for (const endpoint of this.state.endpoints.values()) {
      if (endpoint.nodeId === nodeId && !endpoint.environmentId) {
        this.state.endpoints.delete(endpoint.id);
      }
    }
    for (const agent of this.state.agents.values()) {
      if (agent.nodeId === nodeId && !agent.environmentId) {
        this.state.agents.delete(agent.id);
      }
    }
    for (const capability of this.state.capabilities.values()) {
      if (capability.nodeId === nodeId && !capability.environmentId) {
        this.state.capabilities.delete(capability.id);
      }
    }
    this.state.nodes.delete(nodeId);
    const command = this.completeCommand({ command: 'remove-node', nodeId, message: 'Remote Fleet node removed.' });
    this.audit('remoteFleet.node.removed', { nodeId, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), command: summarizeCommand(command) });
  }

  private async probeConnection(params: unknown): Promise<{
    readonly snapshot: RemoteFleetSnapshot;
    readonly connection?: RemoteFleetConnectionSummary;
    readonly command: RemoteFleetCommandSummary;
  }> {
    const connectionId = readRequiredString(readRecord(params), 'connectionId');
    const connection = this.state.connections.get(connectionId);
    if (!connection) {
      const command = this.completeCommand({
        command: 'probe-connection',
        connectionId,
        didSucceed: false,
        message: 'Remote Fleet connection not found.',
      });
      await this.persist();
      return { snapshot: this.snapshot(), command: summarizeCommand(command) };
    }

    const command = this.queueCommand({
      command: 'probe-connection',
      connectionId: connection.id,
      message: 'Remote Fleet connection probe queued.',
    });
    const envelope = createRemoteFleetConnectionProbeEnvelope({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      connection,
    });
    const result = this.deps.host
      ? await this.dispatchConnectionProbeEnvelope(envelope)
      : createUnavailableConnectionProbeResult(envelope);
    const projectedCommand = await this.applyConnectionProbeResult(command, result);
    this.audit('remoteFleet.connection.probed', {
      connectionId: connection.id,
      commandId: command.id,
    });
    await this.persist();
    return {
      snapshot: this.snapshot(),
      connection: summarizeConnection(this.state.connections.get(connection.id) ?? connection),
      command: summarizeCommand(projectedCommand),
    };
  }

  private async probeNode(params: unknown): Promise<{ readonly snapshot: RemoteFleetSnapshot; readonly node?: RemoteFleetNodeSummary; readonly command: RemoteFleetCommandSummary }> {
    const nodeId = readRequiredString(readRecord(params), 'nodeId');
    const node = this.state.nodes.get(nodeId);
    if (!node) {
      const command = this.completeCommand({ command: 'probe-node', nodeId, didSucceed: false, message: `Remote Fleet node not found: ${nodeId}` });
      await this.persist();
      return { snapshot: this.snapshot(), command: summarizeCommand(command) };
    }
    const agent = this.findAgentByNodeId(nodeId);
    const command = this.queueCommand({ command: 'probe-node', nodeId, agentId: agent?.id, message: 'Remote Fleet probe command queued.' });
    const projectedCommand = this.hasRuntimeAgentDispatchTarget(command)
      ? await this.dispatchQueuedCommand(command)
      : agent && bootstrapProviderKindForTargetKind(node.targetKind)
        ? await this.dispatchBootstrapCommandAndApplyResult('probe-node', command, node, agent)
        : await this.failQueuedCommand(command, 'Remote Fleet bootstrap provider unsupported for this node target.');
    this.audit('remoteFleet.node.probed', { nodeId, commandId: command.id });
    await this.persist();
    return {
      snapshot: this.snapshot(),
      node: summarizeNode(this.state.nodes.get(nodeId) ?? node),
      command: summarizeCommand(projectedCommand),
    };
  }

  private async installAgent(params: unknown): Promise<ApplicationResponseOf> {
    const nodeId = readRequiredString(readRecord(params), 'nodeId');
    const agent = this.findAgentByNodeId(nodeId);
    if (!agent) {
      return notFound(`Remote Fleet agent not found for node: ${nodeId}`);
    }
    const now = this.deps.clock.nowIso();
    const node = this.state.nodes.get(nodeId);
    const policyDecision = this.evaluateCommandPolicy({
      node,
      command: { command: 'install-agent', nodeId },
    });
    if (policyDecision.resultType === 'denied') {
      const command = this.completePolicyDeniedCommand(policyDecision);
      await this.persist();
      return ok({ snapshot: this.snapshot(), command: summarizeCommand(command), policyDecision });
    }
    if (!node || !bootstrapProviderKindForTargetKind(node.targetKind)) {
      const command = this.completeCommand({
        command: 'install-agent',
        nodeId,
        agentId: agent.id,
        didSucceed: false,
        message: 'Remote Fleet bootstrap provider unsupported for this node target.',
      });
      this.state.agents.set(agent.id, {
        ...agent,
        enrollment: { reason: 'failed', message: 'Remote Fleet bootstrap provider unsupported for this node target.' },
        updatedAt: now,
      });
      await this.persist();
      return accepted({ snapshot: this.snapshot(), command: summarizeCommand(command) });
    }

    const requiresRuntimeAgentIngress = node.targetKind !== 'container';
    if (requiresRuntimeAgentIngress && !this.deps.runtimeAgentIngressUrl) {
      return badRequest('Remote Fleet RuntimeAgent ingress URL must be configured before installation.');
    }
    const issuedEnrollment = requiresRuntimeAgentIngress
      ? await this.createEnrollmentContext(agent, nodeId, now)
      : undefined;
    const command = this.queueCommand({ command: 'install-agent', nodeId, agentId: agent.id, message: 'Remote Fleet install command queued.' });
    this.state.agents.set(agent.id, {
      ...agent,
      enrollment: { reason: 'installing', commandId: command.id },
      enrollmentTokenHash: issuedEnrollment?.tokenHash,
      enrollmentTokenExpiresAt: issuedEnrollment?.enrollment.expiresAt,
      updatedAt: now,
    });
    if (issuedEnrollment) {
      this.audit('remoteFleet.agent.enrollmentIssued', { nodeId, agentId: agent.id });
    }
    const projectedCommand = await this.dispatchBootstrapCommandAndApplyResult('install-agent', command, node, this.state.agents.get(agent.id)!, issuedEnrollment?.enrollment);
    this.audit('remoteFleet.agent.installQueued', { nodeId, agentId: agent.id, commandId: command.id });
    await this.persist();
    return accepted({ snapshot: this.snapshot(), command: summarizeCommand(projectedCommand) });
  }

  private async ingestRuntimeAgentIngress(params: unknown): Promise<ApplicationResponseOf<RuntimeAgentIngressResponse>> {
    const input = readRecord(params);
    const rawRequest = input.rawRequest;
    const normalized = normalizeRuntimeAgentIngressOperation(rawRequest);
    const now = this.deps.clock.nowIso();
    if (normalized.resultType === 'invalid') {
      return applicationResponse(
        normalized.reason === 'unsupported-operation' ? 422 : 400,
        createRuntimeAgentIngressRejectedResponse(
          rawRequest,
          normalized.reason === 'unsupported-operation' ? 'unsupported-operation' : 'invalid-request',
          now,
        ),
      );
    }

    const authorizationCredential = readOptionalString(input, 'authorizationCredential');
    if (normalized.request.type === 'runtime-agent.heartbeat') {
      const authentication = await this.authenticateRuntimeAgentHeartbeat(
        normalized.request,
        authorizationCredential,
        readOptionalString(input, 'enrollmentCredential'),
        now,
      );
      if (authentication.resultType === 'unauthorized') {
        return applicationResponse(401, createRuntimeAgentIngressRejectedResponse(rawRequest, 'unauthorized', now));
      }
      return await this.recordAuthenticatedHeartbeat(normalized.request, authentication.agent, now);
    }

    const authentication = await this.authenticateRuntimeAgentCredential(
      normalized.request.agentId,
      authorizationCredential,
    );
    if (authentication.resultType === 'unauthorized') {
      return applicationResponse(401, createRuntimeAgentIngressRejectedResponse(rawRequest, 'unauthorized', now));
    }
    switch (normalized.request.type) {
      case 'runtime-agent.command.progress':
        return await this.recordAuthenticatedCommandProgress(normalized.request, authentication.agent, now);
      case 'runtime-agent.command.result':
        return await this.recordAuthenticatedCommandResult(normalized.request, authentication.agent, now);
    }
  }

  private async authenticateRuntimeAgentCredential(
    agentId: string,
    credential: string | undefined,
  ): Promise<{ readonly resultType: 'authenticated'; readonly agent: RuntimeAgentRecord } | { readonly resultType: 'unauthorized' }> {
    const agent = this.state.agents.get(agentId);
    if (!agent || agent.enrollment.reason === 'revoked' || !credential || !agent.ingressCredentialHash) {
      return { resultType: 'unauthorized' };
    }
    const credentialHash = await this.deps.identity.hashSecret(credential);
    return credentialHash === agent.ingressCredentialHash
      ? { resultType: 'authenticated', agent }
      : { resultType: 'unauthorized' };
  }

  private async authenticateRuntimeAgentHeartbeat(
    request: RuntimeAgentHeartbeatRequest,
    authorizationCredential: string | undefined,
    enrollmentCredential: string | undefined,
    now: string,
  ): Promise<{ readonly resultType: 'authenticated'; readonly agent: RuntimeAgentRecord } | { readonly resultType: 'unauthorized' }> {
    const existingAuthentication = await this.authenticateRuntimeAgentCredential(request.agentId, authorizationCredential);
    if (existingAuthentication.resultType === 'authenticated') {
      return existingAuthentication;
    }

    const agent = this.state.agents.get(request.agentId);
    if (
      !agent
      || agent.enrollment.reason === 'revoked'
      || agent.ingressCredentialHash
      || !authorizationCredential
      || !enrollmentCredential
      || !agent.enrollmentTokenHash
      || isExpiredTimestamp(agent.enrollmentTokenExpiresAt, now)
    ) {
      return { resultType: 'unauthorized' };
    }

    const enrollmentTokenHash = await this.deps.identity.hashSecret(authorizationCredential);
    if (enrollmentTokenHash !== agent.enrollmentTokenHash) {
      return { resultType: 'unauthorized' };
    }
    const ingressCredentialHash = await this.deps.identity.hashSecret(enrollmentCredential);
    return {
      resultType: 'authenticated',
      agent: {
        ...agent,
        enrollmentTokenHash: undefined,
        enrollmentTokenExpiresAt: undefined,
        ingressCredentialHash,
        ingressCredentialIssuedAt: now,
      },
    };
  }

  private async recordAuthenticatedHeartbeat(
    request: RuntimeAgentHeartbeatRequest,
    agent: RuntimeAgentRecord,
    now: string,
  ): Promise<ApplicationResponseOf<RuntimeAgentIngressResponse>> {
    const updatedAgent: RuntimeAgentRecord = {
      ...agent,
      enrollment: {
        reason: 'enrolled',
        enrolledAt: agent.enrollment.reason === 'enrolled' ? agent.enrollment.enrolledAt : now,
        lastHandshakeAt: now,
      },
      updatedAt: now,
    };
    this.state.agents.set(agent.id, updatedAgent);
    const node = this.state.nodes.get(agent.nodeId);
    if (node) {
      this.state.nodes.set(node.id, { ...node, health: { reason: 'online', lastSeenAt: now }, updatedAt: now });
    }
    const command = this.completeCommand({ command: 'record-heartbeat', nodeId: agent.nodeId, agentId: agent.id, message: 'RuntimeAgent heartbeat recorded.' });
    this.audit('remoteFleet.agent.heartbeatRecorded', { nodeId: agent.nodeId, agentId: agent.id, commandId: command.id });
    await this.persist();
    return ok({
      type: 'runtime-agent.heartbeat.response',
      requestId: request.requestId,
      agentId: agent.id,
      resultType: 'recorded',
      receivedAt: now,
      snapshot: {
        agentId: agent.id,
        status: request.status,
        observedAt: now,
        runtimeIds: request.runtimeIds ?? [],
        ...(request.message === undefined ? {} : { message: request.message }),
      },
    });
  }

  private async recordAuthenticatedCommandProgress(
    request: RuntimeAgentReportCommandProgressRequest,
    agent: RuntimeAgentRecord,
    now: string,
  ): Promise<ApplicationResponseOf<RuntimeAgentIngressResponse>> {
    const command = this.state.commands.get(request.commandId);
    if (!command || command.agentId !== agent.id || command.idempotencyKey !== request.idempotencyKey) {
      return applicationResponse(409, createRuntimeAgentIngressRejectedResponse(request, 'command-conflict', now));
    }
    if (!isTerminalCommandState(command.state) && command.state.reason === 'queued') {
      this.storeCommand({ ...command, state: { reason: 'running', startedAt: now }, updatedAt: now });
      await this.persist();
    }
    return ok({
      type: 'runtime-agent.command.progress.response',
      requestId: request.requestId,
      agentId: agent.id,
      commandId: command.id,
      resultType: 'recorded',
      recordedAt: now,
    });
  }

  private async recordAuthenticatedCommandResult(
    request: RuntimeAgentReportCommandResultRequest,
    agent: RuntimeAgentRecord,
    now: string,
  ): Promise<ApplicationResponseOf<RuntimeAgentIngressResponse>> {
    const command = this.state.commands.get(request.commandId);
    if (!command || command.agentId !== agent.id || command.idempotencyKey !== request.idempotencyKey) {
      return applicationResponse(409, createRuntimeAgentIngressRejectedResponse(request, 'command-conflict', now));
    }
    if (!isTerminalCommandState(command.state)) {
      const result = redactRuntimeAgentCommandResult(request.result);
      const updatedCommand = updateCommandWithResult(command, result, now);
      this.storeCommand(updatedCommand);
      const didApplyLifecycleResult = await this.applyCommandResult(updatedCommand, result, now);
      this.auditCommandResult(updatedCommand, result, didApplyLifecycleResult);
      await this.persist();
    }
    return ok({
      type: 'runtime-agent.command.result.response',
      requestId: request.requestId,
      agentId: agent.id,
      commandId: command.id,
      resultType: 'recorded',
      recordedAt: now,
    });
  }

  private async revokeAgent(params: unknown): Promise<ApplicationResponseOf> {
    const agentId = readRequiredString(readRecord(params), 'agentId');
    const agent = this.state.agents.get(agentId);
    if (!agent) {
      return notFound(`Remote Fleet agent not found: ${agentId}`);
    }
    const now = this.deps.clock.nowIso();
    this.state.agents.set(agentId, {
      ...agent,
      enrollment: { reason: 'revoked', revokedAt: now, message: 'Revoked by Remote Fleet control plane.' },
      enrollmentTokenHash: undefined,
      enrollmentTokenExpiresAt: undefined,
      revokedAt: now,
      updatedAt: now,
    });
    const command = this.completeCommand({ command: 'revoke-agent', nodeId: agent.nodeId, agentId, message: 'RuntimeAgent revoked.' });
    this.audit('remoteFleet.agent.revoked', { nodeId: agent.nodeId, agentId, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), command: summarizeCommand(command) });
  }

  private async startRuntime(params: unknown): Promise<ApplicationResponseOf> {
    const input = readRecord(params);
    const runtimeId = readRequiredString(input, 'runtimeId');
    const runtime = this.state.runtimes.get(runtimeId);
    if (!runtime) {
      return notFound(`Remote Fleet runtime not found: ${runtimeId}`);
    }
    const node = this.state.nodes.get(runtime.nodeId);
    const policyDecision = this.evaluateCommandPolicy({
      node,
      runtime,
      command: { command: 'start-runtime', nodeId: runtime.nodeId, runtimeId, runtimeKind: runtime.runtimeKind },
    });
    if (policyDecision.resultType === 'denied') {
      const command = this.completePolicyDeniedCommand(policyDecision);
      await this.persist();
      return ok({ snapshot: this.snapshot(), command: summarizeCommand(command), policyDecision });
    }
    const now = this.deps.clock.nowIso();
    const endpoint = this.state.endpoints.get(`${runtime.id}:endpoint`) ?? createEndpointForRuntime(runtime, now);
    const command = this.queueCommand({ command: 'start-runtime', nodeId: runtime.nodeId, agentId: runtime.agentId, runtimeId, endpointId: endpoint.id, message: 'Runtime start command queued.' });
    this.state.endpoints.set(endpoint.id, { ...endpoint, health: { reason: 'unknown' }, updatedAt: now });
    this.state.runtimes.set(runtimeId, {
      ...runtime,
      endpointId: endpoint.id,
      lifecycle: { reason: 'starting', commandId: command.id },
      updatedAt: now,
    });
    this.acquireLease({ endpointId: endpoint.id, ownerKind: 'runtime-start', ownerId: command.id, now, ttlMs: 30_000 });
    await this.pruneCapabilityProjection(endpoint.scope, now);
    const projectedCommand = await this.dispatchQueuedCommand(command);
    await this.persist();
    return accepted({ snapshot: this.snapshot(), runtime: summarizeRuntime(this.state.runtimes.get(runtimeId)!), endpoint: summarizeEndpoint(this.state.endpoints.get(endpoint.id)!), command: summarizeCommand(projectedCommand) });
  }

  private async stopRuntime(params: unknown): Promise<ApplicationResponseOf> {
    const runtimeId = readRequiredString(readRecord(params), 'runtimeId');
    const runtime = this.state.runtimes.get(runtimeId);
    if (!runtime) {
      return notFound(`Remote Fleet runtime not found: ${runtimeId}`);
    }
    const node = this.state.nodes.get(runtime.nodeId);
    const policyDecision = this.evaluateCommandPolicy({
      node,
      runtime,
      command: { command: 'stop-runtime', nodeId: runtime.nodeId, runtimeId, runtimeKind: runtime.runtimeKind },
    });
    if (policyDecision.resultType === 'denied') {
      const command = this.completePolicyDeniedCommand(policyDecision);
      await this.persist();
      return ok({ snapshot: this.snapshot(), command: summarizeCommand(command), policyDecision });
    }
    const now = this.deps.clock.nowIso();
    const command = this.queueCommand({ command: 'stop-runtime', nodeId: runtime.nodeId, agentId: runtime.agentId, runtimeId, endpointId: runtime.endpointId, message: 'Runtime stop command queued.' });
    this.state.runtimes.set(runtimeId, {
      ...runtime,
      lifecycle: { reason: 'stopping', commandId: command.id },
      updatedAt: now,
    });
    if (runtime.endpointId) {
      const endpoint = this.state.endpoints.get(runtime.endpointId);
      if (endpoint) {
        await this.pruneCapabilityProjection(endpoint.scope, now);
        this.state.endpoints.set(endpoint.id, { ...endpoint, health: { reason: 'draining', message: 'Runtime stop queued; awaiting RuntimeAgent ACK.' }, updatedAt: now });
      }
    }
    const projectedCommand = await this.dispatchQueuedCommand(command);
    await this.persist();
    return accepted({ snapshot: this.snapshot(), runtime: summarizeRuntime(this.state.runtimes.get(runtimeId)!), command: summarizeCommand(projectedCommand) });
  }

  private async drainEndpoint(params: unknown): Promise<ApplicationResponseOf> {
    const endpointId = readRequiredString(readRecord(params), 'endpointId');
    const endpoint = this.state.endpoints.get(endpointId);
    if (!endpoint) {
      return notFound(`Remote Fleet endpoint not found: ${endpointId}`);
    }
    const now = this.deps.clock.nowIso();
    this.state.endpoints.set(endpointId, { ...endpoint, health: { reason: 'draining', message: 'Endpoint is draining.' }, updatedAt: now });
    const command = this.completeCommand({ command: 'drain-endpoint', nodeId: endpoint.nodeId, runtimeId: endpoint.runtimeId, endpointId, message: 'Endpoint drain started.' });
    this.audit('remoteFleet.endpoint.drained', { nodeId: endpoint.nodeId, runtimeId: endpoint.runtimeId, endpointId, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), endpoint: summarizeEndpoint(this.state.endpoints.get(endpointId)!), command: summarizeCommand(command) });
  }

  private async retireEndpoint(params: unknown): Promise<ApplicationResponseOf> {
    const endpointId = readRequiredString(readRecord(params), 'endpointId');
    const endpoint = this.state.endpoints.get(endpointId);
    if (!endpoint) {
      return notFound(`Remote Fleet endpoint not found: ${endpointId}`);
    }
    const now = this.deps.clock.nowIso();
    await this.pruneCapabilityProjection(endpoint.scope);
    this.state.endpoints.set(endpointId, { ...endpoint, health: { reason: 'retired', retiredAt: now }, updatedAt: now });
    this.releaseLeasesForEndpoint(endpointId, now);
    const command = this.completeCommand({ command: 'retire-endpoint', nodeId: endpoint.nodeId, runtimeId: endpoint.runtimeId, endpointId, message: 'Endpoint retired.' });
    this.audit('remoteFleet.endpoint.retired', { nodeId: endpoint.nodeId, runtimeId: endpoint.runtimeId, endpointId, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), endpoint: summarizeEndpoint(this.state.endpoints.get(endpointId)!), command: summarizeCommand(command) });
  }

  private async openTerminalSession(params: unknown): Promise<ApplicationResponseOf> {
    const target = this.readTerminalOpenTarget(readRecord(readRecord(params).target ?? params));
    if (target.resultType === 'failure') {
      return target.response;
    }
    if (!this.deps.host) {
      return unavailable({ success: false, error: 'Remote Fleet terminal host seam is unavailable.' });
    }

    const now = this.deps.clock.nowIso();
    const sessionId = this.deps.identity.randomId('terminal-session');
    const lease = target.endpoint
      ? this.acquireLease({ endpointId: target.endpoint.id, ownerKind: 'session', ownerId: sessionId, now, ttlMs: REMOTE_FLEET_TERMINAL_SESSION_LEASE_TTL_MS })
      : undefined;
    const session: RemoteFleetTerminalSessionRecord = {
      id: sessionId,
      ...(target.endpoint?.connectionId ?? target.runtime?.connectionId ?? target.node.connectionId ? { connectionId: target.endpoint?.connectionId ?? target.runtime?.connectionId ?? target.node.connectionId } : {}),
      ...(target.endpoint?.environmentId ?? target.runtime?.environmentId ?? target.node.environmentId ? { environmentId: target.endpoint?.environmentId ?? target.runtime?.environmentId ?? target.node.environmentId } : {}),
      ...(target.endpoint?.managedResourceId ?? target.runtime?.managedResourceId ?? target.node.managedResourceId ? { managedResourceId: target.endpoint?.managedResourceId ?? target.runtime?.managedResourceId ?? target.node.managedResourceId } : {}),
      nodeId: target.node.id,
      ...(target.runtime ? { runtimeId: target.runtime.id } : {}),
      ...(target.endpoint ? { endpointId: target.endpoint.id } : {}),
      targetKind: target.node.targetKind,
      state: { reason: 'opening', openedAt: now },
      createdAt: now,
      updatedAt: now,
      ...(lease ? { leaseId: lease.id } : {}),
    };
    this.state.sessions.set(session.id, session);

    const issued = await this.issueTerminalTicket('open', session, target.size);
    if (issued.resultType === 'failure') {
      const failedSession = this.failTerminalSession(session, issued.message, now);
      this.audit('remoteFleet.terminal.failed', {
        nodeId: failedSession.nodeId,
        runtimeId: failedSession.runtimeId,
        endpointId: failedSession.endpointId,
        message: issued.message,
        metadata: { sessionId: failedSession.id, action: 'open' },
      });
      await this.persist();
      return issued.response({ session: summarizeTerminalSession(failedSession) });
    }

    const connectedSession = this.connectTerminalSession(session, now);
    this.audit('remoteFleet.terminal.opened', {
      nodeId: connectedSession.nodeId,
      runtimeId: connectedSession.runtimeId,
      endpointId: connectedSession.endpointId,
      metadata: { sessionId: connectedSession.id },
    });
    await this.persist();
    return ok({ session: summarizeTerminalSession(connectedSession), terminalConnection: issued.terminalConnection });
  }

  private async reconnectTerminalSession(params: unknown): Promise<ApplicationResponseOf> {
    const sessionId = readOptionalString(readRecord(params), 'sessionId');
    if (!sessionId) {
      return badRequest('Remote Fleet terminal reconnect requires sessionId.');
    }
    const session = this.state.sessions.get(sessionId);
    if (!session) {
      return notFound(`Remote Fleet terminal session not found: ${sessionId}`);
    }
    if (session.state.reason === 'closed' || session.state.reason === 'failed' || session.state.reason === 'expired' || session.state.reason === 'closing') {
      return badRequest(`Remote Fleet terminal session cannot reconnect from ${session.state.reason} state.`);
    }
    const target = this.validateTerminalSessionTarget(session);
    if (target.resultType === 'failure') {
      return target.response;
    }
    if (!this.deps.host) {
      return unavailable({ success: false, error: 'Remote Fleet terminal host seam is unavailable.' });
    }

    const now = this.deps.clock.nowIso();
    const issued = await this.issueTerminalTicket('reconnect', session);
    if (issued.resultType === 'failure') {
      const failedSession = this.failTerminalSession(session, issued.message, now);
      this.audit('remoteFleet.terminal.failed', {
        nodeId: failedSession.nodeId,
        runtimeId: failedSession.runtimeId,
        endpointId: failedSession.endpointId,
        message: issued.message,
        metadata: { sessionId: failedSession.id, action: 'reconnect' },
      });
      await this.persist();
      return issued.response({ session: summarizeTerminalSession(failedSession) });
    }

    const connectedSession = this.connectTerminalSession(session, now);
    this.audit('remoteFleet.terminal.reconnected', {
      nodeId: connectedSession.nodeId,
      runtimeId: connectedSession.runtimeId,
      endpointId: connectedSession.endpointId,
      metadata: { sessionId: connectedSession.id },
    });
    await this.persist();
    return ok({ session: summarizeTerminalSession(connectedSession), terminalConnection: issued.terminalConnection });
  }

  private async closeTerminalSession(params: unknown): Promise<ApplicationResponseOf> {
    const input = readRecord(params);
    const sessionId = readOptionalString(input, 'sessionId');
    if (!sessionId) {
      return badRequest('Remote Fleet terminal close requires sessionId.');
    }
    const session = this.state.sessions.get(sessionId);
    if (!session) {
      return notFound(`Remote Fleet terminal session not found: ${sessionId}`);
    }
    if (session.state.reason === 'closed') {
      return ok({ session: summarizeTerminalSession(session) });
    }

    const now = this.deps.clock.nowIso();
    const closingSession = this.updateTerminalSession(session, { reason: 'closing', closingAt: now }, now);
    const closeResult = await this.requestTerminalSessionClose(closingSession, readOptionalString(input, 'reason'));
    const closedSession = this.closeTerminalSessionRecord(closingSession, now, closeResult.message);
    this.audit('remoteFleet.terminal.closed', {
      nodeId: closedSession.nodeId,
      runtimeId: closedSession.runtimeId,
      endpointId: closedSession.endpointId,
      message: closeResult.message,
      metadata: { sessionId: closedSession.id },
    });
    if (closeResult.resultType === 'failure') {
      this.audit('remoteFleet.terminal.failed', {
        nodeId: closedSession.nodeId,
        runtimeId: closedSession.runtimeId,
        endpointId: closedSession.endpointId,
        message: closeResult.message,
        metadata: { sessionId: closedSession.id, action: 'close' },
      });
    }
    await this.persist();
    if (closeResult.resultType === 'failure') {
      return closeResult.response({ session: summarizeTerminalSession(closedSession) });
    }
    return ok({ session: summarizeTerminalSession(closedSession) });
  }

  private readTerminalOpenTarget(input: Record<string, unknown>):
    | {
        readonly resultType: 'success';
        readonly node: RemoteFleetNodeRecord;
        readonly runtime?: RuntimeInstanceRecord;
        readonly endpoint?: RemoteRuntimeEndpointRecord;
        readonly providerKind: RemoteFleetTerminalProviderKind;
        readonly size: RemoteFleetTerminalSize;
      }
    | { readonly resultType: 'failure'; readonly response: ApplicationResponseOf } {
    const endpointId = readOptionalString(input, 'endpointId');
    const runtimeId = readOptionalString(input, 'runtimeId');
    const nodeId = readOptionalString(input, 'nodeId');
    const size = normalizeTerminalSize(readTerminalSize(input.size));

    if (endpointId) {
      const endpoint = this.state.endpoints.get(endpointId);
      if (!endpoint) {
        return { resultType: 'failure', response: notFound(`Remote Fleet endpoint not found: ${endpointId}`) };
      }
      const runtime = this.state.runtimes.get(endpoint.runtimeId);
      if (!runtime) {
        return { resultType: 'failure', response: notFound(`Remote Fleet runtime not found: ${endpoint.runtimeId}`) };
      }
      const node = this.state.nodes.get(endpoint.nodeId);
      if (!node) {
        return { resultType: 'failure', response: notFound(`Remote Fleet node not found: ${endpoint.nodeId}`) };
      }
      if (runtimeId && runtime.id !== runtimeId) {
        return { resultType: 'failure', response: badRequest(`Remote Fleet endpoint ${endpointId} does not belong to runtime ${runtimeId}.`) };
      }
      if (nodeId && node.id !== nodeId) {
        return { resultType: 'failure', response: badRequest(`Remote Fleet endpoint ${endpointId} does not belong to node ${nodeId}.`) };
      }
      const endpointHealthError = readTerminalEndpointHealthError(endpoint);
      if (endpointHealthError) {
        return { resultType: 'failure', response: badRequest(endpointHealthError) };
      }
      return { resultType: 'success', node, runtime, endpoint, providerKind: resolveRemoteFleetTerminalProviderKind({ targetKind: node.targetKind }), size };
    }

    if (runtimeId) {
      const runtime = this.state.runtimes.get(runtimeId);
      if (!runtime) {
        return { resultType: 'failure', response: notFound(`Remote Fleet runtime not found: ${runtimeId}`) };
      }
      const node = this.state.nodes.get(runtime.nodeId);
      if (!node) {
        return { resultType: 'failure', response: notFound(`Remote Fleet node not found: ${runtime.nodeId}`) };
      }
      if (nodeId && node.id !== nodeId) {
        return { resultType: 'failure', response: badRequest(`Remote Fleet runtime ${runtimeId} does not belong to node ${nodeId}.`) };
      }
      const endpoint = runtime.endpointId ? this.state.endpoints.get(runtime.endpointId) : undefined;
      if (runtime.endpointId && !endpoint) {
        return { resultType: 'failure', response: notFound(`Remote Fleet endpoint not found: ${runtime.endpointId}`) };
      }
      if (endpoint) {
        const endpointHealthError = readTerminalEndpointHealthError(endpoint);
        if (endpointHealthError) {
          return { resultType: 'failure', response: badRequest(endpointHealthError) };
        }
        return { resultType: 'success', node, runtime, endpoint, providerKind: resolveRemoteFleetTerminalProviderKind({ targetKind: node.targetKind }), size };
      }
      const noEndpointError = readTerminalNoEndpointError(node.targetKind);
      if (noEndpointError) {
        return { resultType: 'failure', response: badRequest(noEndpointError) };
      }
      return { resultType: 'success', node, runtime, providerKind: resolveRemoteFleetTerminalProviderKind({ targetKind: node.targetKind }), size };
    }

    if (!nodeId) {
      return { resultType: 'failure', response: badRequest('Remote Fleet terminal open requires nodeId, runtimeId, or endpointId.') };
    }
    const node = this.state.nodes.get(nodeId);
    if (!node) {
      return { resultType: 'failure', response: notFound(`Remote Fleet node not found: ${nodeId}`) };
    }
    const noEndpointError = readTerminalNoEndpointError(node.targetKind);
    if (noEndpointError) {
      return { resultType: 'failure', response: badRequest(noEndpointError) };
    }
    return { resultType: 'success', node, providerKind: resolveRemoteFleetTerminalProviderKind({ targetKind: node.targetKind }), size };
  }

  private validateTerminalSessionTarget(session: RemoteFleetTerminalSessionRecord):
    | { readonly resultType: 'success' }
    | { readonly resultType: 'failure'; readonly response: ApplicationResponseOf } {
    const node = this.state.nodes.get(session.nodeId);
    if (!node) {
      return { resultType: 'failure', response: notFound(`Remote Fleet node not found: ${session.nodeId}`) };
    }
    const runtime = session.runtimeId ? this.state.runtimes.get(session.runtimeId) : undefined;
    if (session.runtimeId && !runtime) {
      return { resultType: 'failure', response: notFound(`Remote Fleet runtime not found: ${session.runtimeId}`) };
    }
    const endpoint = session.endpointId ? this.state.endpoints.get(session.endpointId) : undefined;
    if (session.endpointId && !endpoint) {
      return { resultType: 'failure', response: notFound(`Remote Fleet endpoint not found: ${session.endpointId}`) };
    }
    if (endpoint) {
      const endpointHealthError = readTerminalEndpointHealthError(endpoint);
      if (endpointHealthError) {
        return { resultType: 'failure', response: badRequest(endpointHealthError) };
      }
    }
    return { resultType: 'success' };
  }

  private async issueTerminalTicket(reason: RemoteFleetTerminalIssueTicketReason, session: RemoteFleetTerminalSessionRecord, size?: RemoteFleetTerminalSize): Promise<
    | { readonly resultType: 'success'; readonly terminalConnection: RemoteFleetTerminalConnection }
    | { readonly resultType: 'failure'; readonly message: string; readonly response: (data: { readonly session: RemoteFleetTerminalSessionSummary }) => ApplicationResponseOf }
  > {
    const node = this.state.nodes.get(session.nodeId);
    const connection = node?.connectionId ? this.state.connections.get(node.connectionId) : undefined;
    const environment = session.environmentId ? this.state.environments.get(session.environmentId) : undefined;
    const runtime = session.runtimeId ? this.state.runtimes.get(session.runtimeId) : undefined;
    const endpoint = session.endpointId ? this.state.endpoints.get(session.endpointId) : undefined;
    const providerKind = resolveRemoteFleetTerminalProviderKind({ targetKind: session.targetKind });
    const input = {
      reason,
      session: summarizeTerminalSession(session),
      ...(node ? { node } : {}),
      ...(connection ? { connection } : {}),
      ...(environment ? { environment } : {}),
      ...(runtime ? { runtime } : {}),
      ...(endpoint ? { endpoint } : {}),
      providerKind,
      ...(size ? { size } : {}),
      nowIso: this.deps.clock.nowIso(),
    };
    const validation = validateRemoteFleetTerminalSessionTarget(input);
    if (validation.resultType !== 'valid') {
      return { resultType: 'failure', message: validation.message, response: (data) => ({ status: 400, data: { success: false, error: validation.message, ...data } }) };
    }

    const result = await this.deps.host!.request({
      type: REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_METHOD,
      input,
    }) as RemoteFleetTerminalIssueTicketHostRpcResponse;
    if (!isTerminalIssueTicketResult(result)) {
      const message = 'Remote Fleet terminal ticket issuer returned an invalid result.';
      return { resultType: 'failure', message, response: (data) => unavailable({ success: false, error: message, ...data }) };
    }
    if (result.resultType === 'issued') {
      if (result.terminalConnection.sessionId !== session.id) {
        const message = 'Remote Fleet terminal ticket issuer returned a ticket for a different session.';
        return { resultType: 'failure', message, response: (data) => unavailable({ success: false, error: message, ...data }) };
      }
      return { resultType: 'success', terminalConnection: result.terminalConnection };
    }
    const message = result.message ?? 'Remote Fleet terminal ticket issuer is unavailable.';
    if (result.resultType === 'unavailable') {
      return { resultType: 'failure', message, response: (data) => unavailable({ success: false, error: message, ...data }) };
    }
    return { resultType: 'failure', message, response: (data) => ({ status: 400, data: { success: false, error: message, ...data } }) };
  }

  private async requestTerminalSessionClose(session: RemoteFleetTerminalSessionRecord, reason: string | undefined): Promise<
    | { readonly resultType: 'success'; readonly message?: string }
    | { readonly resultType: 'failure'; readonly message: string; readonly response: (data: { readonly session: RemoteFleetTerminalSessionSummary }) => ApplicationResponseOf }
  > {
    if (!this.deps.host) {
      return { resultType: 'success', message: 'Remote Fleet terminal host seam is unavailable; local session closed.' };
    }
    const result = await this.deps.host.request({
      type: REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_METHOD,
      input: {
        session: summarizeTerminalSession(session),
        nowIso: this.deps.clock.nowIso(),
        ...(reason ? { reason } : {}),
      },
    }) as RemoteFleetTerminalCloseSessionHostRpcResponse;
    if (!isTerminalCloseSessionResult(result)) {
      const message = 'Remote Fleet terminal closer returned an invalid result.';
      return { resultType: 'failure', message, response: (data) => unavailable({ success: false, error: message, ...data }) };
    }
    if (result.resultType === 'closed') {
      return { resultType: 'success' };
    }
    const message = result.message ?? 'Remote Fleet terminal closer is unavailable.';
    if (result.resultType === 'unavailable') {
      return { resultType: 'failure', message, response: (data) => unavailable({ success: false, error: message, ...data }) };
    }
    return { resultType: 'failure', message, response: (data) => ({ status: 400, data: { success: false, error: message, ...data } }) };
  }

  private connectTerminalSession(session: RemoteFleetTerminalSessionRecord, now: string): RemoteFleetTerminalSessionRecord {
    return this.updateTerminalSession(session, { reason: 'connected', connectedAt: now }, now);
  }

  private failTerminalSession(session: RemoteFleetTerminalSessionRecord, message: string, now: string): RemoteFleetTerminalSessionRecord {
    this.releaseSessionLease(session, now);
    return this.updateTerminalSession(session, { reason: 'failed', failedAt: now, message }, now);
  }

  private closeTerminalSessionRecord(session: RemoteFleetTerminalSessionRecord, now: string, message?: string): RemoteFleetTerminalSessionRecord {
    this.releaseSessionLease(session, now);
    return this.updateTerminalSession(session, { reason: 'closed', closedAt: now, ...(message ? { message } : {}) }, now);
  }

  private updateTerminalSession(session: RemoteFleetTerminalSessionRecord, state: RemoteFleetTerminalSessionState, updatedAt: string): RemoteFleetTerminalSessionRecord {
    const updatedSession = { ...session, state, updatedAt };
    this.state.sessions.set(updatedSession.id, updatedSession);
    return updatedSession;
  }

  private async syncCapabilities(params: unknown): Promise<ApplicationResponseOf> {
    const endpointResult = this.readTargetSyncEndpoint(readRecord(params));
    if (endpointResult.resultType !== 'success') {
      return endpointResult.response;
    }

    const endpoint = endpointResult.endpoint;
    if (endpoint.health.reason === 'retired') {
      return badRequest(`Remote Fleet endpoint is retired: ${endpoint.id}`);
    }

    const now = this.deps.clock.nowIso();
    await this.syncCapabilitiesForEndpoint(endpoint, now);
    const command = this.completeCommand({ command: 'sync-capabilities', nodeId: endpoint.nodeId, runtimeId: endpoint.runtimeId, endpointId: endpoint.id, message: 'Capability snapshot synchronized.' });
    this.audit('remoteFleet.endpoint.capabilitiesSynced', { nodeId: endpoint.nodeId, runtimeId: endpoint.runtimeId, endpointId: endpoint.id, commandId: command.id });
    await this.persist();
    return ok({ snapshot: this.snapshot(), commands: [summarizeCommand(command)] });
  }

  private readTargetSyncEndpoint(input: Record<string, unknown>):
    | { readonly resultType: 'success'; readonly endpoint: RemoteRuntimeEndpointRecord }
    | { readonly resultType: 'failure'; readonly response: ApplicationResponseOf } {
    const endpointId = readOptionalString(input, 'endpointId');
    if (endpointId) {
      const endpoint = this.state.endpoints.get(endpointId);
      return endpoint
        ? { resultType: 'success', endpoint }
        : { resultType: 'failure', response: notFound(`Remote Fleet endpoint not found: ${endpointId}`) };
    }

    const runtimeId = readOptionalString(input, 'runtimeId');
    if (!runtimeId) {
      return { resultType: 'failure', response: badRequest('Remote Fleet capability sync requires runtimeId or endpointId.') };
    }

    const runtime = this.state.runtimes.get(runtimeId);
    if (!runtime) {
      return { resultType: 'failure', response: notFound(`Remote Fleet runtime not found: ${runtimeId}`) };
    }
    if (!runtime.endpointId) {
      return { resultType: 'failure', response: notFound(`Remote Fleet endpoint not found for runtime: ${runtimeId}`) };
    }

    const endpoint = this.state.endpoints.get(runtime.endpointId);
    return endpoint
      ? { resultType: 'success', endpoint }
      : { resultType: 'failure', response: notFound(`Remote Fleet endpoint not found: ${runtime.endpointId}`) };
  }

  private async syncCapabilitiesForEndpoint(endpoint: RemoteRuntimeEndpointRecord, now: string): Promise<RemoteCapabilitySnapshotRecord> {
    const descriptors = normalizeCapabilityDescriptorsForEndpoint(endpoint, createCapabilityDescriptors(endpoint));
    const previousSnapshot = this.state.capabilities.get(`${endpoint.id}:capabilities`) ?? null;
    const descriptorHash = hashCapabilityDescriptorsStable(descriptors);
    const capability = createCapabilitySnapshot(endpoint, descriptors, now, descriptorHash);
    if (shouldReplaceCapabilityProjection({ endpoint, descriptors, snapshot: previousSnapshot, descriptorHash })) {
      await this.replaceCapabilityProjection(endpoint.scope, descriptors);
    }
    this.state.capabilities.set(capability.id, capability);
    return capability;
  }

  private async reconcilePersistedStateAfterLoad(): Promise<void> {
    const now = this.deps.clock.nowIso();
    const plan = buildRemoteFleetReconcilePlan({
      state: this.toPersistedState(),
      now,
      capabilityStaleAfterMs: 5 * 60_000,
    });
    let didMutateState = false;

    for (const connection of this.state.connections.values()) {
      const nextConnection = {
        ...connection,
        ...(findUnsafeRemoteFleetPublicConfigKey(connection.publicConfig) ? { publicConfig: {} } : {}),
        ...(findUnsafeRemoteFleetEndpointUrlKey(connection.endpointUrl) ? { endpointUrl: undefined } : {}),
      };
      if (nextConnection.publicConfig !== connection.publicConfig || nextConnection.endpointUrl !== connection.endpointUrl) {
        this.state.connections.set(connection.id, { ...nextConnection, updatedAt: now });
        didMutateState = true;
      }
    }

    for (const environment of this.state.environments.values()) {
      const nextEnvironment = {
        ...environment,
        ...(environment.connectionId && !this.state.connections.has(environment.connectionId) ? { lifecycle: { reason: 'orphaned', message: 'Remote Fleet environment connection was missing during restore.' } as RemoteFleetEnvironmentRecord['lifecycle'] } : {}),
        ...(environment.nodeId && !this.state.nodes.has(environment.nodeId) ? { nodeId: undefined } : {}),
        ...(findUnsafeRemoteFleetPublicConfigKey(environment.publicConfig) ? { publicConfig: {} } : {}),
      };
      if (nextEnvironment.lifecycle !== environment.lifecycle || nextEnvironment.nodeId !== environment.nodeId || nextEnvironment.publicConfig !== environment.publicConfig) {
        this.state.environments.set(environment.id, { ...nextEnvironment, updatedAt: now });
        didMutateState = true;
      }
    }

    for (const managedResource of this.state.managedResources.values()) {
      const nextManagedResource = {
        ...managedResource,
        ...(managedResource.connectionId && !this.state.connections.has(managedResource.connectionId) ? { lifecycle: { reason: 'failed', message: 'Remote Fleet managed resource connection was missing during restore.' } as RemoteFleetManagedResourceRecord['lifecycle'] } : {}),
        ...(managedResource.environmentId && !this.state.environments.has(managedResource.environmentId) ? { lifecycle: { reason: 'failed', message: 'Remote Fleet managed resource environment was missing during restore.' } as RemoteFleetManagedResourceRecord['lifecycle'] } : {}),
        ...(managedResource.nodeId && !this.state.nodes.has(managedResource.nodeId) ? { nodeId: undefined } : {}),
      };
      if (nextManagedResource.lifecycle !== managedResource.lifecycle || nextManagedResource.nodeId !== managedResource.nodeId) {
        this.state.managedResources.set(managedResource.id, { ...nextManagedResource, updatedAt: now });
        didMutateState = true;
      }
    }

    for (const node of this.state.nodes.values()) {
      const nextNode = {
        ...node,
        ...(node.connectionId && !this.state.connections.has(node.connectionId) ? { connectionId: undefined } : {}),
        ...(findUnsafeRemoteFleetPublicConfigKey(node.publicConfig) ? { publicConfig: {} } : {}),
        ...(findUnsafeRemoteFleetEndpointUrlKey(node.endpointUrl) ? { endpointUrl: undefined } : {}),
      };
      if (nextNode.connectionId !== node.connectionId || nextNode.publicConfig !== node.publicConfig || nextNode.endpointUrl !== node.endpointUrl) {
        this.state.nodes.set(node.id, { ...nextNode, updatedAt: now });
        didMutateState = true;
      }
    }

    if (await this.reconcilePendingCredentialWriteOperations(now)) {
      didMutateState = true;
    }

    const expiredLeases = expireLeases({ leases: Array.from(this.state.leases.values()), now });
    if (expiredLeases.expiredRecords.length > 0) {
      replaceMapValues(this.state.leases, expiredLeases.records);
      didMutateState = true;
    }

    const expiredSessionIds = new Set<string>();
    for (const session of this.state.sessions.values()) {
      if (session.state.reason === 'opening' || session.state.reason === 'connected' || session.state.reason === 'closing') {
        this.state.sessions.set(session.id, {
          ...session,
          state: { reason: 'expired', expiredAt: now, message: 'Remote Fleet terminal session expired during runtime restore.' },
          updatedAt: now,
        });
        expiredSessionIds.add(session.id);
        didMutateState = true;
      }
    }
    if (expiredSessionIds.size > 0) {
      this.releaseSessionLeases(expiredSessionIds, now);
      didMutateState = true;
    }

    const staleCapabilityIds = new Set(plan.markStaleCapabilities.map((item) => item.targetIds.capabilityId).filter(Boolean));
    const prunedEndpointIds = new Set<string>();
    for (const item of plan.pruneRetiredEndpoints) {
      const endpoint = item.targetIds.endpointId ? this.state.endpoints.get(item.targetIds.endpointId) : undefined;
      if (endpoint) {
        await this.pruneCapabilityProjection(endpoint.scope, now);
        prunedEndpointIds.add(endpoint.id);
        didMutateState = true;
      }
    }

    for (const item of plan.markStaleCapabilities) {
      const capabilityId = item.targetIds.capabilityId;
      if (!capabilityId) {
        continue;
      }
      const capability = this.state.capabilities.get(capabilityId);
      if (!capability) {
        continue;
      }
      const endpoint = this.state.endpoints.get(capability.endpointId);
      if (endpoint && !prunedEndpointIds.has(endpoint.id)) {
        await this.pruneCapabilityProjection(endpoint.scope, now);
        prunedEndpointIds.add(endpoint.id);
      }
      this.state.capabilities.set(capability.id, item.reason === 'capability-observation-expired'
        ? markCapabilitySnapshotStale(capability, now, 'Capability observation expired during Remote Fleet reconcile.')
        : markCapabilitySnapshotPruned(capability, now));
      didMutateState = true;
    }

    for (const item of plan.restoreDescriptors) {
      const capabilityId = item.targetIds.capabilityId;
      const endpointId = item.targetIds.endpointId;
      if (!capabilityId || !endpointId || staleCapabilityIds.has(capabilityId)) {
        continue;
      }
      const capability = this.state.capabilities.get(capabilityId);
      const endpoint = this.state.endpoints.get(endpointId);
      if (capability && endpoint && capability.descriptors.length > 0 && endpoint.health.reason !== 'retired') {
        const descriptors = normalizeCapabilityDescriptorsForEndpoint(endpoint, capability.descriptors);
        await this.replaceCapabilityProjection(endpoint.scope, descriptors);
      }
    }

    if (didMutateState) {
      await this.persist();
    }
  }

  private async reconcilePendingCredentialWriteOperations(_now: string): Promise<boolean> {
    if (!this.deps.host) {
      return false;
    }

    let didMutateState = false;
    for (const operation of this.state.credentialWriteOperations.values()) {
      if (operation.state.reason !== 'pending') {
        continue;
      }
      const result = await this.deps.host.request({
        type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_METHOD,
        input: {
          operationId: operation.id,
          credentialName: operation.credentialName,
          credentialRef: operation.credentialRef,
        },
      }) as RemoteFleetSecretWriteStatusHostRpcResponse;
      if (!isCredentialWriteStatusResult(result)) {
        continue;
      }
      if (result.resultType === 'completed') {
        if (result.credentialName !== operation.credentialName || result.credentialRef.ref !== operation.credentialRef.ref) {
          continue;
        }
        if (this.completeCredentialWriteOperation({
          operationId: operation.id,
          credentialId: operation.credentialId,
          credentialName: operation.credentialName,
        }, {
          operationId: operation.id,
          credentialName: result.credentialName,
          credentialRef: result.credentialRef,
          writtenAt: result.writtenAt,
        })) {
          didMutateState = true;
        }
      }
    }
    return didMutateState;
  }

  private completeCredentialWriteOperation(
    input: Pick<RemoteFleetCredentialWriteRequestInput, 'operationId' | 'credentialId' | 'credentialName'>,
    receipt: RemoteFleetCredentialWriteReceipt,
  ): boolean {
    const operation = this.state.credentialWriteOperations.get(input.operationId);
    if (!operation || operation.state.reason !== 'pending' || !isMatchingCredentialWriteOperation(operation, input, receipt.credentialRef)) {
      return false;
    }
    this.state.credentialWriteOperations.set(operation.id, {
      ...operation,
      state: {
        reason: 'completed',
        requestedAt: operation.state.requestedAt,
        completedAt: receipt.writtenAt,
        receipt,
      },
      updatedAt: receipt.writtenAt,
    });
    this.audit('remoteFleet.credential.written', {
      message: `Remote Fleet credential ${receipt.credentialName} written.`,
      metadata: {
        operationId: receipt.operationId,
        credentialName: receipt.credentialName,
        credentialRef: receipt.credentialRef.ref,
      },
    });
    return true;
  }

  private async replaceCapabilityProjection(scope: RuntimeScope, descriptors: readonly CapabilityDescriptor[]): Promise<void> {
    if (!this.deps.host) {
      return;
    }
    await this.deps.host.request({
      type: 'host.capability.replaceForEndpointScope',
      scope,
      descriptors,
    });
  }

  private async pruneCapabilityProjection(scope: RuntimeScope, prunedAt = this.deps.clock.nowIso()): Promise<void> {
    if (this.deps.host) {
      await this.deps.host.request({
        type: 'host.capability.pruneEndpointScope',
        scope,
      });
    }
    this.markCapabilitySnapshotsPrunedForScope(scope, prunedAt);
  }

  private markCapabilitySnapshotsPrunedForScope(scope: RuntimeScope, prunedAt: string): void {
    const scopeKey = buildCapabilityScopeKey(scope);
    for (const capability of this.state.capabilities.values()) {
      const endpoint = this.state.endpoints.get(capability.endpointId);
      if (endpoint && buildCapabilityScopeKey(endpoint.scope) === scopeKey && capability.freshness.reason !== 'pruned') {
        this.state.capabilities.set(capability.id, markCapabilitySnapshotPruned(capability, prunedAt));
      }
    }
  }

  private async createEnrollmentContext(agent: RuntimeAgentRecord, nodeId: string, now: string): Promise<{
    readonly enrollment: RemoteFleetBootstrapEnrollmentContext;
    readonly tokenHash: string;
  }> {
    const token = `mrf_${this.deps.identity.randomToken(24)}`;
    const expiresAt = addMillisecondsToIso(now, 10 * 60_000);
    return {
      enrollment: {
        agentId: agent.id,
        nodeId,
        token,
        expiresAt,
        ...(this.deps.runtimeAgentIngressUrl ? { callbackUrl: this.deps.runtimeAgentIngressUrl } : {}),
      },
      tokenHash: await this.deps.identity.hashSecret(token),
    };
  }

  private async dispatchBootstrapCommandAndApplyResult(
    commandName: RemoteFleetBootstrapCommandName,
    command: RemoteFleetCommandRecord,
    node: RemoteFleetNodeRecord,
    agent: RuntimeAgentRecord,
    enrollment?: RemoteFleetBootstrapEnrollmentContext,
    environment?: RemoteFleetEnvironmentRecord,
    managedResource?: RemoteFleetManagedResourceRecord,
  ): Promise<RemoteFleetCommandRecord> {
    const envelope = createRemoteFleetBootstrapCommandEnvelope({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      commandName,
      node,
      agent,
      ...(node.connectionId && this.state.connections.has(node.connectionId) ? { connection: this.state.connections.get(node.connectionId)! } : {}),
      ...(environment ? { environment } : {}),
      ...(managedResource ? { managedResource } : {}),
      ...(enrollment ? { enrollment } : {}),
    });
    if (!envelope) {
      return await this.applyBootstrapCommandResult(command, {
        resultType: 'failed',
        commandId: command.id,
        reason: 'unsupported-target',
        message: 'Remote Fleet bootstrap provider unsupported for this node target.',
      });
    }

    const result = this.deps.host
      ? await this.dispatchBootstrapEnvelope(envelope)
      : createUnavailableBootstrapResult(envelope);
    return await this.applyBootstrapCommandResult(command, result);
  }

  private async dispatchBootstrapEnvelope(envelope: RemoteFleetBootstrapCommandEnvelope): Promise<RemoteFleetBootstrapCommandResult> {
    try {
      const result = await this.deps.host!.request({
        type: 'host.remoteFleetBootstrap.dispatchCommand',
        envelope,
      });
      return isRemoteFleetBootstrapCommandResult(result)
        ? result
        : createUnavailableBootstrapResult(envelope, 'Remote Fleet bootstrap provider returned an invalid result.');
    } catch {
      return createUnavailableBootstrapResult(envelope);
    }
  }

  private async dispatchConnectionProbeEnvelope(
    envelope: RemoteFleetConnectionProbeEnvelope,
  ): Promise<RemoteFleetConnectionProbeResult> {
    try {
      const result = await this.deps.host!.request({
        type: 'host.remoteFleetConnectionProbe.dispatch',
        envelope,
      });
      return isRemoteFleetConnectionProbeResult(result)
        ? result
        : createUnavailableConnectionProbeResult(envelope);
    } catch {
      return createUnavailableConnectionProbeResult(envelope);
    }
  }

  private async applyConnectionProbeResult(
    command: RemoteFleetCommandRecord,
    result: RemoteFleetConnectionProbeResult,
  ): Promise<RemoteFleetCommandRecord> {
    const completedAt = this.deps.clock.nowIso();
    const commandResult: RemoteFleetCommandResultInput = result.resultType === 'completed'
      ? { reason: 'succeeded', completedAt, message: 'Remote Fleet connection probe completed.' }
      : {
        reason: 'failed',
        completedAt,
        message: safeConnectionProbeFailureMessage(result.reason),
      };
    const updatedCommand = updateCommandWithResult(command, commandResult, completedAt);
    this.storeCommand(updatedCommand);
    const didApplyLifecycleResult = await this.applyCommandResult(updatedCommand, commandResult, completedAt);
    this.auditCommandResult(updatedCommand, commandResult, didApplyLifecycleResult);
    return updatedCommand;
  }

  private async applyBootstrapCommandResult(
    command: RemoteFleetCommandRecord,
    result: RemoteFleetBootstrapCommandResult,
  ): Promise<RemoteFleetCommandRecord> {
    const completedAt = this.deps.clock.nowIso();
    const commandResult = bootstrapResultToCommandResult(command.command, result, completedAt);
    const updatedCommand = updateCommandWithResult(command, commandResult, completedAt);
    this.storeCommand(updatedCommand);
    const didApplyLifecycleResult = await this.applyCommandResult(updatedCommand, commandResult, completedAt);
    this.auditCommandResult(updatedCommand, commandResult, didApplyLifecycleResult);
    return updatedCommand;
  }

  private async failQueuedCommand(command: RemoteFleetCommandRecord, message: string): Promise<RemoteFleetCommandRecord> {
    const completedAt = this.deps.clock.nowIso();
    const result: RemoteFleetCommandResultInput = { reason: 'failed', completedAt, message };
    const updatedCommand = updateCommandWithResult(command, result, completedAt);
    this.storeCommand(updatedCommand);
    const didApplyLifecycleResult = await this.applyCommandResult(updatedCommand, result, completedAt);
    this.auditCommandResult(updatedCommand, result, didApplyLifecycleResult);
    return updatedCommand;
  }

  private hasRuntimeAgentDispatchTarget(command: RemoteFleetCommandRecord): boolean {
    const result = buildRemoteFleetCommandDispatchEnvelope({
      command,
      ...(command.nodeId ? { node: this.state.nodes.get(command.nodeId) } : {}),
      ...(command.runtimeId ? { runtime: this.state.runtimes.get(command.runtimeId) } : {}),
      ...(command.endpointId ? { endpoint: this.state.endpoints.get(command.endpointId) } : {}),
    });
    return result.resultType === 'built' && Boolean(result.envelope.dispatchTarget);
  }

  private async dispatchQueuedCommand(command: RemoteFleetCommandRecord): Promise<RemoteFleetCommandRecord> {
    if (!this.deps.host) {
      return await this.failQueuedCommand(command, 'Remote Fleet RuntimeAgent dispatcher is unavailable.');
    }
    const result = buildRemoteFleetCommandDispatchEnvelope({
      command,
      ...(command.nodeId ? { node: this.state.nodes.get(command.nodeId) } : {}),
      ...(command.runtimeId ? { runtime: this.state.runtimes.get(command.runtimeId) } : {}),
      ...(command.endpointId ? { endpoint: this.state.endpoints.get(command.endpointId) } : {}),
    });
    if (result.resultType !== 'built') {
      return await this.failQueuedCommand(command, 'Remote Fleet command dispatch configuration is invalid.');
    }
    try {
      const dispatchResult = await this.deps.host.request({
        type: 'host.runtimeAgent.dispatchCommand',
        envelope: result.envelope,
      });
      if (isRemoteFleetRuntimeAgentDispatchAccepted(dispatchResult)) {
        return command;
      }
    } catch {
      // The command state is closed below with an opaque, recoverable failure.
    }
    return await this.failQueuedCommand(command, 'Remote Fleet RuntimeAgent dispatcher is unavailable.');
  }

  private snapshot(): RemoteFleetSnapshot {
    return {
      connections: Array.from(this.state.connections.values()).map(summarizeConnection).sort(compareById),
      environments: Array.from(this.state.environments.values()).map(summarizeEnvironment).sort(compareById),
      managedResources: Array.from(this.state.managedResources.values()).map(summarizeManagedResource).sort(compareById),
      nodes: Array.from(this.state.nodes.values()).map(summarizeNode).sort(compareById),
      agents: Array.from(this.state.agents.values()).map(summarizeAgent).sort(compareById),
      runtimes: Array.from(this.state.runtimes.values()).map(summarizeRuntime).sort(compareById),
      endpoints: Array.from(this.state.endpoints.values()).map(summarizeEndpoint).sort(compareById),
      capabilities: Array.from(this.state.capabilities.values()).map(summarizeCapability).sort(compareById),
      commands: this.listCommands(),
      leases: this.listLeases(),
      sessions: this.listTerminalSessions(),
      auditEvents: this.listAuditEvents(),
      updatedAt: this.deps.clock.nowIso(),
    };
  }

  private listCommands(): readonly RemoteFleetCommandSummary[] {
    return summarizeRecentProjection(this.state.commandProjectionOrder, this.state.commands, summarizeCommand);
  }

  private listLeases(): readonly RemoteFleetLeaseSummary[] {
    return Array.from(this.state.leases.values()).map(summarizeLease).sort(compareById);
  }

  private listTerminalSessions(): readonly RemoteFleetTerminalSessionSummary[] {
    return Array.from(this.state.sessions.values()).map(summarizeTerminalSession).sort(compareByUpdatedAtDescThenId);
  }

  private listAuditEvents(): readonly RemoteFleetAuditEventSummary[] {
    return summarizeRecentProjection(this.state.auditEventProjectionOrder, this.state.auditEvents, summarizeAuditEvent);
  }

  private queueCommand(input: {
    readonly command: string;
    readonly connectionId?: string;
    readonly environmentId?: string;
    readonly managedResourceId?: string;
    readonly nodeId?: string;
    readonly agentId?: string;
    readonly runtimeId?: string;
    readonly endpointId?: string;
    readonly message?: string;
    readonly metadata?: Record<string, unknown>;
  }): RemoteFleetCommandRecord {
    const now = this.deps.clock.nowIso();
    const command: RemoteFleetCommandRecord = {
      id: this.deps.identity.randomId('cmd'),
      idempotencyKey: this.deps.identity.randomId('idem'),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.managedResourceId ? { managedResourceId: input.managedResourceId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      command: input.command,
      state: { reason: 'queued', queuedAt: now },
      createdAt: now,
      updatedAt: now,
      ...(input.message ? { message: input.message } : {}),
    };
    this.storeCommand(command);
    this.audit('remoteFleet.command.queued', {
      connectionId: input.connectionId,
      environmentId: input.environmentId,
      managedResourceId: input.managedResourceId,
      nodeId: input.nodeId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      endpointId: input.endpointId,
      commandId: command.id,
      message: input.message,
      metadata: input.metadata,
    });
    return command;
  }

  private completeCommand(input: {
    readonly command: string;
    readonly connectionId?: string;
    readonly environmentId?: string;
    readonly managedResourceId?: string;
    readonly nodeId?: string;
    readonly agentId?: string;
    readonly runtimeId?: string;
    readonly endpointId?: string;
    readonly didSucceed?: boolean;
    readonly message?: string;
    readonly metadata?: Record<string, unknown>;
  }): RemoteFleetCommandRecord {
    const now = this.deps.clock.nowIso();
    const didSucceed = input.didSucceed ?? true;
    const state: RemoteFleetCommandState = didSucceed
      ? { reason: 'succeeded', completedAt: now }
      : { reason: 'failed', completedAt: now, message: input.message ?? 'Remote Fleet command failed.' };
    const command: RemoteFleetCommandRecord = {
      id: this.deps.identity.randomId('cmd'),
      idempotencyKey: this.deps.identity.randomId('idem'),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.managedResourceId ? { managedResourceId: input.managedResourceId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      command: input.command,
      state,
      createdAt: now,
      updatedAt: now,
      ...(input.message ? { message: input.message } : {}),
    };
    this.storeCommand(command);
    this.audit('remoteFleet.command.completed', {
      connectionId: input.connectionId,
      environmentId: input.environmentId,
      managedResourceId: input.managedResourceId,
      nodeId: input.nodeId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      endpointId: input.endpointId,
      commandId: command.id,
      message: input.message,
      metadata: input.metadata,
    });
    return command;
  }

  private audit(eventName: RemoteFleetAuditEventName, input: {
    readonly actorId?: string;
    readonly connectionId?: string;
    readonly environmentId?: string;
    readonly managedResourceId?: string;
    readonly nodeId?: string;
    readonly agentId?: string;
    readonly runtimeId?: string;
    readonly endpointId?: string;
    readonly commandId?: string;
    readonly message?: string;
    readonly metadata?: Record<string, unknown>;
  }): void {
    const event = {
      ...createRemoteFleetAuditEventRecord({
        id: this.deps.identity.randomId('audit'),
        eventName,
        occurredAt: this.deps.clock.nowIso(),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
        ...(input.endpointId ? { endpointId: input.endpointId } : {}),
        ...(input.commandId ? { commandId: input.commandId } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.managedResourceId ? { managedResourceId: input.managedResourceId } : {}),
    };
    this.storeAuditEvent(event);
  }

  private storeCommand(command: RemoteFleetCommandRecord): void {
    const isNewCommand = !this.state.commands.has(command.id);
    this.state.commands.set(command.id, command);
    if (isNewCommand) {
      appendRecentProjectionId(this.state.commandProjectionOrder, command.id);
    }
  }

  private storeAuditEvent(event: RemoteFleetAuditEventRecord): void {
    const isNewAuditEvent = !this.state.auditEvents.has(event.id);
    this.state.auditEvents.set(event.id, event);
    if (isNewAuditEvent) {
      appendRecentProjectionId(this.state.auditEventProjectionOrder, event.id);
    }
  }

  private validateCommandAck(input: Record<string, unknown>, command: RemoteFleetCommandRecord): string | null {
    if (!command.agentId) {
      return 'Remote Fleet command ACK requires a command owned by a RuntimeAgent.';
    }
    const agentId = readOptionalString(input, 'agentId');
    if (!agentId) {
      return 'Remote Fleet command ACK requires agentId.';
    }
    const idempotencyKey = readOptionalString(input, REMOTE_FLEET_ACK_IDEMPOTENCY_KEY_FIELD)
      ?? readOptionalString(readRecord(input.result), REMOTE_FLEET_ACK_IDEMPOTENCY_KEY_FIELD);
    if (!idempotencyKey) {
      return `Remote Fleet command ACK requires ${REMOTE_FLEET_ACK_IDEMPOTENCY_KEY_FIELD}.`;
    }
    return idempotencyKey === command.idempotencyKey
      ? null
      : 'Remote Fleet command ACK idempotencyKey does not match command ownership.';
  }

  private evaluateCommandPolicy(input: {
    readonly node?: RemoteFleetNodeRecord;
    readonly runtime?: RuntimeInstanceRecord;
    readonly command: {
      readonly command: string;
      readonly nodeId?: string;
      readonly runtimeId?: string;
      readonly runtimeKind?: string;
    };
  }): RemoteFleetCommandPolicyDecision {
    return evaluateRemoteFleetCommandPolicy({
      ...(input.node ? { node: input.node } : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      command: input.command,
      policy: {
        supportedRuntimeKinds: ['openclaw', 'matcha-agent', 'plugin-runtime'],
      },
    });
  }

  private completePolicyDeniedCommand(policyDecision: Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'denied' }>): RemoteFleetCommandRecord {
    return this.completeCommand({
      command: policyDecision.commandKind ?? 'command-policy',
      nodeId: policyDecision.nodeId,
      runtimeId: policyDecision.runtimeId,
      didSucceed: false,
      message: policyDecision.message,
      metadata: { policyDecision },
    });
  }

  private auditCommandResult(
    command: RemoteFleetCommandRecord,
    result: RemoteFleetCommandResultInput,
    didApplyLifecycleResult: boolean,
  ): void {
    if (result.reason !== 'succeeded') {
      this.audit('remoteFleet.command.completed', {
        connectionId: command.connectionId,
        environmentId: command.environmentId,
        managedResourceId: command.managedResourceId,
        nodeId: command.nodeId,
        agentId: command.agentId,
        runtimeId: command.runtimeId,
        endpointId: command.endpointId,
        commandId: command.id,
        message: result.message ?? 'Remote Fleet command failed.',
      });
      return;
    }

    switch (command.command) {
      case 'install-agent':
        this.audit('remoteFleet.command.completed', { connectionId: command.connectionId, environmentId: command.environmentId, managedResourceId: command.managedResourceId, nodeId: command.nodeId, agentId: command.agentId, commandId: command.id, message: result.message ?? 'Remote Fleet bootstrap command completed.' });
        return;
      case 'start-runtime':
        if (didApplyLifecycleResult) {
          this.audit('remoteFleet.runtime.started', { connectionId: command.connectionId, environmentId: command.environmentId, managedResourceId: command.managedResourceId, nodeId: command.nodeId, agentId: command.agentId, runtimeId: command.runtimeId, endpointId: command.endpointId, commandId: command.id });
        }
        return;
      case 'stop-runtime':
        if (didApplyLifecycleResult) {
          this.audit('remoteFleet.runtime.stopped', { connectionId: command.connectionId, environmentId: command.environmentId, managedResourceId: command.managedResourceId, nodeId: command.nodeId, agentId: command.agentId, runtimeId: command.runtimeId, endpointId: command.endpointId, commandId: command.id });
        }
        return;
      default:
        this.audit('remoteFleet.command.completed', { connectionId: command.connectionId, environmentId: command.environmentId, managedResourceId: command.managedResourceId, nodeId: command.nodeId, agentId: command.agentId, runtimeId: command.runtimeId, endpointId: command.endpointId, commandId: command.id });
    }
  }

  private async applyCommandResult(
    command: RemoteFleetCommandRecord,
    result: RemoteFleetCommandResultInput,
    completedAt: string,
  ): Promise<boolean> {
    switch (command.command) {
      case 'install-agent':
        this.applyInstallAgentCommandResult(command, result, completedAt);
        return true;
      case 'deploy-environment':
        this.applyDeployEnvironmentCommandResult(command, result, completedAt);
        return true;
      case 'delete-environment':
        this.applyDeleteEnvironmentCommandResult(command, result, completedAt);
        return true;
      case 'probe-node':
        this.applyProbeNodeCommandResult(command, result, completedAt);
        return true;
      case 'probe-connection':
        this.applyProbeConnectionCommandResult(command, result, completedAt);
        return true;
      case 'start-runtime':
        return await this.applyStartRuntimeCommandResult(command, result, completedAt);
      case 'stop-runtime':
        return await this.applyStopRuntimeCommandResult(command, result, completedAt);
      default:
        return true;
    }
  }

  private applyInstallAgentCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): void {
    if (!command.agentId) {
      return;
    }
    const agent = this.state.agents.get(command.agentId);
    if (!agent) {
      return;
    }
    this.state.agents.set(agent.id, {
      ...agent,
      enrollment: result.reason === 'succeeded'
        ? this.completedInstallAgentEnrollment(command, result, completedAt)
        : { reason: 'failed', message: result.message ?? 'RuntimeAgent install failed.' },
      ...(result.reason === 'succeeded' ? {} : { enrollmentTokenHash: undefined, enrollmentTokenExpiresAt: undefined }),
      updatedAt: completedAt,
    });
  }

  private completedInstallAgentEnrollment(
    command: RemoteFleetCommandRecord,
    result: RemoteFleetCommandResultInput,
    completedAt: string,
  ): RuntimeAgentEnrollmentState {
    const node = command.nodeId ? this.state.nodes.get(command.nodeId) : undefined;
    return node?.targetKind === 'container'
      ? { reason: 'environment-ready', readyAt: completedAt }
      : { reason: 'installed', installedAt: completedAt };
  }

  private applyDeployEnvironmentCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): void {
    if (!command.environmentId) {
      return;
    }
    const environment = this.state.environments.get(command.environmentId);
    if (!environment) {
      return;
    }
    const agent = command.agentId ? this.state.agents.get(command.agentId) : undefined;
    if (result.reason !== 'succeeded') {
      this.state.environments.set(environment.id, {
        ...environment,
        lifecycle: { reason: 'failed', message: result.message ?? 'Remote Fleet environment deploy failed.' },
        updatedAt: completedAt,
      });
      if (agent) {
        this.state.agents.set(agent.id, {
          ...agent,
          enrollment: { reason: 'failed', message: result.message ?? 'Remote Fleet environment deploy failed.' },
          enrollmentTokenHash: undefined,
          enrollmentTokenExpiresAt: undefined,
          updatedAt: completedAt,
        });
      }
      return;
    }

    if (agent) {
      const node = command.nodeId ? this.state.nodes.get(command.nodeId) : undefined;
      this.state.agents.set(agent.id, {
        ...agent,
        enrollment: node?.targetKind === 'container'
          ? { reason: 'environment-ready', readyAt: completedAt }
          : { reason: 'installed', installedAt: completedAt },
        updatedAt: completedAt,
      });
    }

    const managedResourceIds = this.upsertManagedResourcesFromDeployResult(command, environment, result, completedAt);
    const primaryManagedResourceId = managedResourceIds[0] ?? environment.managedResourceIds[0];
    if (command.nodeId && primaryManagedResourceId) {
      this.bindManagedResourceToNodeGraph(command.nodeId, primaryManagedResourceId, environment.id, completedAt);
    }
    this.state.environments.set(environment.id, {
      ...environment,
      lifecycle: { reason: 'ready', readyAt: completedAt },
      managedResourceIds,
      updatedAt: completedAt,
    });
    this.audit('remoteFleet.environment.deployed', {
      connectionId: environment.connectionId,
      environmentId: environment.id,
      nodeId: command.nodeId,
      agentId: command.agentId,
      runtimeId: command.runtimeId,
      commandId: command.id,
    });
  }

  private applyDeleteEnvironmentCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): void {
    if (!command.environmentId || !command.managedResourceId) {
      return;
    }
    const managedResource = this.state.managedResources.get(command.managedResourceId);
    if (!managedResource) {
      return;
    }
    if (result.reason !== 'succeeded') {
      this.state.managedResources.set(managedResource.id, {
        ...managedResource,
        lifecycle: { reason: 'failed', message: result.message ?? 'Remote Fleet managed resource cleanup failed.' },
        updatedAt: completedAt,
      });
      this.audit('remoteFleet.managedResource.failed', {
        connectionId: managedResource.connectionId,
        environmentId: managedResource.environmentId,
        managedResourceId: managedResource.id,
        nodeId: managedResource.nodeId,
        commandId: command.id,
        message: result.message ?? 'Remote Fleet managed resource cleanup failed.',
      });
      return;
    }

    this.state.managedResources.set(managedResource.id, {
      ...managedResource,
      lifecycle: { reason: 'deleted', deletedAt: completedAt },
      updatedAt: completedAt,
    });
    this.audit('remoteFleet.managedResource.deleted', {
      connectionId: managedResource.connectionId,
      environmentId: managedResource.environmentId,
      managedResourceId: managedResource.id,
      nodeId: managedResource.nodeId,
      commandId: command.id,
    });
  }

  private applyProbeConnectionCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): void {
    if (!command.connectionId) {
      return;
    }
    const connection = this.state.connections.get(command.connectionId);
    if (!connection) {
      return;
    }
    this.state.connections.set(connection.id, {
      ...connection,
      health: result.reason === 'succeeded'
        ? { reason: 'online', lastSeenAt: completedAt }
        : { reason: 'offline', lastSeenAt: completedAt, message: result.message ?? 'Remote Fleet connection probe failed.' },
      updatedAt: completedAt,
    });
  }

  private applyProbeNodeCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): void {
    if (!command.nodeId) {
      return;
    }
    const node = this.state.nodes.get(command.nodeId);
    if (!node) {
      return;
    }
    this.state.nodes.set(node.id, {
      ...node,
      health: result.reason === 'succeeded'
        ? { reason: 'online', lastSeenAt: completedAt }
        : { reason: 'offline', lastSeenAt: completedAt, message: result.message ?? 'Remote Fleet node probe failed.' },
      updatedAt: completedAt,
    });
  }

  private async applyStartRuntimeCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): Promise<boolean> {
    if (!command.runtimeId) {
      return false;
    }
    const runtime = this.state.runtimes.get(command.runtimeId);
    if (!runtime || runtime.lifecycle.reason !== 'starting' || runtime.lifecycle.commandId !== command.id) {
      return false;
    }
    if (result.reason !== 'succeeded') {
      this.state.runtimes.set(runtime.id, {
        ...runtime,
        lifecycle: { reason: 'degraded', message: result.message ?? 'Remote runtime start failed.' },
        updatedAt: completedAt,
      });
      if (runtime.endpointId) {
        const endpoint = this.state.endpoints.get(runtime.endpointId);
        if (endpoint) {
          await this.pruneCapabilityProjection(endpoint.scope, completedAt);
          this.state.endpoints.set(endpoint.id, { ...endpoint, health: { reason: 'unhealthy', message: result.message ?? 'Remote runtime start failed.', lastProbeAt: completedAt }, updatedAt: completedAt });
          this.releaseLeasesForEndpoint(endpoint.id, completedAt);
        }
      }
      return true;
    }

    const endpoint = this.state.endpoints.get(command.endpointId ?? `${runtime.id}:endpoint`) ?? createEndpointForRuntime(runtime, completedAt);
    this.state.endpoints.set(endpoint.id, {
      ...endpoint,
      ...(runtime.connectionId ? { connectionId: runtime.connectionId } : {}),
      ...(runtime.environmentId ? { environmentId: runtime.environmentId } : {}),
      ...(runtime.managedResourceId ? { managedResourceId: runtime.managedResourceId } : {}),
      health: { reason: 'ready', lastProbeAt: completedAt },
      updatedAt: completedAt,
    });
    this.state.runtimes.set(runtime.id, {
      ...runtime,
      endpointId: endpoint.id,
      lifecycle: { reason: 'running', startedAt: completedAt },
      updatedAt: completedAt,
    });
    await this.syncCapabilitiesForEndpoint(this.state.endpoints.get(endpoint.id)!, completedAt);
    return true;
  }

  private async applyStopRuntimeCommandResult(command: RemoteFleetCommandRecord, result: RemoteFleetCommandResultInput, completedAt: string): Promise<boolean> {
    if (!command.runtimeId) {
      return false;
    }
    const runtime = this.state.runtimes.get(command.runtimeId);
    if (!runtime || runtime.lifecycle.reason !== 'stopping' || runtime.lifecycle.commandId !== command.id) {
      return false;
    }
    if (result.reason !== 'succeeded') {
      this.state.runtimes.set(runtime.id, {
        ...runtime,
        lifecycle: { reason: 'degraded', message: result.message ?? 'Remote runtime stop failed.' },
        updatedAt: completedAt,
      });
      return true;
    }

    this.state.runtimes.set(runtime.id, {
      ...runtime,
      lifecycle: { reason: 'stopped', stoppedAt: completedAt },
      updatedAt: completedAt,
    });
    if (runtime.endpointId) {
      const endpoint = this.state.endpoints.get(runtime.endpointId);
      if (endpoint) {
        await this.pruneCapabilityProjection(endpoint.scope, completedAt);
        this.state.endpoints.set(endpoint.id, { ...endpoint, health: { reason: 'retired', retiredAt: completedAt }, updatedAt: completedAt });
        this.releaseLeasesForEndpoint(endpoint.id, completedAt);
      }
    }
    return true;
  }

  private upsertManagedResourcesFromDeployResult(
    command: RemoteFleetCommandRecord,
    environment: RemoteFleetEnvironmentRecord,
    result: RemoteFleetCommandResultInput,
    observedAt: string,
  ): readonly string[] {
    const resultManagedResources = buildManagedResourcesFromDeployResult(command, environment, result, observedAt);
    const managedResourceIds: string[] = [];
    for (const managedResource of resultManagedResources) {
      this.state.managedResources.set(managedResource.id, managedResource);
      managedResourceIds.push(managedResource.id);
      this.audit('remoteFleet.managedResource.provisioned', {
        connectionId: managedResource.connectionId,
        environmentId: managedResource.environmentId,
        managedResourceId: managedResource.id,
        nodeId: managedResource.nodeId,
        commandId: command.id,
      });
    }
    return managedResourceIds.length > 0 ? managedResourceIds : environment.managedResourceIds;
  }

  private bindManagedResourceToNodeGraph(
    nodeId: string,
    managedResourceId: string,
    environmentId: string,
    updatedAt: string,
  ): void {
    const managedResource = this.state.managedResources.get(managedResourceId);
    const node = this.state.nodes.get(nodeId);
    if (!managedResource || managedResource.environmentId !== environmentId || !node || node.environmentId !== environmentId) {
      return;
    }
    const updatedNode = { ...node, managedResourceId, updatedAt };
    this.state.nodes.set(node.id, updatedNode);
    this.state.managedResources.set(managedResource.id, { ...managedResource, nodeId: node.id, updatedAt });
    for (const agent of this.state.agents.values()) {
      if (agent.nodeId === nodeId && agent.environmentId === environmentId) {
        this.state.agents.set(agent.id, { ...agent, managedResourceId, updatedAt });
      }
    }
    for (const runtime of this.state.runtimes.values()) {
      if (runtime.nodeId === nodeId && runtime.environmentId === environmentId) {
        this.state.runtimes.set(runtime.id, { ...runtime, managedResourceId, updatedAt });
      }
    }
    for (const endpoint of this.state.endpoints.values()) {
      if (endpoint.nodeId === nodeId && endpoint.environmentId === environmentId) {
        this.state.endpoints.set(endpoint.id, { ...endpoint, managedResourceId, updatedAt });
      }
    }
    for (const capability of this.state.capabilities.values()) {
      if (capability.nodeId === nodeId && capability.environmentId === environmentId) {
        this.state.capabilities.set(capability.id, { ...capability, managedResourceId });
      }
    }
  }

  private listManagedResourcesForEnvironment(environmentId: string): readonly RemoteFleetManagedResourceRecord[] {
    return Array.from(this.state.managedResources.values()).filter((resource) => resource.environmentId === environmentId);
  }

  private resolveEnvironmentOwnedGraph(environment: RemoteFleetEnvironmentRecord): {
    readonly node?: RemoteFleetNodeRecord;
    readonly agent?: RuntimeAgentRecord;
    readonly runtime?: RuntimeInstanceRecord;
  } {
    const node = environment.nodeId ? this.state.nodes.get(environment.nodeId) : undefined;
    if (!node || node.environmentId !== environment.id) {
      return {};
    }
    const agent = Array.from(this.state.agents.values()).find((candidate) =>
      candidate.nodeId === node.id && candidate.environmentId === environment.id,
    );
    const runtime = Array.from(this.state.runtimes.values()).find((candidate) =>
      candidate.nodeId === node.id && candidate.environmentId === environment.id,
    );
    return {
      node,
      ...(agent ? { agent } : {}),
      ...(runtime ? { runtime } : {}),
    };
  }

  private async retireEnvironmentRuntimeProjection(environment: RemoteFleetEnvironmentRecord, now: string): Promise<void> {
    const endpoints = Array.from(this.state.endpoints.values()).filter((endpoint) => endpoint.environmentId === environment.id);
    for (const endpoint of endpoints) {
      await this.pruneCapabilityProjection(endpoint.scope, now);
      this.state.endpoints.set(endpoint.id, { ...endpoint, health: { reason: 'retired', retiredAt: now }, updatedAt: now });
      this.releaseLeasesForEndpoint(endpoint.id, now);
    }
    for (const runtime of this.state.runtimes.values()) {
      if (runtime.environmentId === environment.id) {
        this.state.runtimes.set(runtime.id, { ...runtime, lifecycle: { reason: 'retired', retiredAt: now }, updatedAt: now });
      }
    }
  }

  private async closeTerminalSessionsForEnvironment(environment: RemoteFleetEnvironmentRecord, now: string): Promise<void> {
    const sessions = Array.from(this.state.sessions.values()).filter((session) => session.environmentId === environment.id);
    for (const session of sessions) {
      if (session.state.reason === 'closed' || session.state.reason === 'failed' || session.state.reason === 'expired') {
        continue;
      }
      const closingSession = this.updateTerminalSession(session, { reason: 'closing', closingAt: now }, now);
      const closeResult = await this.requestTerminalSessionClose(closingSession, 'environment-delete');
      const closedSession = this.closeTerminalSessionRecord(closingSession, now, closeResult.message ?? 'Closed during Remote Fleet environment delete.');
      this.audit('remoteFleet.terminal.closed', {
        connectionId: closedSession.connectionId,
        environmentId: closedSession.environmentId,
        managedResourceId: closedSession.managedResourceId,
        nodeId: closedSession.nodeId,
        runtimeId: closedSession.runtimeId,
        endpointId: closedSession.endpointId,
        message: closeResult.message,
        metadata: { sessionId: closedSession.id, action: 'environment-delete' },
      });
    }
  }

  private connectionHasAssociatedRecords(connectionId: string): boolean {
    const relatedEnvironmentIds = new Set(
      Array.from(this.state.environments.values())
        .filter((environment) => environment.connectionId === connectionId)
        .map((environment) => environment.id),
    );
    const relatedManagedResourceIds = new Set(
      Array.from(this.state.managedResources.values())
        .filter((resource) => resource.connectionId === connectionId || relatedEnvironmentIds.has(resource.environmentId))
        .map((resource) => resource.id),
    );
    const relatedNodeIds = new Set(
      Array.from(this.state.nodes.values())
        .filter((node) => node.connectionId === connectionId || Boolean(node.environmentId && relatedEnvironmentIds.has(node.environmentId)) || Boolean(node.managedResourceId && relatedManagedResourceIds.has(node.managedResourceId)))
        .map((node) => node.id),
    );
    const relatedRuntimeIds = new Set(
      Array.from(this.state.runtimes.values())
        .filter((runtime) => runtime.connectionId === connectionId || Boolean(runtime.environmentId && relatedEnvironmentIds.has(runtime.environmentId)) || Boolean(runtime.managedResourceId && relatedManagedResourceIds.has(runtime.managedResourceId)) || Boolean(runtime.nodeId && relatedNodeIds.has(runtime.nodeId)))
        .map((runtime) => runtime.id),
    );
    const relatedEndpointIds = new Set(
      Array.from(this.state.endpoints.values())
        .filter((endpoint) => endpoint.connectionId === connectionId || Boolean(endpoint.environmentId && relatedEnvironmentIds.has(endpoint.environmentId)) || Boolean(endpoint.managedResourceId && relatedManagedResourceIds.has(endpoint.managedResourceId)) || Boolean(endpoint.nodeId && relatedNodeIds.has(endpoint.nodeId)) || Boolean(endpoint.runtimeId && relatedRuntimeIds.has(endpoint.runtimeId)))
        .map((endpoint) => endpoint.id),
    );

    return relatedEnvironmentIds.size > 0
      || relatedManagedResourceIds.size > 0
      || relatedNodeIds.size > 0
      || Array.from(this.state.agents.values()).some((agent) => agent.connectionId === connectionId || Boolean(agent.environmentId && relatedEnvironmentIds.has(agent.environmentId)) || Boolean(agent.managedResourceId && relatedManagedResourceIds.has(agent.managedResourceId)) || Boolean(agent.nodeId && relatedNodeIds.has(agent.nodeId)))
      || relatedRuntimeIds.size > 0
      || relatedEndpointIds.size > 0
      || Array.from(this.state.capabilities.values()).some((capability) => capability.connectionId === connectionId || Boolean(capability.environmentId && relatedEnvironmentIds.has(capability.environmentId)) || Boolean(capability.managedResourceId && relatedManagedResourceIds.has(capability.managedResourceId)) || Boolean(capability.nodeId && relatedNodeIds.has(capability.nodeId)) || Boolean(capability.runtimeId && relatedRuntimeIds.has(capability.runtimeId)) || Boolean(capability.endpointId && relatedEndpointIds.has(capability.endpointId)))
      || Array.from(this.state.sessions.values()).some((session) => (
        session.state.reason !== 'closed'
        && session.state.reason !== 'failed'
        && session.state.reason !== 'expired'
        && (
          session.connectionId === connectionId
          || Boolean(session.environmentId && relatedEnvironmentIds.has(session.environmentId))
          || Boolean(session.managedResourceId && relatedManagedResourceIds.has(session.managedResourceId))
          || Boolean(session.nodeId && relatedNodeIds.has(session.nodeId))
          || Boolean(session.runtimeId && relatedRuntimeIds.has(session.runtimeId))
          || Boolean(session.endpointId && relatedEndpointIds.has(session.endpointId))
        )
      ));
  }

  private markEnvironmentDeletionFailed(environmentId: string, now: string): RemoteFleetEnvironmentRecord {
    const environment = this.state.environments.get(environmentId)!;
    const failedEnvironment: RemoteFleetEnvironmentRecord = {
      ...environment,
      lifecycle: { reason: 'failed', message: 'Remote Fleet environment delete failed for one or more managed resources.' },
      updatedAt: now,
    };
    this.state.environments.set(environment.id, failedEnvironment);
    return failedEnvironment;
  }

  private async removeEnvironmentCanonicalRecords(environmentId: string, now: string): Promise<void> {
    const managedResourceIds = new Set(
      this.listManagedResourcesForEnvironment(environmentId).map((resource) => resource.id),
    );
    const nodeIds = new Set(
      Array.from(this.state.nodes.values())
        .filter((node) => node.environmentId === environmentId || Boolean(node.managedResourceId && managedResourceIds.has(node.managedResourceId)))
        .map((node) => node.id),
    );
    const runtimeIds = new Set(
      Array.from(this.state.runtimes.values())
        .filter((runtime) => runtime.environmentId === environmentId || Boolean(runtime.nodeId && nodeIds.has(runtime.nodeId)) || Boolean(runtime.managedResourceId && managedResourceIds.has(runtime.managedResourceId)))
        .map((runtime) => runtime.id),
    );
    const endpoints = Array.from(this.state.endpoints.values()).filter((endpoint) => (
      endpoint.environmentId === environmentId
      || Boolean(endpoint.nodeId && nodeIds.has(endpoint.nodeId))
      || Boolean(endpoint.runtimeId && runtimeIds.has(endpoint.runtimeId))
      || Boolean(endpoint.managedResourceId && managedResourceIds.has(endpoint.managedResourceId))
    ));
    const endpointIds = new Set(endpoints.map((endpoint) => endpoint.id));

    for (const endpoint of endpoints) {
      await this.pruneCapabilityProjection(endpoint.scope, now);
      this.releaseLeasesForEndpoint(endpoint.id, now);
      this.state.endpoints.delete(endpoint.id);
    }
    for (const capability of this.state.capabilities.values()) {
      if (
        capability.environmentId === environmentId
        || Boolean(capability.managedResourceId && managedResourceIds.has(capability.managedResourceId))
        || Boolean(capability.nodeId && nodeIds.has(capability.nodeId))
        || Boolean(capability.runtimeId && runtimeIds.has(capability.runtimeId))
        || Boolean(capability.endpointId && endpointIds.has(capability.endpointId))
      ) {
        this.state.capabilities.delete(capability.id);
      }
    }
    for (const runtime of this.state.runtimes.values()) {
      if (runtimeIds.has(runtime.id)) {
        this.state.runtimes.delete(runtime.id);
      }
    }
    for (const agent of this.state.agents.values()) {
      if (agent.environmentId === environmentId || Boolean(agent.nodeId && nodeIds.has(agent.nodeId)) || Boolean(agent.managedResourceId && managedResourceIds.has(agent.managedResourceId))) {
        this.state.agents.delete(agent.id);
      }
    }
    for (const node of this.state.nodes.values()) {
      if (nodeIds.has(node.id)) {
        this.state.nodes.delete(node.id);
      }
    }
    for (const managedResource of this.state.managedResources.values()) {
      if (managedResourceIds.has(managedResource.id)) {
        this.state.managedResources.delete(managedResource.id);
      }
    }
    this.state.environments.delete(environmentId);
  }

  private acquireLease(input: {
    readonly endpointId: string;
    readonly ownerKind: RemoteFleetLeaseRecord['ownerKind'];
    readonly ownerId: string;
    readonly now: string;
    readonly ttlMs: number;
  }): RemoteFleetLeaseRecord {
    const lease = acquireLeaseRecord({
      leaseId: this.deps.identity.randomId('lease'),
      endpointId: input.endpointId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      now: input.now,
      ttlMs: input.ttlMs,
    });
    this.state.leases.set(lease.id, lease);
    return lease;
  }

  private releaseLeasesForEndpoint(endpointId: string, now: string): void {
    const result = releaseLeaseRecordsForEndpoint({ leases: Array.from(this.state.leases.values()), endpointId, now });
    replaceMapValues(this.state.leases, result.records);
  }

  private releaseSessionLease(session: RemoteFleetTerminalSessionRecord, now: string): void {
    this.releaseSessionLeases(new Set([session.id]), now);
  }

  private releaseSessionLeases(sessionIds: ReadonlySet<string>, now: string): void {
    const records = Array.from(this.state.leases.values()).map((lease): RemoteFleetLeaseRecord => {
      if (lease.ownerKind !== 'session' || !sessionIds.has(lease.ownerId) || lease.state.reason !== 'active') {
        return lease;
      }
      return {
        ...lease,
        state: { reason: 'released', releasedAt: now },
        updatedAt: now,
      };
    });
    replaceMapValues(this.state.leases, records);
  }

  private reapExpiredLeases(now: string): void {
    const result = expireLeases({ leases: Array.from(this.state.leases.values()), now });
    replaceMapValues(this.state.leases, result.records);
  }

  private upsertDefaultNodeForEnvironment(input: {
    readonly environment: RemoteFleetEnvironmentRecord;
    readonly targetKind: RemoteFleetNodeRecord['targetKind'];
    readonly now: string;
  }): RemoteFleetNodeRecord {
    const existingNode = this.state.nodes.get(input.environment.nodeId ?? `${input.environment.id}:node`);
    if (existingNode?.environmentId && existingNode.environmentId !== input.environment.id) {
      throw new Error('Remote Fleet environment node ownership is invalid.');
    }
    const node: RemoteFleetNodeRecord = {
      id: existingNode?.id ?? input.environment.nodeId ?? `${input.environment.id}:node`,
      connectionId: input.environment.connectionId,
      environmentId: input.environment.id,
      ...(existingNode?.managedResourceId ? { managedResourceId: existingNode.managedResourceId } : {}),
      displayName: existingNode?.displayName ?? input.environment.displayName,
      ...(existingNode?.description ? { description: existingNode.description } : input.environment.description ? { description: input.environment.description } : {}),
      targetKind: existingNode?.targetKind ?? input.targetKind,
      ...(existingNode?.endpointUrl ? { endpointUrl: existingNode.endpointUrl } : {}),
      labels: normalizeLabels(existingNode?.labels ?? input.environment.labels),
      enabled: input.environment.enabled,
      publicConfig: existingNode?.publicConfig ?? {},
      secretRefs: existingNode?.secretRefs ?? {},
      health: existingNode?.health ?? { reason: 'unknown' },
      createdAt: existingNode?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.state.nodes.set(node.id, node);
    return node;
  }

  private upsertDefaultAgentForNode(node: RemoteFleetNodeRecord, now: string): RuntimeAgentRecord {
    const existingAgent = this.findOwnedAgentForNode(node);
    const agent = existingAgent ?? createDefaultAgent(node, now);
    const updatedAgent: RuntimeAgentRecord = {
      ...agent,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
      ...(node.environmentId ? { environmentId: node.environmentId } : {}),
      ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
      displayName: `${node.displayName} RuntimeAgent`,
      updatedAt: now,
    };
    this.state.agents.set(updatedAgent.id, updatedAgent);
    return updatedAgent;
  }

  private upsertDefaultRuntimeForNode(node: RemoteFleetNodeRecord, agent: RuntimeAgentRecord, now: string): RuntimeInstanceRecord {
    const existingRuntime = this.state.runtimes.get(`${node.id}:openclaw`);
    if (existingRuntime?.environmentId && existingRuntime.environmentId !== node.environmentId) {
      throw new Error('Remote Fleet runtime ownership is invalid.');
    }
    const runtime = existingRuntime ?? createDefaultRuntime(node, agent, now);
    const updatedRuntime: RuntimeInstanceRecord = {
      ...runtime,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
      ...(node.environmentId ? { environmentId: node.environmentId } : {}),
      ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
      agentId: agent.id,
      displayName: `${node.displayName} OpenClaw`,
      updatedAt: now,
    };
    this.state.runtimes.set(updatedRuntime.id, updatedRuntime);
    return updatedRuntime;
  }

  private findOwnedAgentForNode(node: RemoteFleetNodeRecord): RuntimeAgentRecord | null {
    for (const agent of this.state.agents.values()) {
      if (agent.nodeId === node.id && agent.environmentId === node.environmentId) {
        return agent;
      }
    }
    return null;
  }

  private findAgentByNodeId(nodeId: string): RuntimeAgentRecord | null {
    for (const agent of this.state.agents.values()) {
      if (agent.nodeId === nodeId) {
        return agent;
      }
    }
    return null;
  }
}

function createEmptyRuntimeState(): RemoteFleetRuntimeState {
  return {
    connections: new Map(),
    environments: new Map(),
    managedResources: new Map(),
    nodes: new Map(),
    agents: new Map(),
    runtimes: new Map(),
    endpoints: new Map(),
    capabilities: new Map(),
    commands: new Map(),
    commandProjectionOrder: [],
    credentialWriteOperations: new Map(),
    leases: new Map(),
    sessions: new Map(),
    auditEvents: new Map(),
    auditEventProjectionOrder: [],
  };
}

function replaceMapValues<T extends { readonly id: string }>(target: Map<string, T>, items: readonly T[]): void {
  target.clear();
  for (const item of items) {
    target.set(item.id, item);
  }
}

function credentialWriteResponse(receipt: RemoteFleetCredentialWriteReceipt): {
  readonly credentialName: string;
  readonly credentialRef: RemoteFleetSecretRef;
  readonly secretRefs: Record<string, RemoteFleetSecretRef>;
} {
  return {
    credentialName: receipt.credentialName,
    credentialRef: receipt.credentialRef,
    secretRefs: {
      [receipt.credentialName]: receipt.credentialRef,
    },
  };
}

function isMatchingCredentialWriteOperation(
  operation: RemoteFleetCredentialWriteOperationRecord,
  input: Pick<RemoteFleetCredentialWriteRequestInput, 'operationId' | 'credentialId' | 'credentialName'>,
  credentialRef: RemoteFleetSecretRef,
): boolean {
  return operation.credentialId === input.credentialId
    && operation.credentialName === input.credentialName
    && operation.credentialRef.ref === credentialRef.ref;
}

function findEnvironmentByNodeId(
  environments: ReadonlyMap<string, RemoteFleetEnvironmentRecord>,
  nodeId: string,
  excludedEnvironmentId: string,
): RemoteFleetEnvironmentRecord | undefined {
  return Array.from(environments.values()).find((environment) =>
    environment.id !== excludedEnvironmentId && environment.nodeId === nodeId,
  );
}

function buildRecentProjectionOrder<T extends { readonly id: string }>(items: readonly T[], readTimestamp: (item: T) => string): string[] {
  return [...items]
    .sort((left, right) => readTimestamp(left).localeCompare(readTimestamp(right)))
    .slice(-REMOTE_FLEET_HISTORY_PROJECTION_LIMIT)
    .map((item) => item.id);
}

function appendRecentProjectionId(order: string[], id: string): void {
  order.push(id);
  const overflowCount = order.length - REMOTE_FLEET_HISTORY_PROJECTION_LIMIT;
  if (overflowCount > 0) {
    order.splice(0, overflowCount);
  }
}

function summarizeRecentProjection<T extends { readonly id: string }, TSummary>(
  order: readonly string[],
  records: ReadonlyMap<string, T>,
  summarize: (record: T) => TSummary,
): readonly TSummary[] {
  const projection: TSummary[] = [];
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const record = records.get(order[index]!);
    if (record) {
      projection.push(summarize(record));
    }
  }
  return projection;
}

function createDefaultAgent(node: RemoteFleetNodeRecord, now: string): RuntimeAgentRecord {
  const enrollment: RuntimeAgentEnrollmentState = { reason: 'not-installed' };
  return {
    id: `${node.id}:agent`,
    ...(node.connectionId ? { connectionId: node.connectionId } : {}),
    ...(node.environmentId ? { environmentId: node.environmentId } : {}),
    ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
    nodeId: node.id,
    displayName: `${node.displayName} RuntimeAgent`,
    enrollment,
    capabilities: [],
    createdAt: now,
    updatedAt: now,
  };
}

function createDefaultRuntime(node: RemoteFleetNodeRecord, agent: RuntimeAgentRecord, now: string): RuntimeInstanceRecord {
  const lifecycle: RuntimeInstanceLifecycleState = { reason: 'stopped' };
  return {
    id: `${node.id}:openclaw`,
    ...(node.connectionId ? { connectionId: node.connectionId } : {}),
    ...(node.environmentId ? { environmentId: node.environmentId } : {}),
    ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
    nodeId: node.id,
    agentId: agent.id,
    displayName: `${node.displayName} OpenClaw`,
    runtimeKind: 'openclaw',
    lifecycle,
    createdAt: now,
    updatedAt: now,
  };
}

function createEndpointForRuntime(runtime: RuntimeInstanceRecord, now: string): RemoteRuntimeEndpointRecord {
  const endpointRef: RuntimeEndpointRef = {
    kind: 'native-runtime',
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: runtime.id,
  };
  const scope: RuntimeScope = {
    kind: 'runtime-instance',
    endpoint: endpointRef,
  };
  const health: RemoteRuntimeEndpointHealthState = { reason: 'ready', lastProbeAt: now };
  return {
    id: `${runtime.id}:endpoint`,
    ...(runtime.connectionId ? { connectionId: runtime.connectionId } : {}),
    ...(runtime.environmentId ? { environmentId: runtime.environmentId } : {}),
    ...(runtime.managedResourceId ? { managedResourceId: runtime.managedResourceId } : {}),
    nodeId: runtime.nodeId,
    runtimeId: runtime.id,
    endpointRef,
    scope,
    protocol: 'remote-fleet',
    labels: [],
    health,
    createdAt: now,
    updatedAt: now,
  };
}

const REMOTE_FLEET_CAPABILITY_OPERATIONS: readonly CapabilityOperationDescriptor[] = [
  { id: 'remoteFleet.runtime.status', title: 'Inspect Remote Fleet runtime status', targetKind: 'runtime-endpoint', targetRequired: true },
  { id: 'remoteFleet.runtime.start', title: 'Start Remote Fleet runtime', targetKind: 'runtime-endpoint', targetRequired: true },
  { id: 'remoteFleet.runtime.stop', title: 'Stop Remote Fleet runtime', targetKind: 'runtime-endpoint', targetRequired: true },
  { id: 'remoteFleet.capabilities.sync', title: 'Sync Remote Fleet endpoint capabilities', targetKind: 'runtime-endpoint', targetRequired: true },
] as const;

function createCapabilityDescriptors(endpoint: RemoteRuntimeEndpointRecord): CapabilityDescriptor[] {
  const scope = runtimeInstanceScope(endpoint.endpointRef);
  return [{
    id: 'remote-fleet.runtime-control',
    kind: 'runtime-control',
    scopeKind: scope.kind,
    scope,
    targetKinds: ['runtime-endpoint'],
    ...(endpoint.endpointRef.kind === 'native-runtime' ? {
      runtimeAdapterId: endpoint.endpointRef.runtimeAdapterId,
      runtimeInstanceId: endpoint.endpointRef.runtimeInstanceId,
    } : {}),
    supportLevel: 'projected',
    availability: endpoint.health.reason === 'ready' || endpoint.health.reason === 'busy' ? 'available' : 'unavailable',
    operations: [...REMOTE_FLEET_CAPABILITY_OPERATIONS],
    policyScope: 'remote-fleet.runtime-control',
    ownerModuleId: 'remote-fleet',
    routeOwnerId: 'remote-fleet',
  }];
}

function createCapabilitySnapshot(
  endpoint: RemoteRuntimeEndpointRecord,
  descriptors: readonly CapabilityDescriptor[],
  now: string,
  descriptorHash: string,
): RemoteCapabilitySnapshotRecord {
  const operationIds = Array.from(new Set(descriptors.flatMap((descriptor) => descriptor.operations.map((operation) => operation.id)))).sort();
  const freshness: CapabilitySnapshotFreshnessState = {
    reason: 'current',
    observedAt: now,
    descriptorHash,
  };
  return {
    id: `${endpoint.id}:capabilities`,
    ...(endpoint.connectionId ? { connectionId: endpoint.connectionId } : {}),
    ...(endpoint.environmentId ? { environmentId: endpoint.environmentId } : {}),
    ...(endpoint.managedResourceId ? { managedResourceId: endpoint.managedResourceId } : {}),
    nodeId: endpoint.nodeId,
    runtimeId: endpoint.runtimeId,
    endpointId: endpoint.id,
    displayName: 'Remote runtime control',
    operationIds,
    descriptors,
    freshness,
    observedAt: now,
  };
}

function buildManagedResourcesFromDeployResult(
  command: RemoteFleetCommandRecord,
  environment: RemoteFleetEnvironmentRecord,
  result: RemoteFleetCommandResultInput,
  observedAt: string,
): readonly RemoteFleetManagedResourceRecord[] {
  if (result.reason !== 'succeeded' || !result.managedResources || result.managedResources.length === 0) {
    return [];
  }
  return result.managedResources.map((resource): RemoteFleetManagedResourceRecord => {
    const resourceId = `${environment.id}:${resource.providerKind}:${resource.resourceKind}:${resource.remoteResourceId}`;
    return {
      id: resourceId,
      connectionId: environment.connectionId,
      environmentId: environment.id,
      ...(command.nodeId ? { nodeId: command.nodeId } : environment.nodeId ? { nodeId: environment.nodeId } : {}),
      providerKind: resource.providerKind,
      resourceKind: resource.resourceKind,
      remoteResourceId: resource.remoteResourceId,
      remoteRefs: resource.remoteRefs,
      displayName: resource.displayName,
      labels: normalizeLabels(resource.labels),
      ownership: resource.ownership,
      cleanupPolicy: resource.cleanupPolicy,
      lifecycle: { reason: 'ready', observedAt },
      createdAt: observedAt,
      updatedAt: observedAt,
      lastObservedAt: observedAt,
    };
  });
}

function shouldDispatchManagedResourceCleanup(managedResource: RemoteFleetManagedResourceRecord): boolean {
  return managedResource.ownership.reason === 'matcha-managed'
    && managedResource.cleanupPolicy.mode === 'delete-on-environment-delete';
}

function skippedManagedResourceCleanupMessage(managedResource: RemoteFleetManagedResourceRecord): string {
  if (managedResource.ownership.reason !== 'matcha-managed') {
    return `Remote Fleet managed resource cleanup skipped because ownership is ${managedResource.ownership.reason}.`;
  }
  return `Remote Fleet managed resource cleanup skipped by cleanup policy ${managedResource.cleanupPolicy.mode}.`;
}

function summarizeConnection(connection: RemoteFleetConnectionRecord): RemoteFleetConnectionSummary {
  const endpointUrl = findUnsafeRemoteFleetEndpointUrlKey(connection.endpointUrl) ? undefined : connection.endpointUrl;
  return {
    id: connection.id,
    displayName: connection.displayName,
    ...(connection.description ? { description: connection.description } : {}),
    connectionKind: connection.connectionKind,
    targetKind: connection.connectionKind,
    ...(endpointUrl ? { endpointUrl } : {}),
    status: connection.health.reason === 'online' ? 'online' : connection.health.reason,
    labels: connection.labels,
    enabled: connection.enabled,
    ...(connection.health.reason === 'online' || connection.health.reason === 'offline' ? { lastSeenAt: connection.health.lastSeenAt } : {}),
    ...('message' in connection.health && connection.health.message ? { reason: connection.health.message } : {}),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function summarizeEnvironment(environment: RemoteFleetEnvironmentRecord): RemoteFleetEnvironmentSummary {
  return {
    id: environment.id,
    connectionId: environment.connectionId,
    ...(environment.nodeId ? { nodeId: environment.nodeId } : {}),
    displayName: environment.displayName,
    ...(environment.description ? { description: environment.description } : {}),
    environmentKind: environment.environmentKind,
    targetKind: targetKindForEnvironmentKind(environment.environmentKind),
    status: environment.lifecycle.reason,
    labels: environment.labels,
    enabled: environment.enabled,
    managedResourceIds: environment.managedResourceIds,
    ...('message' in environment.lifecycle && environment.lifecycle.message ? { reason: environment.lifecycle.message } : {}),
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

function summarizeManagedResource(managedResource: RemoteFleetManagedResourceRecord): RemoteFleetManagedResourceSummary {
  return {
    id: managedResource.id,
    connectionId: managedResource.connectionId,
    environmentId: managedResource.environmentId,
    ...(managedResource.nodeId ? { nodeId: managedResource.nodeId } : {}),
    providerKind: managedResource.providerKind,
    resourceKind: managedResource.resourceKind,
    remoteResourceId: managedResource.remoteResourceId,
    displayName: managedResource.displayName,
    status: managedResource.lifecycle.reason,
    ownership: managedResource.ownership.reason,
    cleanupPolicy: managedResource.cleanupPolicy.mode,
    labels: managedResource.labels,
    ...('message' in managedResource.lifecycle && managedResource.lifecycle.message ? { reason: managedResource.lifecycle.message } : {}),
    createdAt: managedResource.createdAt,
    updatedAt: managedResource.updatedAt,
    ...(managedResource.lastObservedAt ? { lastObservedAt: managedResource.lastObservedAt } : {}),
  };
}

function summarizeNode(node: RemoteFleetNodeRecord): RemoteFleetNodeSummary {
  const endpointUrl = findUnsafeRemoteFleetEndpointUrlKey(node.endpointUrl) ? undefined : node.endpointUrl;
  return {
    id: node.id,
    ...(node.connectionId ? { connectionId: node.connectionId } : {}),
    ...(node.environmentId ? { environmentId: node.environmentId } : {}),
    ...(node.managedResourceId ? { managedResourceId: node.managedResourceId } : {}),
    displayName: node.displayName,
    ...(node.description ? { description: node.description } : {}),
    targetKind: node.targetKind,
    ...(endpointUrl ? { endpointUrl } : {}),
    status: node.health.reason === 'online' ? 'online' : node.health.reason,
    labels: node.labels,
    enabled: node.enabled,
    ...(node.health.reason === 'online' || node.health.reason === 'offline' ? { lastSeenAt: node.health.lastSeenAt } : {}),
    ...('message' in node.health && node.health.message ? { reason: node.health.message } : {}),
  };
}

function summarizeAgent(agent: RuntimeAgentRecord): RuntimeAgentSummary {
  return {
    id: agent.id,
    ...(agent.connectionId ? { connectionId: agent.connectionId } : {}),
    ...(agent.environmentId ? { environmentId: agent.environmentId } : {}),
    ...(agent.managedResourceId ? { managedResourceId: agent.managedResourceId } : {}),
    nodeId: agent.nodeId,
    displayName: agent.displayName,
    status: agent.enrollment.reason,
    capabilities: agent.capabilities,
  };
}

function summarizeRuntime(runtime: RuntimeInstanceRecord): RuntimeInstanceSummary {
  return {
    id: runtime.id,
    ...(runtime.connectionId ? { connectionId: runtime.connectionId } : {}),
    ...(runtime.environmentId ? { environmentId: runtime.environmentId } : {}),
    ...(runtime.managedResourceId ? { managedResourceId: runtime.managedResourceId } : {}),
    nodeId: runtime.nodeId,
    ...(runtime.agentId ? { agentId: runtime.agentId } : {}),
    displayName: runtime.displayName,
    status: runtime.lifecycle.reason === 'running' ? 'running' : runtime.lifecycle.reason,
    ...(runtime.endpointId ? { endpointId: runtime.endpointId } : {}),
    ...(runtime.lifecycle.reason === 'running' ? { startedAt: runtime.lifecycle.startedAt } : {}),
    ...('message' in runtime.lifecycle && runtime.lifecycle.message ? { reason: runtime.lifecycle.message } : {}),
  };
}

function summarizeEndpoint(endpoint: RemoteRuntimeEndpointRecord): RemoteRuntimeEndpointSummary {
  return {
    id: endpoint.id,
    ...(endpoint.connectionId ? { connectionId: endpoint.connectionId } : {}),
    ...(endpoint.environmentId ? { environmentId: endpoint.environmentId } : {}),
    ...(endpoint.managedResourceId ? { managedResourceId: endpoint.managedResourceId } : {}),
    nodeId: endpoint.nodeId,
    runtimeId: endpoint.runtimeId,
    ...(endpoint.url ? { url: endpoint.url } : {}),
    ...(endpoint.protocol ? { protocol: endpoint.protocol } : {}),
    status: endpoint.health.reason,
    ...(endpoint.health.reason === 'ready' || endpoint.health.reason === 'unhealthy' ? { lastProbeAt: endpoint.health.lastProbeAt } : {}),
  };
}

function summarizeCapability(capability: RemoteCapabilitySnapshotRecord): RemoteCapabilitySnapshotSummary {
  return {
    id: capability.id,
    ...(capability.connectionId ? { connectionId: capability.connectionId } : {}),
    ...(capability.environmentId ? { environmentId: capability.environmentId } : {}),
    ...(capability.managedResourceId ? { managedResourceId: capability.managedResourceId } : {}),
    ...(capability.nodeId ? { nodeId: capability.nodeId } : {}),
    ...(capability.runtimeId ? { runtimeId: capability.runtimeId } : {}),
    endpointId: capability.endpointId,
    displayName: capability.displayName,
    operationIds: capability.operationIds,
    status: capability.freshness.reason,
  };
}

function summarizeCommand(command: RemoteFleetCommandRecord): RemoteFleetCommandSummary {
  return {
    id: command.id,
    ...(command.connectionId ? { connectionId: command.connectionId } : {}),
    ...(command.environmentId ? { environmentId: command.environmentId } : {}),
    ...(command.managedResourceId ? { managedResourceId: command.managedResourceId } : {}),
    ...(command.nodeId ? { nodeId: command.nodeId } : {}),
    ...(command.runtimeId ? { runtimeId: command.runtimeId } : {}),
    ...(command.endpointId ? { endpointId: command.endpointId } : {}),
    command: command.command,
    status: command.state.reason === 'timed-out' ? 'failed' : command.state.reason,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.message ? { message: command.message } : {}),
  };
}

function summarizeLease(lease: RemoteFleetLeaseRecord): RemoteFleetLeaseSummary {
  return {
    id: lease.id,
    endpointId: lease.endpointId,
    ownerKind: lease.ownerKind,
    ownerId: lease.ownerId,
    status: lease.state.reason,
    ...(lease.state.reason === 'active' ? { expiresAt: lease.state.expiresAt } : {}),
  };
}

function summarizeTerminalSession(session: RemoteFleetTerminalSessionRecord): RemoteFleetTerminalSessionSummary {
  return {
    id: session.id,
    ...(session.connectionId ? { connectionId: session.connectionId } : {}),
    ...(session.environmentId ? { environmentId: session.environmentId } : {}),
    ...(session.managedResourceId ? { managedResourceId: session.managedResourceId } : {}),
    nodeId: session.nodeId,
    ...(session.runtimeId ? { runtimeId: session.runtimeId } : {}),
    ...(session.endpointId ? { endpointId: session.endpointId } : {}),
    targetKind: session.targetKind,
    status: session.state.reason,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...('message' in session.state && session.state.message ? { reason: session.state.message } : {}),
  };
}

function summarizeAuditEvent(event: RemoteFleetAuditEventRecord): RemoteFleetAuditEventSummary {
  return {
    ...summarizeRemoteFleetAuditEvent(event),
    ...(event.connectionId ? { connectionId: event.connectionId } : {}),
    ...(event.environmentId ? { environmentId: event.environmentId } : {}),
    ...(event.managedResourceId ? { managedResourceId: event.managedResourceId } : {}),
  };
}

function bootstrapResultToCommandResult(
  commandName: string,
  result: RemoteFleetBootstrapCommandResult,
  completedAt: string,
): RemoteFleetCommandResultInput {
  if (result.resultType === 'completed') {
    return {
      reason: 'succeeded',
      completedAt,
      message: safeBootstrapCommandMessage(commandName, true, result.providerKind),
      ...(result.managedResources ? { managedResources: result.managedResources } : {}),
    };
  }
  return {
    reason: 'failed',
    completedAt,
    message: safeBootstrapFailureMessage(commandName, result),
  };
}

function safeBootstrapFailureMessage(commandName: string, result: Extract<RemoteFleetBootstrapCommandResult, { readonly resultType: 'failed' }>): string {
  if (result.reason === 'endpoint-protocol-mismatch') {
    return 'Docker local port 2375 must use HTTP instead of HTTPS.';
  }

  const fallbackMessage = safeBootstrapCommandMessage(commandName, false, result.providerKind);
  const resultMessage = redactRemoteFleetMessage(result.message).trim();
  return resultMessage && resultMessage !== fallbackMessage
    ? `${fallbackMessage} ${resultMessage}`
    : fallbackMessage;
}

function safeBootstrapCommandMessage(
  commandName: string,
  didSucceed: boolean,
  providerKind?: RemoteFleetBootstrapCommandResult['providerKind'],
): string {
  switch (commandName) {
    case 'install-agent':
      if (providerKind === 'docker') {
        return didSucceed ? 'Docker environment bootstrap completed.' : 'Docker environment bootstrap failed.';
      }
      return didSucceed ? 'RuntimeAgent install completed.' : 'RuntimeAgent install failed.';
    case 'probe-node':
      return didSucceed ? 'Remote Fleet node probe completed.' : 'Remote Fleet node probe failed.';
    default:
      return didSucceed ? 'Remote Fleet bootstrap command completed.' : 'Remote Fleet bootstrap command failed.';
  }
}

function safeConnectionProbeFailureMessage(
  reason: Extract<RemoteFleetConnectionProbeResult, { readonly resultType: 'failed' }>['reason'],
): string {
  switch (reason) {
    case 'unsupported':
      return 'Remote Fleet connection probe is not supported for this connection type.';
    case 'invalid-config':
      return 'Remote Fleet connection probe configuration is invalid.';
    case 'endpoint-protocol-mismatch':
      return 'Docker local port 2375 must use HTTP instead of HTTPS.';
    case 'missing-secret':
      return 'Remote Fleet connection probe credential is missing.';
    case 'auth':
      return 'Remote Fleet connection probe authentication failed.';
    case 'network':
      return 'Remote Fleet connection probe could not reach the remote endpoint.';
    case 'timeout':
      return 'Remote Fleet connection probe timed out.';
    case 'remote-error':
      return 'Remote Fleet connection probe was rejected by the remote endpoint.';
    case 'unavailable':
      return 'Remote Fleet connection probe provider is unavailable.';
  }
}

function redactRuntimeAgentCommandResult(
  result: RuntimeAgentReportCommandResultRequest['result'],
): RemoteFleetCommandResultInput {
  switch (result.reason) {
    case 'failed':
      return { ...result, message: redactRemoteFleetMessage(result.message) };
    case 'cancelled':
      return {
        ...result,
        ...(result.message === undefined ? {} : { message: redactRemoteFleetMessage(result.message) }),
      };
    case 'succeeded':
    case 'timed-out':
      return result;
  }
}

function updateCommandWithResult(
  command: RemoteFleetCommandRecord,
  result: RemoteFleetCommandResultInput,
  completedAt: string,
): RemoteFleetCommandRecord {
  return {
    ...command,
    state: toCommandState(result, completedAt),
    updatedAt: completedAt,
    ...(result.message ? { message: result.message } : {}),
  };
}

function toCommandState(result: RemoteFleetCommandResultInput, completedAt: string): RemoteFleetCommandState {
  switch (result.reason) {
    case 'succeeded':
      return { reason: 'succeeded', completedAt };
    case 'failed':
      return { reason: 'failed', completedAt, message: result.message ?? 'Remote Fleet command failed.' };
    case 'cancelled':
      return { reason: 'cancelled', completedAt, ...(result.message ? { message: result.message } : {}) };
    case 'timed-out':
      return { reason: 'timed-out', completedAt, timeoutMs: result.timeoutMs ?? 0 };
  }
}

function isTerminalCommandState(state: RemoteFleetCommandState): boolean {
  return state.reason === 'succeeded'
    || state.reason === 'failed'
    || state.reason === 'cancelled'
    || state.reason === 'timed-out';
}

function readEnvironmentId(value: unknown, message: string): string {
  const record = readRecord(value);
  const environmentId = readOptionalString(readRecord(record.environment).id !== undefined ? readRecord(record.environment) : record, 'environmentId')
    ?? readOptionalString(readRecord(record.environment), 'id');
  if (!environmentId) {
    throw new Error(message);
  }
  return environmentId;
}

function readTerminalEndpointHealthError(endpoint: RemoteRuntimeEndpointRecord): string | null {
  switch (endpoint.health.reason) {
    case 'unhealthy':
      return `Remote Fleet endpoint is unhealthy: ${endpoint.id}`;
    case 'draining':
      return `Remote Fleet endpoint is draining: ${endpoint.id}`;
    case 'retired':
      return `Remote Fleet endpoint is retired: ${endpoint.id}`;
    default:
      return null;
  }
}

function readTerminalNoEndpointError(targetKind: RemoteFleetNodeRecord['targetKind']): string | null {
  return targetKind === 'custom'
    ? 'Remote Fleet custom terminal sessions require an endpoint so the provider can validate capability.'
    : null;
}

function readTerminalSize(value: unknown): RemoteFleetTerminalSize | undefined {
  const record = readRecord(value);
  return typeof record.rows === 'number' && typeof record.cols === 'number'
    ? { rows: record.rows, cols: record.cols }
    : undefined;
}

function isTerminalIssueTicketResult(value: unknown): value is RemoteFleetTerminalIssueTicketHostRpcResponse {
  const record = readRecord(value);
  if (record.type !== REMOTE_FLEET_TERMINAL_ISSUE_TICKET_HOST_RPC_RESULT_TYPE || typeof record.requestId !== 'string') {
    return false;
  }
  if (record.resultType === 'unavailable') {
    return record.message === undefined || typeof record.message === 'string';
  }
  if (record.resultType === 'failed' || record.resultType === 'invalidRequest') {
    return typeof record.message === 'string' && record.message.trim().length > 0;
  }
  if (record.resultType !== 'issued') {
    return false;
  }
  const terminalConnection = readRecord(record.terminalConnection);
  return typeof terminalConnection.sessionId === 'string'
    && terminalConnection.sessionId.trim().length > 0
    && typeof terminalConnection.ticket === 'string'
    && terminalConnection.ticket.trim().length > 0
    && typeof terminalConnection.websocketPath === 'string'
    && terminalConnection.websocketPath.trim().length > 0
    && typeof terminalConnection.expiresAt === 'string'
    && !Number.isNaN(Date.parse(terminalConnection.expiresAt));
}

function isTerminalCloseSessionResult(value: unknown): value is RemoteFleetTerminalCloseSessionHostRpcResponse {
  const record = readRecord(value);
  if (record.type !== REMOTE_FLEET_TERMINAL_CLOSE_SESSION_HOST_RPC_RESULT_TYPE || typeof record.requestId !== 'string') {
    return false;
  }
  if (record.resultType === 'closed') {
    return true;
  }
  if (record.resultType === 'unavailable') {
    return record.message === undefined || typeof record.message === 'string';
  }
  return (record.resultType === 'failed' || record.resultType === 'invalidRequest')
    && typeof record.message === 'string'
    && record.message.trim().length > 0;
}

function isRemoteFleetRuntimeAgentDispatchAccepted(value: unknown): boolean {
  const record = readRecord(value);
  return record.resultType === 'accepted' && record.accepted === true;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readCredentialWriteInput(value: unknown, nowIso: string): RemoteFleetCredentialWriteInputReadResult {
  const record = readRecord(value);
  const inputRecord = readRecord(record.credential ?? value);
  const credentialName = readOptionalString(inputRecord, 'credentialName');
  if (!credentialName || !isRemoteFleetWritableCredentialName(credentialName)) {
    return { resultType: 'invalid', message: 'Remote Fleet credential name is not supported.' };
  }
  const credentialId = readOptionalString(inputRecord, 'credentialId');
  if (!credentialId || !isValidRemoteFleetCredentialPathSegment(credentialId)) {
    return { resultType: 'invalid', message: 'Remote Fleet credential id is not valid.' };
  }
  const plaintextValue = readPlaintextValue(inputRecord, 'plaintextValue');
  if (plaintextValue === undefined) {
    return { resultType: 'invalid', message: 'Remote Fleet credential value is required.' };
  }
  if (plaintextValue.length > REMOTE_FLEET_CREDENTIAL_TEXT_LIMIT) {
    return { resultType: 'invalid', message: 'Remote Fleet credential value is too large.' };
  }

  const operationId = readOptionalString(inputRecord, 'operationId');
  if (!operationId || !isValidRemoteFleetCredentialPathSegment(operationId)) {
    return { resultType: 'invalid', message: 'Remote Fleet credential write operation id is not valid.' };
  }

  return {
    resultType: 'valid',
    value: {
      operationId,
      credentialId,
      credentialName,
      plaintextValue,
      nowIso,
    },
  };
}

function isCredentialWriteStatusResult(value: unknown): value is RemoteFleetSecretWriteStatusHostRpcResponse {
  const record = readRecord(value);
  if (record.type !== REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE || typeof record.requestId !== 'string') {
    return false;
  }
  if (record.resultType === 'notFound' || record.resultType === 'operationConflict' || record.resultType === 'unavailable') {
    return true;
  }
  if (record.resultType === 'invalidRequest') {
    return typeof record.message === 'string';
  }
  if (record.resultType !== 'completed' || typeof record.credentialName !== 'string' || !isRemoteFleetWritableCredentialName(record.credentialName)) {
    return false;
  }
  const credentialRef = readRecord(record.credentialRef) as Partial<RemoteFleetSecretRef>;
  return credentialRef.kind === 'secret-ref'
    && typeof credentialRef.ref === 'string'
    && credentialRef.ref.trim().length > 0
    && typeof record.writtenAt === 'string'
    && !Number.isNaN(Date.parse(record.writtenAt));
}

function isCredentialWriteResult(value: unknown): value is RemoteFleetSecretWriteHostRpcResponse {
  const record = readRecord(value);
  if (record.type !== REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE || typeof record.requestId !== 'string') {
    return false;
  }
  if (record.resultType === 'unavailable') {
    return true;
  }
  if (record.resultType === 'invalidRequest') {
    return typeof record.message === 'string';
  }
  if (record.resultType !== 'written' || typeof record.credentialName !== 'string' || !isRemoteFleetWritableCredentialName(record.credentialName)) {
    return false;
  }
  const credentialRef = readRecord(record.credentialRef) as Partial<RemoteFleetSecretRef>;
  return credentialRef.kind === 'secret-ref'
    && typeof credentialRef.ref === 'string'
    && credentialRef.ref.trim().length > 0
    && typeof record.writtenAt === 'string'
    && !Number.isNaN(Date.parse(record.writtenAt));
}

function readPlaintextValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim().length > 0 ? value : undefined;
}

function readConnectionRegistrationInput(value: unknown): RemoteFleetConnectionRegistrationInput {
  const record = readRecord(value);
  return {
    id: readOptionalString(record, 'id'),
    displayName: readOptionalString(record, 'displayName'),
    description: readOptionalString(record, 'description'),
    connectionKind: readTargetKind(record.connectionKind) ?? readTargetKind(record.targetKind),
    targetKind: readTargetKind(record.targetKind),
    endpointUrl: readOptionalString(record, 'endpointUrl'),
    labels: record.labels === undefined
      ? undefined
      : Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === 'string')
        : [],
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
    publicConfig: record.publicConfig === undefined ? undefined : readRecord(record.publicConfig),
    secretRefs: record.secretRefs === undefined ? undefined : readSecretRefs(record.secretRefs),
  };
}

function readEnvironmentRegistrationInput(value: unknown): RemoteFleetEnvironmentRegistrationInput {
  const record = readRecord(value);
  return {
    id: readOptionalString(record, 'id'),
    connectionId: readRequiredString(record, 'connectionId'),
    nodeId: readOptionalString(record, 'nodeId'),
    displayName: readOptionalString(record, 'displayName'),
    description: readOptionalString(record, 'description'),
    environmentKind: readEnvironmentKind(record.environmentKind),
    targetKind: readTargetKind(record.targetKind),
    labels: record.labels === undefined
      ? undefined
      : Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === 'string')
        : [],
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
    publicConfig: record.publicConfig === undefined
      ? undefined
      : readRecord(record.publicConfig),
    secretRefs: record.secretRefs === undefined
      ? undefined
      : readSecretRefs(record.secretRefs),
  };
}

function readNodeRegistrationInput(value: unknown): RemoteFleetNodeRegistrationInput {
  const record = readRecord(value);
  return {
    id: readOptionalString(record, 'id'),
    connectionId: readOptionalString(record, 'connectionId'),
    environmentId: readOptionalString(record, 'environmentId'),
    managedResourceId: readOptionalString(record, 'managedResourceId'),
    displayName: readOptionalString(record, 'displayName'),
    description: readOptionalString(record, 'description'),
    targetKind: readTargetKind(record.targetKind),
    endpointUrl: readOptionalString(record, 'endpointUrl'),
    labels: record.labels === undefined
      ? undefined
      : Array.isArray(record.labels)
        ? record.labels.filter((label): label is string => typeof label === 'string')
        : [],
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
    publicConfig: record.publicConfig === undefined
      ? undefined
      : readRecord(record.publicConfig),
    secretRefs: record.secretRefs === undefined
      ? undefined
      : readSecretRefs(record.secretRefs),
  };
}

function readTargetKind(value: unknown): RemoteFleetNodeRegistrationInput['targetKind'] {
  if (value === 'ssh-host' || value === 'container' || value === 'vm' || value === 'k8s-pod' || value === 'custom') {
    return value;
  }
  return undefined;
}

function readEnvironmentKind(value: unknown): RemoteFleetEnvironmentRegistrationInput['environmentKind'] {
  if (value === 'ssh-workdir' || value === 'docker-container' || value === 'k8s-workload' || value === 'vm-workdir' || value === 'custom') {
    return value;
  }
  return undefined;
}

function environmentKindForTargetKind(targetKind: RemoteFleetNodeRecord['targetKind']): RemoteFleetEnvironmentRecord['environmentKind'] {
  switch (targetKind) {
    case 'ssh-host':
      return 'ssh-workdir';
    case 'container':
      return 'docker-container';
    case 'k8s-pod':
      return 'k8s-workload';
    case 'vm':
      return 'vm-workdir';
    case 'custom':
      return 'custom';
  }
}

function targetKindForEnvironmentKind(environmentKind: RemoteFleetEnvironmentRecord['environmentKind']): RemoteFleetNodeRecord['targetKind'] {
  switch (environmentKind) {
    case 'ssh-workdir':
      return 'ssh-host';
    case 'docker-container':
      return 'container';
    case 'k8s-workload':
      return 'k8s-pod';
    case 'vm-workdir':
      return 'vm';
    case 'custom':
      return 'custom';
  }
}

function isRemoteFleetDockerConnectionProtocolMismatch(
  input: RemoteFleetConnectionRegistrationInput,
  connectionKind: RemoteFleetConnectionRecord['connectionKind'],
): boolean {
  if (connectionKind !== 'container') return false;

  const dockerConfig = readRecord(input.publicConfig?.docker);
  return isRemoteFleetDockerLoopbackHttps2375Endpoint(input.endpointUrl)
    || isRemoteFleetDockerLoopbackHttps2375Endpoint(readOptionalString(dockerConfig, 'endpointUrl'));
}

function mergeRemoteFleetConnectionPublicConfig(
  existingPublicConfig: Readonly<Record<string, unknown>> | undefined,
  inputPublicConfig: Readonly<Record<string, unknown>> | undefined,
  connectionKind: RemoteFleetConnectionRecord['connectionKind'],
): Record<string, unknown> {
  const providerConfigKey = connectionKind === 'container'
    ? 'docker'
    : connectionKind === 'ssh-host'
      ? 'ssh'
      : connectionKind === 'vm'
        ? 'vm'
        : undefined;
  if (!providerConfigKey || !inputPublicConfig?.[providerConfigKey]) {
    return inputPublicConfig ?? existingPublicConfig ?? {};
  }

  return {
    ...(existingPublicConfig ?? {}),
    ...inputPublicConfig,
    [providerConfigKey]: {
      ...readRecord(existingPublicConfig?.[providerConfigKey]),
      ...readRecord(inputPublicConfig[providerConfigKey]),
    },
  };
}

function readSecretRefs(value: unknown): RemoteFleetNodeRegistrationInput['secretRefs'] {
  const record = readRecord(value);
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, { readonly kind: 'secret-ref'; readonly ref: string }] => {
    const secret = readRecord(entry[1]);
    return secret.kind === 'secret-ref' && typeof secret.ref === 'string' && secret.ref.length > 0;
  }));
}

function normalizeLabels(labels: readonly string[] | undefined): readonly string[] {
  return Array.from(new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))).sort();
}

function addMillisecondsToIso(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function isExpiredTimestamp(timestamp: string | undefined, now: string): boolean {
  return timestamp !== undefined && Date.parse(timestamp) <= Date.parse(now);
}

function markCapabilitySnapshotStale(
  snapshot: RemoteCapabilitySnapshotRecord,
  observedAt: string,
  message: string,
): RemoteCapabilitySnapshotRecord {
  return {
    ...snapshot,
    freshness: { reason: 'stale', observedAt, message },
  };
}

function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function compareByUpdatedAtDescThenId(
  left: { readonly id: string; readonly updatedAt: string },
  right: { readonly id: string; readonly updatedAt: string },
): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

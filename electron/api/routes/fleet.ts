import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isRemoteFleetCredentialWriteError,
  isRemoteFleetCredentialWriteInput,
  type RemoteFleetCredentialWriteAdapter,
  type RemoteFleetCredentialWriteInput,
  type RemoteFleetCredentialWriteReceipt,
} from '../../main/ipc/fleet-private';
import {
  isFleetMutationRequest,
  type FleetTransport,
} from '../../main/runtime-host-delivery/transport/fleet';
import {
  buildFleetRegistrationPlan,
  completeFleetRegistrationReceipt,
  projectFleetRegistration,
  toFleetRegistrationLegacyResponse,
  type FleetCanonicalAgent,
  type FleetCanonicalConnection,
  type FleetCanonicalEnvironment,
  type FleetCanonicalNode,
  type FleetCanonicalReadFacts,
  type FleetCanonicalRuntime,
  type FleetRegistrationRoute,
  type FleetRegistrationStepReceipt,
} from '../../main/runtime-host-delivery/transport/fleet-registration';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Fleet request is invalid',
} as const;

const UNAVAILABLE = {
  success: false,
  error: 'Fleet data is unavailable',
} as const;

type FleetReadRequest = Readonly<{
  operation: string;
  input: Readonly<Record<string, unknown>>;
}>;

type FleetMutationRequest = FleetReadRequest;

type FleetRouteRequest = Readonly<{
  kind: 'read' | 'mutate' | 'credential';
  request?: FleetReadRequest;
}>;

const READ_ROUTES: Readonly<Record<string, FleetReadRequest>> = {
  '/api/remote-fleet/snapshot': { operation: 'fleet.snapshot.get', input: { kind: 'snapshot' } },
  '/api/remote-fleet/list-audit-events': { operation: 'fleet.audit.list', input: { kind: 'audit' } },
  '/api/remote-fleet/list-commands': { operation: 'fleet.commands.list', input: { kind: 'commands' } },
  '/api/remote-fleet/metrics': { operation: 'fleet.metrics.get', input: { kind: 'metrics' } },
  '/api/remote-fleet/terminal/sessions': { operation: 'fleet.terminals.list', input: { kind: 'terminalList' } },
};

type MutationBuildResult =
  | Readonly<{ kind: 'request'; request: FleetMutationRequest }>
  | Readonly<{ kind: 'invalid' }>
  | Readonly<{ kind: 'unavailable' }>;

export async function handleFleetRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: FleetTransport,
  credentialWriteAdapter?: RemoteFleetCredentialWriteAdapter,
): Promise<boolean> {
  const route = classifyRoute(url.pathname, req.method);
  if (!route) return false;

  if (route.kind === 'read') {
    if (!route.request) {
      sendJson(res, 503, UNAVAILABLE);
      return true;
    }
    try {
      const response = await transport.read(route.request);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }

  if (route.kind === 'credential') {
    return await handleCredentialWrite(body, res, credentialWriteAdapter);
  }

  if (url.pathname === '/api/remote-fleet/register-connection' || url.pathname === '/api/remote-fleet/register-environment') {
    await handleRegistrationRoute(url.pathname, body, res, transport);
    return true;
  }
  const mutation = buildMutationRequest(url.pathname, body);
  if (mutation.kind === 'invalid') {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (mutation.kind === 'unavailable') {
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }
  if (!isFleetMutationRequest(mutation.request)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.mutate(mutation.request);
    sendJson(
      res,
      response.status,
      response.status === 200 ? projectFleetMutationResponse(url.pathname, mutation.request, response.body) : response.body,
    );
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function projectFleetMutationResponse(pathname: string, request: FleetMutationRequest, body: unknown): unknown {
  if (!isRecord(body)) return body;
  const command = fleetCommandForPath(pathname, request, body);
  if (!command) return body;
  return {
    ...body,
    command,
  };
}

function fleetCommandForPath(pathname: string, request: FleetMutationRequest, body: Record<string, unknown>): Record<string, unknown> | null {
  const payload = readPayload(request);
  if (!payload) return null;
  switch (pathname) {
    case '/api/remote-fleet/probe':
      return projectDispatchCommand(body, payload, 'probeNode');
    case '/api/remote-fleet/install-agent':
      return projectDispatchCommand(body, payload, 'installAgent');
    case '/api/remote-fleet/probe-connection':
      return projectOperationCommand(body, payload, 'probeConnection', 'connectionId', {
        probeCompleted: 'succeeded',
        probeRejected: 'failed',
        probeUnknown: 'unknown',
      });
    case '/api/remote-fleet/start-runtime':
      return projectOperationCommand(body, payload, 'startRuntime', 'runtimeId', {
        runtimeLifecycleUpdated: 'queued',
      });
    case '/api/remote-fleet/stop-runtime':
      return projectOperationCommand(body, payload, 'stopRuntime', 'runtimeId', {
        runtimeLifecycleUpdated: 'queued',
      });
    case '/api/remote-fleet/sync-capabilities':
      return projectOperationCommand(body, payload, 'syncCapabilities', 'endpointId', {
        capabilitySyncStarted: 'queued',
      });
    case '/api/remote-fleet/deploy-environment':
      return projectOperationCommand(body, payload, 'deployEnvironment', 'environmentId', {
        deploymentCompleted: 'succeeded',
        deploymentFailed: 'failed',
        deploymentUnknown: 'unknown',
      });
    default:
      return null;
  }
}

function projectDispatchCommand(
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
  command: string,
): Record<string, unknown> | null {
  if (!isIdentifier(body.dispatchId)) return null;
  const status = dispatchCommandStatus(body.outcome);
  if (!status) return null;
  const target: Record<string, unknown> = isRecord(body.target) ? body.target : {};
  return compactCommand({
    id: isIdentifier(payload.commandId) ? payload.commandId : body.dispatchId,
    nodeId: readIdentifier(target.nodeId ?? payload.nodeId),
    runtimeId: readIdentifier(target.runtimeId),
    endpointId: readIdentifier(target.endpointId),
    command,
    status,
  });
}

function projectOperationCommand(
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
  command: string,
  identity: 'connectionId' | 'environmentId' | 'runtimeId' | 'endpointId',
  outcomes: Readonly<Record<string, string>>,
): Record<string, unknown> | null {
  if (!isIdentifier(payload.commandId) || typeof body.outcome !== 'string') return null;
  const status = outcomes[body.outcome];
  if (!status) return null;
  return compactCommand({
    id: payload.commandId,
    [identity]: readIdentifier(payload.id),
    command,
    status,
    message: readText(body.message),
  });
}

function dispatchCommandStatus(outcome: unknown): string | null {
  switch (outcome) {
    case 'accepted': return 'queued';
    case 'completed': return 'succeeded';
    case 'rejected': return 'failed';
    case 'outcomeUnknown': return 'unknown';
    default: return null;
  }
}

function readPayload(request: FleetMutationRequest): Record<string, unknown> | null {
  const input = request.input;
  return isRecord(input) && isRecord(input.payload) ? input.payload : null;
}

function compactCommand(command: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined));
}

function readIdentifier(value: unknown): string | undefined {
  return isIdentifier(value) ? value : undefined;
}

async function handleRegistrationRoute(
  pathname: string,
  body: unknown,
  res: ServerResponse,
  transport: FleetTransport,
): Promise<void> {
  const route: FleetRegistrationRoute = pathname === '/api/remote-fleet/register-connection'
    ? 'register-connection'
    : 'register-environment';
  const plan = buildFleetRegistrationPlan(route, body);
  if (plan.status === 'rejected') {
    sendJson(res, 400, { success: false, error: plan.rejection?.message ?? INVALID.error });
    return;
  }

  const step = plan.sequence[0];
  if (!step) {
    sendJson(res, 503, UNAVAILABLE);
    return;
  }

  try {
    const mutation = await transport.mutate(step.request);
    const outcome = mutation.status === 200 ? readRegistrationMutationOutcome(mutation.body) : null;
    if (!outcome) {
      sendJson(res, 503, UNAVAILABLE);
      return;
    }

    const facts = await readRegistrationFacts(route, transport);
    if (!facts) {
      sendJson(res, 503, UNAVAILABLE);
      return;
    }
    const projection = projectFleetRegistration(plan, facts);
    if (!isRegistrationProjection(projection)) {
      sendJson(res, 503, { success: false, error: projection.message });
      return;
    }

    const receipt = completeFleetRegistrationReceipt(plan, [{
      sequence: step.sequence,
      operation: step.request.operation,
      outcome,
    }], projection);
    if (receipt.status === 'rejected') {
      sendJson(res, 503, { success: false, error: receipt.rejection?.message ?? UNAVAILABLE.error });
      return;
    }
    sendJson(res, 200, toFleetRegistrationLegacyResponse(receipt, projection));
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
}

async function readRegistrationFacts(
  route: FleetRegistrationRoute,
  transport: FleetTransport,
): Promise<FleetCanonicalReadFacts | null> {
  if (route === 'register-connection') {
    const response = await transport.read({ operation: 'fleet.connections.list', input: { kind: 'connections' } });
    if (response.status !== 200) return null;
    const connections = readCanonicalConnections(response.body);
    return connections
      ? { connections, environments: [], nodes: [], agents: [], runtimes: [] }
      : null;
  }

  const [environmentsResponse, topologyResponse] = await Promise.all([
    transport.read({ operation: 'fleet.environments.list', input: { kind: 'environments' } }),
    transport.read({ operation: 'fleet.topology.get', input: { kind: 'topology' } }),
  ]);
  if (environmentsResponse.status !== 200 || topologyResponse.status !== 200) return null;

  const environments = readCanonicalEnvironments(environmentsResponse.body);
  const topology = readCanonicalTopology(topologyResponse.body);
  return environments && topology
    ? { connections: [], environments, ...topology }
    : null;
}

function readRegistrationMutationOutcome(
  value: unknown,
): FleetRegistrationStepReceipt['outcome'] | null {
  if (!isRecord(value)) return null;
  if (value.outcome === 'connectionUpdated' || value.outcome === 'environmentRegistered') {
    return value.outcome;
  }
  return null;
}

function isRegistrationProjection(
  value: ReturnType<typeof projectFleetRegistration>,
): value is Extract<ReturnType<typeof projectFleetRegistration>, { source: 'canonical-fleet-read' }> {
  return isRecord(value) && value.source === 'canonical-fleet-read';
}

function readCanonicalConnections(value: unknown): FleetCanonicalConnection[] | null {
  if (!isRecord(value) || !Array.isArray(value.connections)) return null;
  const connections = value.connections.map(toCanonicalConnection);
  return connections.every((item): item is FleetCanonicalConnection => item !== null) ? connections : null;
}

function readCanonicalEnvironments(value: unknown): FleetCanonicalEnvironment[] | null {
  if (!isRecord(value) || !Array.isArray(value.environments)) return null;
  const environments = value.environments.map(toCanonicalEnvironment);
  return environments.every((item): item is FleetCanonicalEnvironment => item !== null) ? environments : null;
}

function readCanonicalTopology(value: unknown): Pick<FleetCanonicalReadFacts, 'nodes' | 'agents' | 'runtimes'> | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.agents) || !Array.isArray(value.runtimes)) return null;
  const nodes = value.nodes.map(toCanonicalNode);
  const agents = value.agents.map(toCanonicalAgent);
  const runtimes = value.runtimes.map(toCanonicalRuntime);
  return nodes.every((item): item is FleetCanonicalNode => item !== null)
    && agents.every((item): item is FleetCanonicalAgent => item !== null)
    && runtimes.every((item): item is FleetCanonicalRuntime => item !== null)
    ? { nodes, agents, runtimes }
    : null;
}

function toCanonicalConnection(value: unknown): FleetCanonicalConnection | null {
  if (!isRecord(value) || !isIdentifier(value.id) || !isFleetConnectionKind(value.kind)
    || typeof value.displayName !== 'string' || (value.endpoint !== null && typeof value.endpoint !== 'string')
    || !isStringArray(value.labels) || typeof value.enabled !== 'boolean') return null;
  return {
    id: value.id,
    kind: value.kind,
    displayName: value.displayName,
    endpoint: value.endpoint,
    labels: value.labels,
    enabled: value.enabled,
  };
}

function toCanonicalEnvironment(value: unknown): FleetCanonicalEnvironment | null {
  if (!isRecord(value) || !isIdentifier(value.id) || !isIdentifier(value.connectionId)
    || !isFleetEnvironmentKind(value.kind) || typeof value.displayName !== 'string'
    || !isStringArray(value.labels) || typeof value.enabled !== 'boolean') return null;
  return {
    id: value.id,
    connectionId: value.connectionId,
    kind: value.kind,
    displayName: value.displayName,
    labels: value.labels,
    enabled: value.enabled,
  };
}

function toCanonicalNode(value: unknown): FleetCanonicalNode | null {
  if (!isRecord(value) || !isIdentifier(value.id) || !isNullableIdentifier(value.connectionId)
    || !isNullableIdentifier(value.environmentId) || !isNullableIdentifier(value.managedResourceId)
    || !isFleetNodeHealth(value.health)) return null;
  return {
    id: value.id,
    connectionId: value.connectionId,
    environmentId: value.environmentId,
    managedResourceId: value.managedResourceId,
    health: value.health,
  };
}

function toCanonicalAgent(value: unknown): FleetCanonicalAgent | null {
  if (!isRecord(value) || !isIdentifier(value.id) || !isIdentifier(value.nodeId)
    || !isNullableIdentifier(value.connectionId) || !isNullableIdentifier(value.environmentId)
    || !isNullableIdentifier(value.managedResourceId)) return null;
  return {
    id: value.id,
    nodeId: value.nodeId,
    connectionId: value.connectionId,
    environmentId: value.environmentId,
    managedResourceId: value.managedResourceId,
  };
}

function toCanonicalRuntime(value: unknown): FleetCanonicalRuntime | null {
  if (!isRecord(value) || !isIdentifier(value.id) || !isIdentifier(value.nodeId)
    || !isIdentifier(value.agentId) || !isNullableIdentifier(value.connectionId)
    || !isNullableIdentifier(value.environmentId) || !isNullableIdentifier(value.managedResourceId)
    || !isFleetRuntimeKind(value.kind) || !isFleetRuntimeState(value.state)) return null;
  return {
    id: value.id,
    nodeId: value.nodeId,
    agentId: value.agentId,
    connectionId: value.connectionId,
    environmentId: value.environmentId,
    managedResourceId: value.managedResourceId,
    kind: value.kind,
    state: value.state,
  };
}

function isFleetConnectionKind(value: unknown): value is FleetCanonicalConnection['kind'] {
  return value === 'sshHost' || value === 'container' || value === 'vm' || value === 'kubernetesPod' || value === 'custom';
}

function isFleetEnvironmentKind(value: unknown): value is FleetCanonicalEnvironment['kind'] {
  return value === 'sshWorkdir' || value === 'dockerContainer' || value === 'kubernetesWorkload' || value === 'vmWorkdir' || value === 'custom';
}

function isFleetNodeHealth(value: unknown): value is FleetCanonicalNode['health'] {
  return value === 'unknown' || value === 'online' || value === 'offline' || value === 'disabled' || value === 'error';
}

function isFleetRuntimeKind(value: unknown): value is FleetCanonicalRuntime['kind'] {
  return value === 'openClaw' || value === 'matchaAgent' || value === 'plugin';
}

function isFleetRuntimeState(value: unknown): value is FleetCanonicalRuntime['state'] {
  return value === 'discovered' || value === 'running' || value === 'stopped' || value === 'degraded' || value === 'retired';
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

async function handleCredentialWrite(
  body: unknown,
  res: ServerResponse,
  credentialWriteAdapter: RemoteFleetCredentialWriteAdapter | undefined,
): Promise<boolean> {
  if (!isRemoteFleetCredentialWriteInput(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!credentialWriteAdapter) {
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }
  try {
    const receipt = await credentialWriteAdapter(body);
    if (!isCredentialWriteReceipt(receipt, body)) {
      sendJson(res, 503, UNAVAILABLE);
      return true;
    }
    sendJson(res, 200, receipt);
  } catch (error) {
    if (isRemoteFleetCredentialWriteError(error)) {
      sendJson(res, error.status, { success: false, error: error.message });
    } else {
      sendJson(res, 503, UNAVAILABLE);
    }
  }
  return true;
}

function isCredentialWriteReceipt(
  value: unknown,
  input: RemoteFleetCredentialWriteInput,
): value is RemoteFleetCredentialWriteReceipt {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || value.operationId !== input.operationId
    || value.credentialName !== input.credentialName
    || !isCredentialName(value.credentialName)
    || !isTimestamp(value.writtenAt)
    || !isRecord(value.credentialRef)
    || Object.keys(value.credentialRef).length !== 2
    || value.credentialRef.kind !== 'secret-ref'
    || value.credentialRef.ref !== `remote-fleet://credentials/${input.credentialId}/${input.credentialName}`) {
    return false;
  }
  return true;
}

function isCredentialName(value: unknown): boolean {
  return value === 'sshPassword'
    || value === 'sshPrivateKey'
    || value === 'dockerBearerToken'
    || value === 'kubeBearerToken';
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function classifyRoute(pathname: string, method: string | undefined): FleetRouteRequest | null {
  if (method === 'GET') {
    const request = READ_ROUTES[pathname];
    return request ? { kind: 'read', request } : null;
  }
  if (method === 'POST' && pathname === '/api/remote-fleet/write-credential') {
    return { kind: 'credential' };
  }
  if (method === 'POST' && isFleetMutationPath(pathname)) {
    return { kind: 'mutate' };
  }
  return null;
}

function isFleetMutationPath(pathname: string): boolean {
  return pathname === '/api/remote-fleet/delete-connection'
    || pathname === '/api/remote-fleet/register-connection'
    || pathname === '/api/remote-fleet/register-environment'
    || pathname === '/api/remote-fleet/remove-node'
    || pathname === '/api/remote-fleet/revoke-agent'
    || pathname === '/api/remote-fleet/drain-endpoint'
    || pathname === '/api/remote-fleet/retire-endpoint'
    || pathname === '/api/remote-fleet/probe'
    || pathname === '/api/remote-fleet/probe-connection'
    || pathname === '/api/remote-fleet/start-runtime'
    || pathname === '/api/remote-fleet/stop-runtime'
    || pathname === '/api/remote-fleet/sync-capabilities'
    || pathname === '/api/remote-fleet/install-agent'
    || pathname === '/api/remote-fleet/deploy-environment'
    || pathname === '/api/remote-fleet/delete-environment'
    || pathname === '/api/remote-fleet/terminal/open'
    || pathname === '/api/remote-fleet/terminal/reconnect'
    || pathname === '/api/remote-fleet/terminal/close';
}

function buildMutationRequest(pathname: string, body: unknown): MutationBuildResult {
  if (pathname === '/api/remote-fleet/probe' || pathname === '/api/remote-fleet/install-agent') {
    const nodeId = readIdentifierField(body, 'nodeId');
    if (!nodeId) return { kind: 'invalid' };
    const action = pathname === '/api/remote-fleet/probe' ? 'probe' : 'install-agent';
    const commandId = fleetCommandId(action, nodeId);
    return {
      kind: 'request',
      request: {
        operation: 'fleet.commands.submit.node',
        input: {
          kind: 'nodeCommandSubmit',
          payload: {
            nodeId,
            commandId,
            idempotencyKey: `idempotency:${commandId}`,
            dispatchId: `dispatch:${commandId}`,
            kind: pathname === '/api/remote-fleet/probe' ? 'probeNode' : 'installAgent',
          },
        },
      },
    };
  }
  if (pathname === '/api/remote-fleet/probe-connection') {
    const id = readIdentifierField(body, 'connectionId');
    return id
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.connections.probe.begin',
          input: { kind: 'connectionProbeBegin', payload: { id, commandId: fleetCommandId('probe-connection', id) } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/start-runtime') {
    const id = readIdentifierField(body, 'runtimeId');
    return id
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.runtimes.start.begin',
          input: { kind: 'runtimeStartBegin', payload: { id, commandId: fleetCommandId('start-runtime', id) } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/stop-runtime') {
    const id = readIdentifierField(body, 'runtimeId');
    return id
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.runtimes.stop.begin',
          input: { kind: 'runtimeStopBegin', payload: { id, commandId: fleetCommandId('stop-runtime', id) } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/sync-capabilities') {
    const id = readIdentifierField(body, 'endpointId');
    return id
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.capabilities.sync.begin',
          input: { kind: 'capabilitySyncBegin', payload: { id, commandId: fleetCommandId('sync-capabilities', id) } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/deploy-environment') {
    const id = readIdentifierField(body, 'environmentId');
    return id
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.environments.deploy.begin',
          input: { kind: 'environmentDeployBegin', payload: { id, commandId: fleetCommandId('deploy-environment', id), phase: 'deploy' } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/delete-environment') {
    const id = readIdentifierField(body, 'environmentId');
    return id
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.environments.delete.begin',
          input: { kind: 'environmentDeleteBegin', payload: { id, commandId: fleetCommandId('delete-environment', id), phase: 'delete' } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/terminal/open') {
    const payload = readTerminalOpenPayload(body);
    return payload
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.terminals.open',
          input: { kind: 'terminalOpen', payload },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/terminal/reconnect') {
    const sessionId = readIdentifierField(body, 'sessionId');
    return sessionId
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.terminals.reconnect',
          input: { kind: 'terminalReconnect', payload: { sessionId } },
        },
      }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/delete-connection') {
    const id = readIdentifierField(body, 'connectionId');
    return id
      ? { kind: 'request', request: { operation: 'fleet.connections.remove', input: { kind: 'connectionRemove', payload: { id } } } }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/remove-node') {
    const id = readIdentifierField(body, 'nodeId');
    return id
      ? { kind: 'request', request: { operation: 'fleet.nodes.retire', input: { kind: 'nodeRetire', payload: { id } } } }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/revoke-agent') {
    const id = readIdentifierField(body, 'agentId');
    return id
      ? { kind: 'request', request: { operation: 'fleet.agents.revoke', input: { kind: 'agentRevoke', payload: { id } } } }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/drain-endpoint') {
    const id = readIdentifierField(body, 'endpointId');
    return id
      ? { kind: 'request', request: { operation: 'fleet.endpoints.drain', input: { kind: 'endpointDrain', payload: { id } } } }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/retire-endpoint') {
    const id = readIdentifierField(body, 'endpointId');
    return id
      ? { kind: 'request', request: { operation: 'fleet.endpoints.retire', input: { kind: 'endpointRetire', payload: { id } } } }
      : { kind: 'invalid' };
  }
  if (pathname === '/api/remote-fleet/terminal/close') {
    const sessionId = readIdentifierField(body, 'sessionId');
    return sessionId
      ? {
        kind: 'request',
        request: {
          operation: 'fleet.terminals.close',
          input: { kind: 'terminalClose', payload: { sessionId } },
        },
      }
      : { kind: 'invalid' };
  }
  return { kind: 'unavailable' };
}

function readTerminalOpenPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const payload: Record<string, unknown> = {};
  if (isIdentifier(value.nodeId)) payload.nodeId = value.nodeId;
  if (isIdentifier(value.runtimeId)) payload.runtimeId = value.runtimeId;
  if (isIdentifier(value.endpointId)) payload.endpointId = value.endpointId;
  const selectorCount = ['nodeId', 'runtimeId', 'endpointId'].filter((key) => isIdentifier(payload[key])).length;
  if (selectorCount !== 1) return null;
  if (value.size !== undefined) {
    if (!isRecord(value.size) || !isTerminalDimension(value.size.rows) || !isTerminalDimension(value.size.cols)) return null;
    payload.size = { rows: value.size.rows, cols: value.size.cols };
  }
  return payload;
}

function readIdentifierField(value: unknown, key: string): string | null {
  if (!isRecord(value) || !isIdentifier(value[key])) return null;
  return value[key];
}

function fleetCommandId(action: string, id: string): string {
  return `${action}:${id}:${Date.now()}`;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTerminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1000;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type FleetRegistrationRoute =
  | 'register-connection'
  | 'register-environment'
  | 'register-node';

export type FleetLegacyTargetKind =
  | 'ssh-host'
  | 'container'
  | 'k8s-pod'
  | 'custom'
  | 'vm';

export type FleetLegacyConnectionKind = FleetLegacyTargetKind;
export type FleetLegacyEnvironmentKind =
  | 'ssh-workdir'
  | 'docker-container'
  | 'k8s-workload'
  | 'vm-workdir'
  | 'custom';

export type FleetRegistrationAssociation = Readonly<{
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  nodeId: string | null;
}>;

export type FleetLegacySecretRef = Readonly<{
  kind: 'secret-ref';
  ref: string;
}>;

export type FleetLegacyConnectionRegistration = Readonly<{
  id?: string;
  displayName?: string;
  description?: string;
  connectionKind?: FleetLegacyConnectionKind;
  targetKind?: FleetLegacyTargetKind;
  endpointUrl?: string;
  labels?: readonly string[];
  enabled?: boolean;
  publicConfig?: Readonly<Record<string, unknown>>;
  secretRefs?: Readonly<Record<string, FleetLegacySecretRef>>;
}>;

export type FleetLegacyEnvironmentRegistration = Readonly<{
  id?: string;
  connectionId?: string;
  nodeId?: string;
  displayName?: string;
  description?: string;
  environmentKind?: FleetLegacyEnvironmentKind;
  targetKind?: FleetLegacyTargetKind;
  labels?: readonly string[];
  enabled?: boolean;
  publicConfig?: Readonly<Record<string, unknown>>;
  secretRefs?: Readonly<Record<string, FleetLegacySecretRef>>;
}>;

export type FleetLegacyNodeRegistration = Readonly<{
  id?: string;
  connectionId?: string;
  environmentId?: string;
  managedResourceId?: string;
  displayName?: string;
  description?: string;
  targetKind?: FleetLegacyTargetKind;
  endpointUrl?: string;
  labels?: readonly string[];
  enabled?: boolean;
  publicConfig?: Readonly<Record<string, unknown>>;
  secretRefs?: Readonly<Record<string, FleetLegacySecretRef>>;
}>;

type FleetConnectionKind = 'sshHost' | 'container' | 'vm' | 'kubernetesPod' | 'custom';
type FleetEnvironmentKind = 'sshWorkdir' | 'dockerContainer' | 'kubernetesWorkload' | 'vmWorkdir' | 'custom';

type FleetConnectionUpsertPayload = Readonly<{
  id: string;
  kind: FleetConnectionKind;
  displayName: string;
  endpoint: string | null;
  labels: readonly string[];
  enabled: boolean;
  publicConfig: Readonly<Record<string, string>>;
  secretRefs: Readonly<Record<string, string>>;
}>;

type FleetEnvironmentRegisterPayload = Readonly<{
  id: string;
  connectionId: string;
  kind: FleetEnvironmentKind;
  displayName: string;
  labels: readonly string[];
  enabled: boolean;
  publicConfig: Readonly<Record<string, string>>;
  secretRefs: Readonly<Record<string, string>>;
}>;

export type FleetRegistrationMutationRequest = Readonly<{
  operation: 'fleet.connections.upsert' | 'fleet.environments.register';
  input: Readonly<{
    kind: 'connectionUpsert' | 'environmentRegister';
    payload: FleetConnectionUpsertPayload | FleetEnvironmentRegisterPayload;
  }>;
}>;

export type FleetRegistrationProjectionRequirement = Readonly<{
  responseKey: 'connection' | 'environment' | 'node' | 'agent' | 'runtime';
  source: 'fleet.connections.list' | 'fleet.environments.list' | 'fleet.topology.get';
  id?: string;
  association?: FleetRegistrationAssociation;
}>;

export type FleetRegistrationProjectionContract = Readonly<{
  source: 'canonical-fleet-read';
  requirements: readonly FleetRegistrationProjectionRequirement[];
}>;

export type FleetRegistrationStep = Readonly<{
  sequence: number;
  request: FleetRegistrationMutationRequest;
  association: FleetRegistrationAssociation;
}>;

export type FleetRegistrationRejectionCode =
  | 'invalid_body'
  | 'missing_canonical_id'
  | 'missing_canonical_kind'
  | 'missing_canonical_display_name'
  | 'missing_canonical_enabled'
  | 'conflicting_kind'
  | 'unsupported_description'
  | 'unsupported_public_config'
  | 'unsupported_secret_refs'
  | 'unsupported_environment_association'
  | 'unsupported_node_registration'
  | 'canonical_outcome_rejected'
  | 'canonical_projection_unavailable'
  | 'canonical_projection_ambiguous';

export type FleetRegistrationRejection = Readonly<{
  code: FleetRegistrationRejectionCode;
  message: string;
}>;

export type FleetRegistrationPlan = Readonly<{
  route: FleetRegistrationRoute;
  status: 'accepted' | 'rejected';
  sequence: readonly FleetRegistrationStep[];
  association: FleetRegistrationAssociation;
  projection: FleetRegistrationProjectionContract | null;
  rejection?: FleetRegistrationRejection;
}>;

export type FleetRegistrationStepReceipt = Readonly<{
  sequence: number;
  operation: FleetRegistrationStep['request']['operation'];
  outcome: 'connectionUpdated' | 'environmentRegistered';
}>;

export type FleetRegistrationReceipt = Readonly<{
  route: FleetRegistrationRoute;
  status: 'accepted' | 'rejected';
  sequence: readonly FleetRegistrationStepReceipt[];
  association: FleetRegistrationAssociation;
  projection: FleetRegistrationProjectionContract | null;
  rejection?: FleetRegistrationRejection;
}>;

export type FleetCanonicalConnection = Readonly<{
  id: string;
  kind: FleetConnectionKind;
  displayName: string;
  endpoint: string | null;
  labels: readonly string[];
  enabled: boolean;
}>;

export type FleetCanonicalEnvironment = Readonly<{
  id: string;
  connectionId: string;
  kind: FleetEnvironmentKind;
  displayName: string;
  labels: readonly string[];
  enabled: boolean;
}>;

export type FleetCanonicalNode = Readonly<{
  id: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  health: 'unknown' | 'online' | 'offline' | 'disabled' | 'error';
}>;

export type FleetCanonicalAgent = Readonly<{
  id: string;
  nodeId: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
}>;

export type FleetCanonicalRuntime = Readonly<{
  id: string;
  nodeId: string;
  agentId: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  kind: 'openClaw' | 'matchaAgent' | 'plugin';
  state: 'discovered' | 'running' | 'stopped' | 'degraded' | 'retired';
}>;

export type FleetCanonicalReadFacts = Readonly<{
  connections: readonly FleetCanonicalConnection[];
  environments: readonly FleetCanonicalEnvironment[];
  nodes: readonly FleetCanonicalNode[];
  agents: readonly FleetCanonicalAgent[];
  runtimes: readonly FleetCanonicalRuntime[];
}>;

export type FleetLegacyConnectionProjection = Readonly<{
  id: string;
  displayName: string;
  connectionKind: FleetLegacyConnectionKind;
  targetKind: FleetLegacyTargetKind;
  endpointUrl?: string;
  labels: readonly string[];
  enabled: boolean;
}>;

export type FleetLegacyEnvironmentProjection = Readonly<{
  id: string;
  connectionId: string;
  displayName: string;
  environmentKind: FleetLegacyEnvironmentKind;
  targetKind: FleetLegacyTargetKind;
  labels: readonly string[];
  enabled: boolean;
}>;

export type FleetLegacyNodeProjection = Readonly<{
  id: string;
  connectionId?: string;
  environmentId?: string;
  managedResourceId?: string;
  status: FleetCanonicalNode['health'];
}>;

export type FleetLegacyAgentProjection = Readonly<{
  id: string;
  nodeId: string;
  connectionId?: string;
  environmentId?: string;
  managedResourceId?: string;
}>;

export type FleetLegacyRuntimeProjection = Readonly<{
  id: string;
  nodeId: string;
  agentId: string;
  connectionId?: string;
  environmentId?: string;
  managedResourceId?: string;
  status: FleetCanonicalRuntime['state'];
}>;

export type FleetRegistrationProjection = Readonly<{
  source: 'canonical-fleet-read';
  connection?: FleetLegacyConnectionProjection;
  environment?: FleetLegacyEnvironmentProjection;
  node?: FleetLegacyNodeProjection;
  agent?: FleetLegacyAgentProjection;
  runtime?: FleetLegacyRuntimeProjection;
}>;

export type FleetRegistrationLegacyResponse = Readonly<{
  connection?: FleetLegacyConnectionProjection;
  environment?: FleetLegacyEnvironmentProjection;
  node?: FleetLegacyNodeProjection;
  agent?: FleetLegacyAgentProjection;
  runtime?: FleetLegacyRuntimeProjection;
  registration: FleetRegistrationReceipt;
}>;

const EMPTY_ASSOCIATION: FleetRegistrationAssociation = {
  connectionId: null,
  environmentId: null,
  managedResourceId: null,
  nodeId: null,
};

export function buildFleetRegistrationPlan(
  route: FleetRegistrationRoute,
  body: unknown,
): FleetRegistrationPlan {
  const input = unwrapInput(body, route);
  if (!input) return rejectedPlan(route, 'invalid_body', 'Fleet registration body must be an object.');
  if (route === 'register-connection') return buildConnectionPlan(input);
  if (route === 'register-environment') return buildEnvironmentPlan(input);
  return rejectedPlan(
    route,
    'unsupported_node_registration',
    'Fleet node registration has no Rust canonical registration authority; use a canonical node observation instead.',
  );
}

export function completeFleetRegistrationReceipt(
  plan: FleetRegistrationPlan,
  outcomes: readonly FleetRegistrationStepReceipt[],
  projection?: FleetRegistrationProjection,
): FleetRegistrationReceipt {
  if (plan.status === 'rejected') {
    return {
      route: plan.route,
      status: 'rejected',
      sequence: [],
      association: plan.association,
      projection: null,
      rejection: plan.rejection,
    };
  }

  if (!matchesSequence(plan.sequence, outcomes)) {
    return rejectedReceipt(
      plan,
      'canonical_outcome_rejected',
      'Fleet canonical mutation receipt did not match the frozen registration sequence.',
      outcomes,
    );
  }
  if (!projection || !matchesProjectionContract(plan.projection, projection)) {
    return rejectedReceipt(
      plan,
      'canonical_projection_unavailable',
      'Fleet canonical owner did not return the projection required by the registration contract.',
      outcomes,
    );
  }
  return {
    route: plan.route,
    status: 'accepted',
    sequence: outcomes,
    association: plan.association,
    projection: plan.projection,
  };
}

export function projectFleetRegistration(
  plan: FleetRegistrationPlan,
  facts: FleetCanonicalReadFacts,
): FleetRegistrationProjection | FleetRegistrationRejection {
  if (plan.status === 'rejected' || !plan.projection) {
    return plan.rejection ?? {
      code: 'canonical_projection_unavailable',
      message: 'Fleet registration projection is unavailable for a rejected plan.',
    };
  }

  const connectionResult = plan.route === 'register-connection'
    ? findUnique(facts.connections, (item) => item.id === plan.association.connectionId)
    : { kind: 'missing' as const };
  if (plan.route === 'register-connection' && connectionResult.kind !== 'found') {
    return lookupRejection(
      connectionResult,
      'Canonical Fleet connection projection is unavailable.',
      'Canonical Fleet connection projection is ambiguous.',
    );
  }

  const environmentResult = plan.route === 'register-environment'
    ? findUnique(facts.environments, (item) => item.id === plan.association.environmentId)
    : { kind: 'missing' as const };
  const nodeResult = plan.route === 'register-environment'
    ? findUnique(facts.nodes, (item) => item.id === plan.association.nodeId)
    : { kind: 'missing' as const };
  if (plan.route === 'register-environment'
    && (environmentResult.kind !== 'found' || nodeResult.kind !== 'found')) {
    return lookupRejection(
      environmentResult.kind !== 'found' ? environmentResult : nodeResult,
      'Canonical Fleet environment association projection is unavailable.',
      'Canonical Fleet environment association projection is ambiguous.',
    );
  }

  const connection = connectionResult.kind === 'found' ? connectionResult.value : undefined;
  const environment = environmentResult.kind === 'found' ? environmentResult.value : undefined;
  const node = nodeResult.kind === 'found' ? nodeResult.value : undefined;
  if (plan.route === 'register-environment'
    && (!environment || !node
      || !matchesCanonicalAssociation(environment, plan.association)
      || !matchesCanonicalAssociation(node, plan.association)
      || node.environmentId !== environment.id)) {
    return {
      code: 'canonical_projection_unavailable',
      message: 'Canonical Fleet environment association projection is unavailable.',
    };
  }

  const agentResult = node
    ? findUnique(facts.agents, (item) => item.nodeId === node.id)
    : { kind: 'missing' as const };
  const runtimeResult = agentResult.kind === 'found'
    ? findUnique(facts.runtimes, (item) => item.nodeId === node?.id && item.agentId === agentResult.value.id)
    : { kind: 'missing' as const };
  if (plan.route === 'register-environment'
    && (agentResult.kind !== 'found' || runtimeResult.kind !== 'found')) {
    return lookupRejection(
      agentResult.kind !== 'found' ? agentResult : runtimeResult,
      'Canonical Fleet agent/runtime projection is unavailable.',
      'Canonical Fleet agent/runtime projection is ambiguous.',
    );
  }

  const agent = agentResult.kind === 'found' ? agentResult.value : undefined;
  const runtime = runtimeResult.kind === 'found' ? runtimeResult.value : undefined;
  if (plan.route === 'register-environment'
    && (!agent || !runtime
      || !matchesCanonicalAssociation(agent, plan.association)
      || !matchesCanonicalAssociation(runtime, plan.association))) {
    return {
      code: 'canonical_projection_unavailable',
      message: 'Canonical Fleet agent/runtime association projection is unavailable.',
    };
  }

  return {
    source: 'canonical-fleet-read',
    ...(connection ? { connection: projectConnection(connection) } : {}),
    ...(environment ? { environment: projectEnvironment(environment) } : {}),
    ...(node ? { node: projectNode(node) } : {}),
    ...(agent ? { agent: projectAgent(agent) } : {}),
    ...(runtime ? { runtime: projectRuntime(runtime) } : {}),
  };
}

export function toFleetRegistrationLegacyResponse(
  receipt: FleetRegistrationReceipt,
  projection: FleetRegistrationProjection | undefined,
): FleetRegistrationLegacyResponse {
  return {
    ...(projection?.connection ? { connection: projection.connection } : {}),
    ...(projection?.environment ? { environment: projection.environment } : {}),
    ...(projection?.node ? { node: projection.node } : {}),
    ...(projection?.agent ? { agent: projection.agent } : {}),
    ...(projection?.runtime ? { runtime: projection.runtime } : {}),
    registration: receipt,
  };
}

function buildConnectionPlan(input: Record<string, unknown>): FleetRegistrationPlan {
  const id = requiredString(input, 'id');
  if (!id) return rejectedPlan('register-connection', 'missing_canonical_id', 'Fleet connection id must be supplied by the registration authority.');
  const displayName = requiredString(input, 'displayName');
  if (!displayName) return rejectedPlan('register-connection', 'missing_canonical_display_name', 'Fleet connection displayName is required by the Rust canonical request.');
  if (typeof input.enabled !== 'boolean') return rejectedPlan('register-connection', 'missing_canonical_enabled', 'Fleet connection enabled is required by the Rust canonical request.');

  const kind = resolveConnectionKind(input);
  if (!kind) return rejectedPlan('register-connection', 'missing_canonical_kind', 'Fleet connection kind must be explicit; the adapter does not infer it from an endpoint.');
  if (kind.reason) return rejectedPlan('register-connection', kind.reason.code, kind.reason.message);

  const publicConfig = readStringMap(input.publicConfig);
  if (!publicConfig.ok) return rejectedPlan('register-connection', 'unsupported_public_config', 'Fleet connection publicConfig must be a flat string map; nested provider config is not representable by Rust Fleet.');
  const secretRefs = readSecretRefs(input.secretRefs);
  if (!secretRefs.ok) return rejectedPlan('register-connection', 'unsupported_secret_refs', 'Fleet connection secretRefs must contain only secret-ref references.');
  if (input.description !== undefined) return rejectedPlan('register-connection', 'unsupported_description', 'Rust Fleet connection upsert has no description field.');

  const association: FleetRegistrationAssociation = { ...EMPTY_ASSOCIATION, connectionId: id };
  const payload: FleetConnectionUpsertPayload = {
    id,
    kind: kind.value,
    displayName,
    endpoint: optionalString(input.endpointUrl),
    labels: readStringArray(input.labels),
    enabled: input.enabled,
    publicConfig: publicConfig.value,
    secretRefs: secretRefs.value,
  };
  return {
    route: 'register-connection',
    status: 'accepted',
    sequence: [{
      sequence: 1,
      request: { operation: 'fleet.connections.upsert', input: { kind: 'connectionUpsert', payload } },
      association,
    }],
    association,
    projection: {
      source: 'canonical-fleet-read',
      requirements: [{ responseKey: 'connection', source: 'fleet.connections.list', id }],
    },
  };
}

function buildEnvironmentPlan(input: Record<string, unknown>): FleetRegistrationPlan {
  const id = requiredString(input, 'id');
  if (!id) return rejectedPlan('register-environment', 'missing_canonical_id', 'Fleet environment id must be supplied by the registration authority.');
  const connectionId = requiredString(input, 'connectionId');
  if (!connectionId) return rejectedPlan('register-environment', 'invalid_body', 'Fleet environment connectionId is required.');
  const displayName = requiredString(input, 'displayName');
  if (!displayName) return rejectedPlan('register-environment', 'missing_canonical_display_name', 'Fleet environment displayName is required by the Rust canonical request.');
  if (typeof input.enabled !== 'boolean') return rejectedPlan('register-environment', 'missing_canonical_enabled', 'Fleet environment enabled is required by the Rust canonical request.');
  const nodeId = requiredString(input, 'nodeId');
  if (!nodeId) return rejectedPlan('register-environment', 'unsupported_environment_association', 'Legacy environment registration requires an explicit nodeId; the adapter does not synthesize node, agent, or runtime identities.');

  const kind = resolveEnvironmentKind(input);
  if (!kind) return rejectedPlan('register-environment', 'missing_canonical_kind', 'Fleet environment kind must be explicit; the adapter does not infer it from an endpoint.');
  if (kind.reason) return rejectedPlan('register-environment', kind.reason.code, kind.reason.message);
  const publicConfig = readStringMap(input.publicConfig);
  if (!publicConfig.ok) return rejectedPlan('register-environment', 'unsupported_public_config', 'Fleet environment publicConfig must be a flat string map; nested provider config is not representable by Rust Fleet.');
  const secretRefs = readSecretRefs(input.secretRefs);
  if (!secretRefs.ok) return rejectedPlan('register-environment', 'unsupported_secret_refs', 'Fleet environment secretRefs must contain only secret-ref references.');
  if (input.description !== undefined) return rejectedPlan('register-environment', 'unsupported_description', 'Rust Fleet environment register has no description field.');

  const association: FleetRegistrationAssociation = {
    connectionId,
    environmentId: id,
    managedResourceId: null,
    nodeId,
  };
  const payload: FleetEnvironmentRegisterPayload = {
    id,
    connectionId,
    kind: kind.value,
    displayName,
    labels: readStringArray(input.labels),
    enabled: input.enabled,
    publicConfig: publicConfig.value,
    secretRefs: secretRefs.value,
  };
  return {
    route: 'register-environment',
    status: 'accepted',
    sequence: [{
      sequence: 1,
      request: { operation: 'fleet.environments.register', input: { kind: 'environmentRegister', payload } },
      association,
    }],
    association,
    projection: {
      source: 'canonical-fleet-read',
      requirements: [
        { responseKey: 'environment', source: 'fleet.environments.list', id },
        { responseKey: 'node', source: 'fleet.topology.get', id: nodeId, association },
        { responseKey: 'agent', source: 'fleet.topology.get', association },
        { responseKey: 'runtime', source: 'fleet.topology.get', association },
      ],
    },
  };
}

function unwrapInput(body: unknown, route: FleetRegistrationRoute): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const key = route === 'register-connection' ? 'connection' : route === 'register-environment' ? 'environment' : 'node';
  const value = body[key] ?? body;
  return isRecord(value) ? value : null;
}

function resolveConnectionKind(
  input: Record<string, unknown>,
): { value: FleetConnectionKind; reason?: undefined } | { reason: FleetRegistrationRejection } | null {
  const connectionKind = input.connectionKind;
  const targetKind = input.targetKind;
  if (connectionKind !== undefined && !isLegacyTargetKind(connectionKind)) return null;
  if (targetKind !== undefined && !isLegacyTargetKind(targetKind)) return null;
  if (connectionKind !== undefined && targetKind !== undefined && connectionKind !== targetKind) {
    return { reason: { code: 'conflicting_kind', message: 'Fleet connectionKind and targetKind disagree.' } };
  }
  const value = connectionKind ?? targetKind;
  return value ? { value: toCanonicalConnectionKind(value) } : null;
}

function resolveEnvironmentKind(
  input: Record<string, unknown>,
): { value: FleetEnvironmentKind; reason?: undefined } | { reason: FleetRegistrationRejection } | null {
  const environmentKind = input.environmentKind;
  const targetKind = input.targetKind;
  if (environmentKind !== undefined && !isLegacyEnvironmentKind(environmentKind)) return null;
  if (targetKind !== undefined && !isLegacyTargetKind(targetKind)) return null;
  if (environmentKind !== undefined && targetKind !== undefined && toTargetForEnvironmentKind(environmentKind) !== targetKind) {
    return { reason: { code: 'conflicting_kind', message: 'Fleet environmentKind and targetKind disagree.' } };
  }
  const value = environmentKind ?? (targetKind === undefined ? undefined : environmentKindForTargetKind(targetKind));
  return value ? { value: toCanonicalEnvironmentKind(value) } : null;
}

function toCanonicalConnectionKind(value: FleetLegacyConnectionKind): FleetConnectionKind {
  switch (value) {
    case 'ssh-host': return 'sshHost';
    case 'container': return 'container';
    case 'vm': return 'vm';
    case 'k8s-pod': return 'kubernetesPod';
    case 'custom': return 'custom';
  }
}

function toCanonicalEnvironmentKind(value: FleetLegacyEnvironmentKind): FleetEnvironmentKind {
  switch (value) {
    case 'ssh-workdir': return 'sshWorkdir';
    case 'docker-container': return 'dockerContainer';
    case 'k8s-workload': return 'kubernetesWorkload';
    case 'vm-workdir': return 'vmWorkdir';
    case 'custom': return 'custom';
  }
}

function environmentKindForTargetKind(value: FleetLegacyTargetKind): FleetLegacyEnvironmentKind {
  switch (value) {
    case 'ssh-host': return 'ssh-workdir';
    case 'container': return 'docker-container';
    case 'k8s-pod': return 'k8s-workload';
    case 'vm': return 'vm-workdir';
    case 'custom': return 'custom';
  }
}

function toTargetForEnvironmentKind(value: FleetLegacyEnvironmentKind): FleetLegacyTargetKind {
  switch (value) {
    case 'ssh-workdir': return 'ssh-host';
    case 'docker-container': return 'container';
    case 'k8s-workload': return 'k8s-pod';
    case 'vm-workdir': return 'vm';
    case 'custom': return 'custom';
  }
}

function projectConnection(value: FleetCanonicalConnection): FleetLegacyConnectionProjection {
  const targetKind = targetForConnectionKind(value.kind);
  return {
    id: value.id,
    displayName: value.displayName,
    connectionKind: targetKind,
    targetKind,
    ...(value.endpoint ? { endpointUrl: value.endpoint } : {}),
    labels: value.labels,
    enabled: value.enabled,
  };
}

function projectEnvironment(value: FleetCanonicalEnvironment): FleetLegacyEnvironmentProjection {
  const targetKind = toTargetForEnvironmentKind(legacyEnvironmentKind(value.kind));
  return {
    id: value.id,
    connectionId: value.connectionId,
    displayName: value.displayName,
    environmentKind: legacyEnvironmentKind(value.kind),
    targetKind,
    labels: value.labels,
    enabled: value.enabled,
  };
}

function projectNode(value: FleetCanonicalNode): FleetLegacyNodeProjection {
  return {
    id: value.id,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}),
    ...(value.environmentId ? { environmentId: value.environmentId } : {}),
    ...(value.managedResourceId ? { managedResourceId: value.managedResourceId } : {}),
    status: value.health,
  };
}

function projectAgent(value: FleetCanonicalAgent): FleetLegacyAgentProjection {
  return {
    id: value.id,
    nodeId: value.nodeId,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}),
    ...(value.environmentId ? { environmentId: value.environmentId } : {}),
    ...(value.managedResourceId ? { managedResourceId: value.managedResourceId } : {}),
  };
}

function projectRuntime(value: FleetCanonicalRuntime): FleetLegacyRuntimeProjection {
  return {
    id: value.id,
    nodeId: value.nodeId,
    agentId: value.agentId,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}),
    ...(value.environmentId ? { environmentId: value.environmentId } : {}),
    ...(value.managedResourceId ? { managedResourceId: value.managedResourceId } : {}),
    status: value.state,
  };
}

function targetForConnectionKind(value: FleetConnectionKind): FleetLegacyTargetKind {
  switch (value) {
    case 'sshHost': return 'ssh-host';
    case 'container': return 'container';
    case 'vm': return 'vm';
    case 'kubernetesPod': return 'k8s-pod';
    case 'custom': return 'custom';
  }
}

function legacyEnvironmentKind(value: FleetEnvironmentKind): FleetLegacyEnvironmentKind {
  switch (value) {
    case 'sshWorkdir': return 'ssh-workdir';
    case 'dockerContainer': return 'docker-container';
    case 'kubernetesWorkload': return 'k8s-workload';
    case 'vmWorkdir': return 'vm-workdir';
    case 'custom': return 'custom';
  }
}

type CanonicalLookup<T> =
  | Readonly<{ kind: 'found'; value: T }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'ambiguous' }>;

function findUnique<T>(items: readonly T[], predicate: (item: T) => boolean): CanonicalLookup<T> {
  const matches = items.filter(predicate);
  if (matches.length === 1) return { kind: 'found', value: matches[0] };
  return matches.length === 0 ? { kind: 'missing' } : { kind: 'ambiguous' };
}

function lookupRejection<T>(
  result: CanonicalLookup<T>,
  unavailableMessage: string,
  ambiguousMessage: string,
): FleetRegistrationRejection {
  return {
    code: result.kind === 'ambiguous' ? 'canonical_projection_ambiguous' : 'canonical_projection_unavailable',
    message: result.kind === 'ambiguous' ? ambiguousMessage : unavailableMessage,
  };
}

function matchesCanonicalAssociation(
  value: Readonly<{
    connectionId: string | null;
    environmentId?: string | null;
    managedResourceId?: string | null;
  }>,
  association: FleetRegistrationAssociation,
): boolean {
  return value.connectionId === association.connectionId
    && (value.environmentId === undefined || value.environmentId === association.environmentId)
    && (value.managedResourceId === undefined || value.managedResourceId === association.managedResourceId);
}

function matchesSequence(
  sequence: readonly FleetRegistrationStep[],
  outcomes: readonly FleetRegistrationStepReceipt[],
): boolean {
  return sequence.length === outcomes.length && sequence.every((step, index) => {
    const outcome = outcomes[index];
    const expected = step.request.operation === 'fleet.connections.upsert' ? 'connectionUpdated' : 'environmentRegistered';
    return outcome.sequence === step.sequence && outcome.operation === step.request.operation && outcome.outcome === expected;
  });
}

function matchesProjectionContract(
  contract: FleetRegistrationProjectionContract | null,
  projection: FleetRegistrationProjection,
): boolean {
  if (!contract || projection.source !== contract.source) return false;
  return contract.requirements.every((requirement) => {
    const value = projection[requirement.responseKey];
    return value !== undefined && (!requirement.id || value.id === requirement.id);
  });
}

function rejectedPlan(
  route: FleetRegistrationRoute,
  code: FleetRegistrationRejectionCode,
  message: string,
): FleetRegistrationPlan {
  return {
    route,
    status: 'rejected',
    sequence: [],
    association: EMPTY_ASSOCIATION,
    projection: null,
    rejection: { code, message },
  };
}

function rejectedReceipt(
  plan: FleetRegistrationPlan,
  code: FleetRegistrationRejectionCode,
  message: string,
  outcomes: readonly FleetRegistrationStepReceipt[],
): FleetRegistrationReceipt {
  return {
    route: plan.route,
    status: 'rejected',
    sequence: outcomes,
    association: plan.association,
    projection: null,
    rejection: { code, message },
  };
}

function requiredString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.trim().length > 0 ? item.trim() : undefined;
}

function optionalString(value: unknown): string | null {
  return value === undefined ? null : typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.map((item) => item.trim()).filter(Boolean) : [];
}

function readStringMap(value: unknown): { ok: true; value: Record<string, string> } | { ok: false } {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false };
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === 'string')
    ? { ok: true, value: Object.fromEntries(entries.map(([key, item]) => [key, item as string])) }
    : { ok: false };
}

function readSecretRefs(value: unknown): { ok: true; value: Record<string, string> } | { ok: false } {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false };
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => isRecord(item) && item.kind === 'secret-ref' && typeof item.ref === 'string')) return { ok: false };
  return { ok: true, value: Object.fromEntries(entries.map(([key, item]) => [key, (item as FleetLegacySecretRef).ref])) };
}

function isLegacyTargetKind(value: unknown): value is FleetLegacyTargetKind {
  return value === 'ssh-host' || value === 'container' || value === 'k8s-pod' || value === 'custom' || value === 'vm';
}

function isLegacyEnvironmentKind(value: unknown): value is FleetLegacyEnvironmentKind {
  return value === 'ssh-workdir' || value === 'docker-container' || value === 'k8s-workload' || value === 'vm-workdir' || value === 'custom';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

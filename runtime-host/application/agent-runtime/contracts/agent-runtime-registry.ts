import { createRuntimeSessionContext } from './runtime-session-context';
import { buildRuntimeEndpointCapabilityDescriptors } from './runtime-capability-descriptors';
import {
  agentScope,
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  connectorRuntimeEndpoint,
  nativeRuntimeEndpoint,
  runtimeInstanceScope,
  sessionScope,
  type RuntimeEndpointRef,
  type RuntimeScope,
  type SessionIdentity,
} from './runtime-address';
import { CapabilityRegistry } from '../../capabilities/contracts/capability-registry';
import type { CapabilityDescriptor } from '../../capabilities/contracts/capability-descriptor';
import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../../gateway/gateway-runtime-port';
import type {
  RuntimeAdapterInstanceSummary,
  RuntimeAdapterSummary,
  RuntimeConnectorSummary,
  RuntimeEndpointCapabilitySummary,
  RuntimeEndpointControlStateSummary,
  RuntimeEndpointReadinessSummary,
  RuntimeEndpointSummary,
  RuntimeProtocolSummary,
  RuntimeTopologySnapshot,
} from '../../../shared/runtime-topology';
import type {
  RuntimeAdapter,
  RuntimeAdapterId,
  RuntimeApprovalNotificationAdapter,
  RuntimeConnectorId,
  RuntimeEndpointDiscovery,
  RuntimeEndpointId,
  RuntimeEndpointProfile,
  RuntimeEndpointRegistration,
  RuntimeProtocolAdapter,
  RuntimeProtocolConnector,
  RuntimeProtocolId,
  RuntimeSessionContext,
  RuntimeSessionTransport,
} from './runtime-endpoint-types';

class RuntimeProtocolRegistry {
  private readonly protocols = new Map<RuntimeProtocolId, RuntimeProtocolAdapter>();

  register(protocol: RuntimeProtocolAdapter): void {
    const existing = this.protocols.get(protocol.protocolId);
    if (existing && existing !== protocol) {
      throw new Error(`Runtime protocol already registered: ${protocol.protocolId}`);
    }
    this.protocols.set(protocol.protocolId, protocol);
  }

  list(): RuntimeProtocolAdapter[] {
    return Array.from(this.protocols.values());
  }

  get(protocolId: RuntimeProtocolId): RuntimeProtocolAdapter {
    const protocol = this.protocols.get(protocolId);
    if (!protocol) {
      throw new Error(`Runtime protocol not registered: ${protocolId}`);
    }
    return protocol;
  }

  has(protocolId: RuntimeProtocolId): boolean {
    return this.protocols.has(protocolId);
  }
}

class RuntimeAdapterRegistry {
  private readonly adapters = new Map<RuntimeAdapterId, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (this.adapters.has(adapter.runtimeAdapterId)) {
      throw new Error(`Runtime adapter already registered: ${adapter.runtimeAdapterId}`);
    }
    this.adapters.set(adapter.runtimeAdapterId, adapter);
  }

  list(): RuntimeAdapter[] {
    return Array.from(this.adapters.values());
  }

  get(adapterId: RuntimeAdapterId): RuntimeAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`Runtime adapter not registered: ${adapterId}`);
    }
    return adapter;
  }
}

class RuntimeConnectorRegistry {
  private readonly connectors = new Map<string, RuntimeProtocolConnector>();

  register(connector: RuntimeProtocolConnector): void {
    const key = this.buildKey(connector.protocol.protocolId, connector.connectorId);
    if (this.connectors.has(key)) {
      throw new Error(`Runtime connector already registered: ${key}`);
    }
    this.connectors.set(key, connector);
  }

  list(): RuntimeProtocolConnector[] {
    return Array.from(this.connectors.values());
  }

  get(protocolId: RuntimeProtocolId, connectorId: RuntimeConnectorId): RuntimeProtocolConnector {
    const key = this.buildKey(protocolId, connectorId);
    const connector = this.connectors.get(key);
    if (!connector) {
      throw new Error(`Runtime connector not registered: ${key}`);
    }
    return connector;
  }

  private buildKey(protocolId: RuntimeProtocolId, connectorId: RuntimeConnectorId): string {
    return `${protocolId}:${connectorId}`;
  }
}

class RuntimeEndpointCatalog {
  private readonly endpoints = new Map<string, RuntimeEndpointProfile>();
  private readonly endpointKeysById = new Map<RuntimeEndpointId, string[]>();
  private readonly nativeEndpoints = new Map<string, RuntimeEndpointProfile>();
  private readonly connectorEndpoints = new Map<string, RuntimeEndpointProfile>();

  register(endpoint: RuntimeEndpointProfile, protocols: RuntimeProtocolRegistry): void {
    if (!protocols.has(endpoint.protocolId)) {
      throw new Error(`Runtime protocol not registered for endpoint ${endpoint.id}: ${endpoint.protocolId}`);
    }
    const endpointKey = this.buildEndpointKey(endpoint);
    if (this.endpoints.has(endpointKey)) {
      throw new Error(`Runtime endpoint already registered: ${endpointKey}`);
    }
    this.endpoints.set(endpointKey, endpoint);
    this.endpointKeysById.set(endpoint.id, [...(this.endpointKeysById.get(endpoint.id) ?? []), endpointKey]);
    if (endpoint.runtimeAdapterId) {
      if (!endpoint.runtimeInstanceId) {
        throw new Error(`Native runtime endpoint requires runtimeInstanceId: ${endpoint.id}`);
      }
      const key = this.buildNativeKey(endpoint.runtimeAdapterId, endpoint.runtimeInstanceId);
      if (this.nativeEndpoints.has(key)) {
        throw new Error(`Native runtime endpoint already registered: ${key}`);
      }
      this.nativeEndpoints.set(key, endpoint);
    }
    if (endpoint.connectorId) {
      const key = this.buildConnectorKey(endpoint.protocolId, endpoint.connectorId, endpoint.id);
      if (this.connectorEndpoints.has(key)) {
        throw new Error(`Connector runtime endpoint already registered: ${key}`);
      }
      this.connectorEndpoints.set(key, endpoint);
    }
  }

  list(): RuntimeEndpointProfile[] {
    return Array.from(this.endpoints.values());
  }

  unregisterConnectorEndpoint(protocolId: RuntimeProtocolId, connectorId: RuntimeConnectorId, endpointId: RuntimeEndpointId): RuntimeEndpointProfile | null {
    const connectorKey = this.buildConnectorKey(protocolId, connectorId, endpointId);
    const endpoint = this.connectorEndpoints.get(connectorKey) ?? null;
    if (!endpoint) {
      return null;
    }
    const endpointKey = this.buildEndpointKey(endpoint);
    this.connectorEndpoints.delete(connectorKey);
    this.endpoints.delete(endpointKey);
    const remainingKeys = (this.endpointKeysById.get(endpoint.id) ?? []).filter((key) => key !== endpointKey);
    if (remainingKeys.length > 0) {
      this.endpointKeysById.set(endpoint.id, remainingKeys);
    } else {
      this.endpointKeysById.delete(endpoint.id);
    }
    return endpoint;
  }

  get(endpointId: RuntimeEndpointId): RuntimeEndpointProfile {
    const endpointKeys = this.endpointKeysById.get(endpointId) ?? [];
    if (endpointKeys.length === 0) {
      throw new Error(`Runtime endpoint not registered: ${endpointId}`);
    }
    if (endpointKeys.length > 1) {
      throw new Error(`Runtime endpoint id is ambiguous: ${endpointId}`);
    }
    return this.endpoints.get(endpointKeys[0]!)!;
  }

  getByRef(endpointRef: RuntimeEndpointRef): RuntimeEndpointProfile {
    return endpointRef.kind === 'native-runtime'
      ? this.getNative(endpointRef.runtimeAdapterId, endpointRef.runtimeInstanceId)
      : this.getConnector(endpointRef.protocolId, endpointRef.connectorId, endpointRef.endpointId);
  }

  getNative(runtimeAdapterId: RuntimeAdapterId, runtimeInstanceId: string): RuntimeEndpointProfile {
    const key = this.buildNativeKey(runtimeAdapterId, runtimeInstanceId);
    const endpoint = this.nativeEndpoints.get(key);
    if (!endpoint) {
      throw new Error(`Native runtime endpoint not registered: ${key}`);
    }
    return endpoint;
  }

  getConnector(protocolId: RuntimeProtocolId, connectorId: RuntimeConnectorId, endpointId: RuntimeEndpointId): RuntimeEndpointProfile {
    const key = this.buildConnectorKey(protocolId, connectorId, endpointId);
    const endpoint = this.connectorEndpoints.get(key);
    if (!endpoint) {
      throw new Error(`Connector runtime endpoint not registered: ${key}`);
    }
    return endpoint;
  }

  private buildEndpointKey(endpoint: RuntimeEndpointProfile): string {
    if (endpoint.runtimeAdapterId) {
      if (!endpoint.runtimeInstanceId) {
        throw new Error(`Native runtime endpoint requires runtimeInstanceId: ${endpoint.id}`);
      }
      return `native:${this.buildNativeKey(endpoint.runtimeAdapterId, endpoint.runtimeInstanceId)}`;
    }
    if (endpoint.connectorId) {
      return `connector:${this.buildConnectorKey(endpoint.protocolId, endpoint.connectorId, endpoint.id)}`;
    }
    return `protocol:${endpoint.protocolId}:${endpoint.id}`;
  }

  private buildNativeKey(runtimeAdapterId: RuntimeAdapterId, runtimeInstanceId: string): string {
    return `${runtimeAdapterId}:${runtimeInstanceId}`;
  }

  private buildConnectorKey(protocolId: RuntimeProtocolId, connectorId: RuntimeConnectorId, endpointId: RuntimeEndpointId): string {
    return `${protocolId}:${connectorId}:${endpointId}`;
  }
}

function assertEndpointAgent(endpoint: RuntimeEndpointProfile, agentId: string): void {
  if (endpoint.acceptsDynamicAgents || endpoint.agentIds.includes(agentId)) {
    return;
  }
  throw new Error(`Runtime endpoint agent not registered: ${endpoint.id}:${agentId}`);
}

function resolveConnectorEndpointProfile(
  connector: RuntimeProtocolConnector,
  endpointId: RuntimeEndpointId,
): RuntimeEndpointProfile {
  const endpoint = connector.endpoints.find((candidate) => candidate.id === endpointId);
  if (!endpoint) {
    throw new Error(`Runtime connector endpoint profile not registered: ${connector.protocol.protocolId}:${connector.connectorId}:${endpointId}`);
  }
  return {
    ...endpoint,
    protocolId: connector.protocol.protocolId,
    connectorId: connector.connectorId,
  };
}

function applyEndpointDiscovery(
  endpoint: RuntimeEndpointProfile,
  discovery: RuntimeEndpointDiscovery | null,
): RuntimeEndpointProfile {
  if (!discovery) {
    return endpoint;
  }
  return {
    ...endpoint,
    ...(discovery.displayName ? { displayName: discovery.displayName } : {}),
    ...(discovery.agentIds ? { agentIds: [...discovery.agentIds] } : {}),
    ...(discovery.acceptsDynamicAgents !== undefined ? { acceptsDynamicAgents: discovery.acceptsDynamicAgents } : {}),
    ...(discovery.capabilities ? { capabilities: { ...discovery.capabilities } } : {}),
  };
}

function connectorEndpointRef(input: {
  protocolId: RuntimeProtocolId;
  connectorId: RuntimeConnectorId;
  endpointId: RuntimeEndpointId;
}): RuntimeEndpointRef {
  return connectorRuntimeEndpoint({
    protocolId: input.protocolId,
    connectorId: input.connectorId,
    endpointId: input.endpointId,
  });
}

function endpointRefForProfile(endpoint: RuntimeEndpointProfile): RuntimeEndpointRef {
  if (endpoint.runtimeAdapterId && endpoint.runtimeInstanceId) {
    return nativeRuntimeEndpoint({
      runtimeAdapterId: endpoint.runtimeAdapterId,
      runtimeInstanceId: endpoint.runtimeInstanceId,
    });
  }
  if (endpoint.connectorId) {
    return connectorRuntimeEndpoint({
      protocolId: endpoint.protocolId,
      connectorId: endpoint.connectorId,
      endpointId: endpoint.id,
    });
  }
  throw new Error(`Runtime endpoint cannot be referenced: ${endpoint.id}`);
}

function scopeEndpoint(scope: RuntimeScope): RuntimeEndpointRef | null {
  if ('endpoint' in scope) {
    return scope.endpoint;
  }
  if (scope.kind === 'session') {
    return scope.identity.endpoint;
  }
  return null;
}

function scopeBelongsToEndpoint(scope: RuntimeScope, endpoint: RuntimeEndpointProfile): boolean {
  const scopedEndpoint = scopeEndpoint(scope);
  return scopedEndpoint ? buildRuntimeEndpointKey(scopedEndpoint) === buildRuntimeEndpointKey(endpointRefForProfile(endpoint)) : false;
}

function summarizeRuntimeEndpoint(
  endpoint: RuntimeEndpointProfile,
  capabilities: CapabilityRegistry,
  controlState: RuntimeEndpointControlStateSummary,
): RuntimeEndpointSummary {
  const capabilitySummaries = capabilities.list()
    .filter((descriptor) => scopeBelongsToEndpoint(descriptor.scope, endpoint))
    .map((descriptor): RuntimeEndpointCapabilitySummary => ({
      id: descriptor.id,
      scopeKind: descriptor.scopeKind,
      scope: descriptor.scope,
      targetKinds: [...descriptor.targetKinds],
      operations: descriptor.operations.map((operation) => ({
        id: operation.id,
        targetKind: operation.targetKind,
        ...(operation.targetRequired === undefined ? {} : { targetRequired: operation.targetRequired }),
      })),
      availability: descriptor.availability,
    }));
  return {
    id: endpoint.id,
    protocolId: endpoint.protocolId,
    ...(endpoint.connectorId ? { connectorId: endpoint.connectorId } : {}),
    ...(endpoint.runtimeAdapterId ? { runtimeAdapterId: endpoint.runtimeAdapterId } : {}),
    ...(endpoint.runtimeInstanceId ? { runtimeInstanceId: endpoint.runtimeInstanceId } : {}),
    displayName: endpoint.displayName,
    agentIds: [...endpoint.agentIds],
    acceptsDynamicAgents: endpoint.acceptsDynamicAgents === true,
    capabilities: { ...endpoint.capabilities },
    capabilitySummaries,
    controlState,
  };
}

function toGatewayControlReadiness(readiness: RuntimeEndpointReadinessSummary): GatewayControlReadiness {
  return {
    ready: readiness.ready,
    phase: readiness.ready ? 'ready' : 'unavailable',
    requiredMethods: [],
    missingMethods: [],
    retryable: !readiness.ready,
    ...(readiness.error ? { error: readiness.error } : {}),
    ...(readiness.details !== undefined ? { details: readiness.details } : {}),
  };
}

class RuntimeEndpointControlStateStore {
  private readonly states = new Map<string, RuntimeEndpointControlStateSummary>();

  get(endpoint: RuntimeEndpointProfile): RuntimeEndpointControlStateSummary {
    return this.clone(this.states.get(this.buildEndpointKey(endpoint)) ?? this.empty());
  }

  update(
    endpoint: RuntimeEndpointProfile,
    patch: Partial<Pick<RuntimeEndpointControlStateSummary, 'connection' | 'readiness' | 'capabilities'>>,
    updatedAt: number,
  ): RuntimeEndpointControlStateSummary {
    const current = this.states.get(this.buildEndpointKey(endpoint)) ?? this.empty();
    const next = {
      connection: patch.connection !== undefined ? this.cloneConnection(patch.connection) : current.connection,
      readiness: patch.readiness !== undefined ? this.cloneReadiness(patch.readiness) : current.readiness,
      capabilities: patch.capabilities !== undefined ? this.cloneCapabilities(patch.capabilities) : current.capabilities,
      updatedAt,
    };
    this.states.set(this.buildEndpointKey(endpoint), next);
    return this.clone(next);
  }

  private empty(): RuntimeEndpointControlStateSummary {
    return {
      connection: null,
      readiness: null,
      capabilities: null,
      updatedAt: null,
    };
  }

  private clone(state: RuntimeEndpointControlStateSummary): RuntimeEndpointControlStateSummary {
    return {
      connection: this.cloneConnection(state.connection),
      readiness: this.cloneReadiness(state.readiness),
      capabilities: this.cloneCapabilities(state.capabilities),
      updatedAt: state.updatedAt,
    };
  }

  private cloneConnection(value: GatewayConnectionStatePayload | null): GatewayConnectionStatePayload | null {
    return value ? structuredClone(value) : null;
  }

  private cloneReadiness(value: GatewayControlReadiness | null): GatewayControlReadiness | null {
    return value ? structuredClone(value) : null;
  }

  private cloneCapabilities(value: GatewayCapabilitiesSnapshot | null): GatewayCapabilitiesSnapshot | null {
    return value ? structuredClone(value) : null;
  }

  remove(endpoint: RuntimeEndpointProfile): void {
    this.states.delete(this.buildEndpointKey(endpoint));
  }

  private buildEndpointKey(endpoint: RuntimeEndpointProfile): string {
    return buildRuntimeEndpointKey(endpointRefForProfile(endpoint));
  }
}

class RuntimeSessionContextStore {
  private readonly sessionContexts = new Map<string, RuntimeSessionContext>();

  remember(context: RuntimeSessionContext): RuntimeSessionContext {
    this.sessionContexts.set(buildSessionIdentityKey(context.identity), context);
    return context;
  }

  forget(identity: SessionIdentity): void {
    this.sessionContexts.delete(buildSessionIdentityKey(identity));
  }

  resolve(identity: SessionIdentity): RuntimeSessionContext {
    const cached = this.sessionContexts.get(buildSessionIdentityKey(identity));
    if (!cached) {
      throw new Error(`Runtime session context requires explicit session identity metadata: ${identity.sessionKey}`);
    }
    return cached;
  }
}

export interface AgentRuntimeNativePortsProvider {
  gateway(): GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>;
}

class RuntimeTransportRouter {
  constructor(
    private readonly adapters: RuntimeAdapterRegistry,
    private readonly connectors: RuntimeConnectorRegistry,
    private readonly endpoints: RuntimeEndpointCatalog,
    private readonly nativePorts: AgentRuntimeNativePortsProvider,
  ) {}

  resolve(context: RuntimeSessionContext): RuntimeSessionTransport {
    return this.resolveEndpoint(context.endpointRef, context.agentId);
  }

  resolveEndpoint(endpointRef: RuntimeEndpointRef, agentId: string): RuntimeSessionTransport {
    const endpoint = this.endpoints.getByRef(endpointRef);
    assertEndpointAgent(endpoint, agentId);
    if (endpointRef.kind === 'native-runtime') {
      const adapter = this.adapters.get(endpointRef.runtimeAdapterId);
      return adapter.createTransport(endpoint, { gateway: this.nativePorts.gateway() });
    }
    const connector = this.connectors.get(endpointRef.protocolId, endpointRef.connectorId);
    return connector.connect(endpoint);
  }
}

export class AgentRuntimeRegistry {
  private readonly protocols = new RuntimeProtocolRegistry();
  private readonly adapters = new RuntimeAdapterRegistry();
  private readonly connectors = new RuntimeConnectorRegistry();
  private readonly endpoints = new RuntimeEndpointCatalog();
  private readonly contexts = new RuntimeSessionContextStore();
  private readonly endpointControlStates = new RuntimeEndpointControlStateStore();
  private readonly capabilities = new CapabilityRegistry();
  private readonly transports: RuntimeTransportRouter;

  constructor(nativePorts: AgentRuntimeNativePortsProvider = {
    gateway: () => {
      throw new Error('Native runtime gateway port is required');
    },
  }) {
    this.transports = new RuntimeTransportRouter(this.adapters, this.connectors, this.endpoints, nativePorts);
  }

  registerRuntimeAdapter(adapter: RuntimeAdapter): void {
    this.protocols.register(adapter.protocol);
    this.adapters.register(adapter);
    for (const endpoint of adapter.endpoints) {
      this.endpoints.register({
        ...endpoint,
        runtimeAdapterId: adapter.runtimeAdapterId,
      }, this.protocols);
    }
    this.capabilities.registerMany(adapter.capabilities);
  }

  registerProtocolConnector(connector: RuntimeProtocolConnector): void {
    this.protocols.register(connector.protocol);
    this.connectors.register(connector);
  }

  register(registration: RuntimeEndpointRegistration): void {
    for (const adapter of registration.runtimeAdapters ?? []) {
      this.registerRuntimeAdapter(adapter);
    }
    for (const connector of registration.protocolConnectors ?? []) {
      this.registerProtocolConnector(connector);
    }
  }

  listProtocols(): RuntimeProtocolAdapter[] {
    return this.protocols.list();
  }

  listRuntimeAdapters(): RuntimeAdapter[] {
    return this.adapters.list();
  }

  listProtocolConnectors(): RuntimeProtocolConnector[] {
    return this.connectors.list();
  }

  listEndpoints(): RuntimeEndpointProfile[] {
    return this.endpoints.list();
  }

  listCapabilities(): CapabilityDescriptor[] {
    return this.capabilities.list();
  }

  snapshotTopology(): RuntimeTopologySnapshot {
    return {
      protocols: this.listProtocols().map((protocol): RuntimeProtocolSummary => ({
        protocolId: protocol.protocolId,
      })),
      adapters: this.listRuntimeAdapters().map((adapter): RuntimeAdapterSummary => ({
        runtimeAdapterId: adapter.runtimeAdapterId,
        protocolId: adapter.protocol.protocolId,
        endpointIds: adapter.endpoints.map((endpoint) => endpoint.id),
      })),
      connectors: this.listProtocolConnectors().map((connector): RuntimeConnectorSummary => ({
        protocolId: connector.protocol.protocolId,
        connectorId: connector.connectorId,
        endpointIds: connector.endpoints.map((endpoint) => endpoint.id),
      })),
      adapterInstances: this.listEndpoints()
        .filter((endpoint) => endpoint.runtimeAdapterId && endpoint.runtimeInstanceId)
        .map((endpoint): RuntimeAdapterInstanceSummary => ({
          runtimeAdapterId: endpoint.runtimeAdapterId!,
          runtimeInstanceId: endpoint.runtimeInstanceId!,
          endpointId: endpoint.id,
          agentIds: [...endpoint.agentIds],
        })),
      endpoints: this.listEndpoints().map((endpoint) => summarizeRuntimeEndpoint(
        endpoint,
        this.capabilities,
        this.endpointControlStates.get(endpoint),
      )),
    };
  }

  getCapability(descriptor: Pick<CapabilityDescriptor, 'id' | 'scope'>): CapabilityDescriptor {
    try {
      return this.capabilities.get(descriptor);
    } catch (error) {
      const dynamicDescriptor = this.buildDynamicCapability(descriptor);
      if (!dynamicDescriptor) {
        throw error;
      }
      return dynamicDescriptor;
    }
  }

  getProtocol(protocolId: RuntimeProtocolId): RuntimeProtocolAdapter {
    return this.protocols.get(protocolId);
  }

  getRuntimeAdapter(adapterId: RuntimeAdapterId): RuntimeAdapter {
    return this.adapters.get(adapterId);
  }

  getProtocolConnector(protocolId: RuntimeProtocolId, connectorId: RuntimeConnectorId): RuntimeProtocolConnector {
    return this.connectors.get(protocolId, connectorId);
  }

  getEndpoint(endpointId: RuntimeEndpointId): RuntimeEndpointProfile {
    return this.endpoints.get(endpointId);
  }

  resolveEndpointForRef(endpointRef: RuntimeEndpointRef, agentId?: string): RuntimeEndpointProfile {
    const endpoint = this.endpoints.getByRef(endpointRef);
    if (agentId) {
      assertEndpointAgent(endpoint, agentId);
    }
    return endpoint;
  }

  updateRuntimeEndpointControlState(input: {
    readonly endpoint: RuntimeEndpointRef;
    readonly connection?: GatewayConnectionStatePayload | null;
    readonly readiness?: GatewayControlReadiness | null;
    readonly capabilities?: GatewayCapabilitiesSnapshot | null;
    readonly updatedAt: number;
  }): RuntimeEndpointControlStateSummary {
    const endpoint = this.resolveEndpointForRef(input.endpoint);
    return this.endpointControlStates.update(endpoint, input, input.updatedAt);
  }

  rememberSessionIdentity(identity: SessionIdentity): RuntimeSessionContext {
    const endpoint = this.resolveEndpointForRef(identity.endpoint, identity.agentId);
    return this.contexts.remember(createRuntimeSessionContext({
      identity,
      protocolId: endpoint.protocolId,
      runtimeEndpointId: endpoint.id,
      endpointSessionId: identity.sessionKey,
    }));
  }

  resolveApprovalNotificationsForEndpoint(endpointRef: RuntimeEndpointRef): RuntimeApprovalNotificationAdapter | null {
    this.resolveEndpointForRef(endpointRef);
    if (endpointRef.kind === 'native-runtime') {
      return this.adapters.get(endpointRef.runtimeAdapterId).approvalNotifications ?? null;
    }
    return this.connectors.get(endpointRef.protocolId, endpointRef.connectorId).approvalNotifications ?? null;
  }

  resolveTransport(context: RuntimeSessionContext): RuntimeSessionTransport {
    return this.transports.resolve(context);
  }

  resolveTransportForEndpoint(endpointRef: RuntimeEndpointRef, agentId: string): RuntimeSessionTransport {
    return this.transports.resolveEndpoint(endpointRef, agentId);
  }

  async connectRuntimeEndpoint(input: { protocolId: RuntimeProtocolId; connectorId: RuntimeConnectorId; endpointId: RuntimeEndpointId }): Promise<RuntimeEndpointReadinessSummary> {
    const connector = this.connectors.get(input.protocolId, input.connectorId);
    const endpointTemplate = resolveConnectorEndpointProfile(connector, input.endpointId);
    const transport = connector.connect(endpointTemplate);
    const discovery = await transport.discoverEndpoint?.();
    const connectedEndpoint = applyEndpointDiscovery(endpointTemplate, discovery ?? null);
    const readiness = await connector.inspectEndpointReadiness?.(input.endpointId) ?? { ready: true, phase: 'connected' };
    if (!readiness.ready) {
      connector.disconnect?.(input.endpointId);
      this.unregisterConnectorRuntimeEndpoint(input);
      return readiness;
    }
    this.registerConnectorRuntimeEndpoint(input, connectedEndpoint, readiness);
    return readiness;
  }

  disconnectRuntimeEndpoint(input: { protocolId: RuntimeProtocolId; connectorId: RuntimeConnectorId; endpointId: RuntimeEndpointId }): RuntimeEndpointReadinessSummary {
    const connector = this.connectors.get(input.protocolId, input.connectorId);
    resolveConnectorEndpointProfile(connector, input.endpointId);
    connector.disconnect?.(input.endpointId);
    this.unregisterConnectorRuntimeEndpoint(input);
    return { ready: false, phase: 'disconnected' };
  }

  private registerConnectorRuntimeEndpoint(
    input: { protocolId: RuntimeProtocolId; connectorId: RuntimeConnectorId; endpointId: RuntimeEndpointId },
    endpoint: RuntimeEndpointProfile,
    readiness: RuntimeEndpointReadinessSummary,
  ): void {
    this.unregisterConnectorRuntimeEndpoint(input);
    this.endpoints.register(endpoint, this.protocols);
    const endpointRef = connectorEndpointRef(input);
    const descriptors: CapabilityDescriptor[] = [
      ...buildRuntimeEndpointCapabilityDescriptors({
        endpoint,
        endpointRef,
        scope: runtimeInstanceScope(endpointRef),
        supportLevel: 'native',
        ownerModuleId: input.connectorId,
        routeOwnerId: 'sessions',
      }),
    ];
    for (const agentId of endpoint.agentIds) {
      descriptors.push(...buildRuntimeEndpointCapabilityDescriptors({
        endpoint,
        endpointRef,
        agentId,
        supportLevel: 'native',
        ownerModuleId: input.connectorId,
        routeOwnerId: 'sessions',
      }));
    }
    this.capabilities.replaceForRuntimeEndpointScope(runtimeInstanceScope(endpointRef), descriptors);
    this.endpointControlStates.update(endpoint, {
      readiness: toGatewayControlReadiness(readiness),
    }, Date.now());
  }

  private unregisterConnectorRuntimeEndpoint(input: { protocolId: RuntimeProtocolId; connectorId: RuntimeConnectorId; endpointId: RuntimeEndpointId }): void {
    const removed = this.endpoints.unregisterConnectorEndpoint(input.protocolId, input.connectorId, input.endpointId);
    this.capabilities.removeForRuntimeEndpointScope(runtimeInstanceScope(connectorEndpointRef(input)));
    if (removed) {
      this.endpointControlStates.remove(removed);
    }
  }

  rememberSessionContext(context: RuntimeSessionContext): RuntimeSessionContext {
    return this.contexts.remember(context);
  }

  forgetSessionContext(identity: SessionIdentity): void {
    this.contexts.forget(identity);
  }

  resolveSessionContext(identity: SessionIdentity): RuntimeSessionContext {
    return this.contexts.resolve(identity);
  }

  resolveProtocolForSession(identity: SessionIdentity): RuntimeProtocolAdapter {
    const context = this.resolveSessionContext(identity);
    return this.getProtocol(context.protocolId);
  }

  resolveEndpointForSession(identity: SessionIdentity): RuntimeEndpointProfile {
    const context = this.resolveSessionContext(identity);
    return this.getEndpoint(context.runtimeEndpointId);
  }

  private buildDynamicCapability(descriptor: Pick<CapabilityDescriptor, 'id' | 'scope'>): CapabilityDescriptor | null {
    const endpointRef = scopeEndpoint(descriptor.scope);
    if (!endpointRef) {
      return null;
    }
    if (descriptor.scope.kind === 'team-run') {
      const runtimeDescriptor = this.capabilities.get({
        id: descriptor.id,
        scope: runtimeInstanceScope(endpointRef),
      });
      return {
        ...runtimeDescriptor,
        scopeKind: descriptor.scope.kind,
        scope: descriptor.scope,
      };
    }
    const endpoint = this.resolveEndpointForRef(endpointRef, descriptor.scope.kind === 'agent' ? descriptor.scope.agentId : undefined);
    if (descriptor.scope.kind === 'agent' && !endpoint.acceptsDynamicAgents) {
      return null;
    }
    const dynamicDescriptors = buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      endpointRef,
      scope: descriptor.scope.kind === 'session' ? sessionScope(descriptor.scope.identity) : descriptor.scope,
      supportLevel: 'native',
      ownerModuleId: endpoint.runtimeAdapterId ?? endpoint.connectorId ?? endpoint.protocolId,
      routeOwnerId: 'sessions',
    });
    return dynamicDescriptors.find((candidate) => candidate.id === descriptor.id) ?? null;
  }
}

import { createRuntimeSessionContext } from './runtime-session-context';
import { buildRuntimeEndpointCapabilityDescriptors } from './runtime-capability-descriptors';
import { buildRuntimeAddressKey, type RuntimeAddress } from './runtime-address';
import { SESSION_PROMPT_CAPABILITY_ID } from '../../capabilities/session/session-prompt-capability';
import type { RuntimeSessionIdentity } from './runtime-identity-contract';
import { CapabilityRegistry } from '../../capabilities/contracts/capability-registry';
import type { CapabilityDescriptor } from '../../capabilities/contracts/capability-descriptor';
import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../../gateway/gateway-runtime-port';
import type { RuntimeAdapterInstanceSummary, RuntimeAdapterSummary, RuntimeConnectorSummary, RuntimeEndpointControlStateSummary, RuntimeEndpointReadinessSummary, RuntimeEndpointSummary, RuntimeProtocolSummary, RuntimeTopologySnapshot } from '../../../shared/runtime-topology';
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

function connectorScopeAddress(input: {
  protocolId: RuntimeProtocolId;
  connectorId: RuntimeConnectorId;
  endpointId: RuntimeEndpointId;
}): RuntimeAddress {
  return {
    kind: 'protocol-connector',
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    protocolId: input.protocolId,
    connectorId: input.connectorId,
    endpointId: input.endpointId,
    agentId: 'runtime-endpoint-scope',
  };
}

function summarizeRuntimeEndpoint(
  endpoint: RuntimeEndpointProfile,
  capabilities: CapabilityRegistry,
  controlState: RuntimeEndpointControlStateSummary,
): RuntimeEndpointSummary {
  const capabilityAddresses = capabilities.list()
    .filter((descriptor) => {
      if (descriptor.address.kind === 'native-runtime') {
        return descriptor.address.runtimeAdapterId === endpoint.runtimeAdapterId
          && descriptor.address.runtimeInstanceId === endpoint.runtimeInstanceId
          && endpoint.agentIds.includes(descriptor.address.agentId);
      }
      return descriptor.address.protocolId === endpoint.protocolId
        && descriptor.address.connectorId === endpoint.connectorId
        && descriptor.address.endpointId === endpoint.id
        && endpoint.agentIds.includes(descriptor.address.agentId);
    })
    .map((descriptor) => descriptor.address);
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
    capabilityAddresses,
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
    if (endpoint.runtimeAdapterId) {
      return `native:${endpoint.runtimeAdapterId}:${endpoint.runtimeInstanceId ?? ''}`;
    }
    if (endpoint.connectorId) {
      return `connector:${endpoint.protocolId}:${endpoint.connectorId}:${endpoint.id}`;
    }
    return `protocol:${endpoint.protocolId}:${endpoint.id}`;
  }
}

class RuntimeSessionContextStore {
  private readonly sessionContexts = new Map<string, RuntimeSessionContext>();

  remember(context: RuntimeSessionContext): RuntimeSessionContext {
    this.sessionContexts.set(this.buildSessionContextKey(context.sessionKey, context.address), context);
    return context;
  }

  forget(sessionKey: string): void {
    for (const [key, context] of this.sessionContexts.entries()) {
      if (context.sessionKey === sessionKey) {
        this.sessionContexts.delete(key);
      }
    }
  }

  resolve(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeSessionContext {
    if (metadata?.address) {
      const address = { ...metadata.address, sessionKey };
      const cached = this.sessionContexts.get(this.buildSessionContextKey(sessionKey, address));
      if (cached) {
        return cached;
      }
    } else if (!metadata) {
      const cached = this.resolveUniqueSessionContext(sessionKey);
      if (cached) {
        return cached;
      }
    }
    if (metadata?.runtimeEndpointId && metadata.protocolId && metadata.address) {
      return this.remember(createRuntimeSessionContext({
        sessionKey,
        protocolId: metadata.protocolId,
        runtimeEndpointId: metadata.runtimeEndpointId,
        ...(metadata.endpointSessionId ? { endpointSessionId: metadata.endpointSessionId } : {}),
        ...(metadata.agentId ? { agentId: metadata.agentId } : {}),
        address: {
          ...metadata.address,
          sessionKey,
        },
      }));
    }
    throw new Error(`Runtime session context requires explicit runtime address metadata: ${sessionKey}`);
  }

  private resolveUniqueSessionContext(sessionKey: string): RuntimeSessionContext | null {
    const matches = Array.from(this.sessionContexts.values()).filter((context) => context.sessionKey === sessionKey);
    if (matches.length > 1) {
      throw new Error(`Runtime session context requires explicit runtime address metadata: ${sessionKey}`);
    }
    return matches[0] ?? null;
  }

  private buildSessionContextKey(sessionKey: string, address: RuntimeAddress): string {
    return `${buildRuntimeAddressKey(address)}::${sessionKey}`;
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
    return this.resolveAddress(context.address);
  }

  resolveAddress(address: RuntimeAddress): RuntimeSessionTransport {
    if (address.kind === 'native-runtime') {
      const adapter = this.adapters.get(address.runtimeAdapterId);
      const endpoint = this.endpoints.getNative(address.runtimeAdapterId, address.runtimeInstanceId);
      assertEndpointAgent(endpoint, address.agentId);
      return adapter.createTransport(endpoint, { gateway: this.nativePorts.gateway() });
    }
    const connector = this.connectors.get(address.protocolId, address.connectorId);
    const endpoint = this.endpoints.getConnector(address.protocolId, address.connectorId, address.endpointId);
    assertEndpointAgent(endpoint, address.agentId);
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

  getCapability(descriptor: Pick<CapabilityDescriptor, 'id' | 'address'>): CapabilityDescriptor {
    try {
      return this.capabilities.get(descriptor);
    } catch (error) {
      const endpoint = this.resolveEndpointForAddress(descriptor.address);
      if (!endpoint.acceptsDynamicAgents) {
        throw error;
      }
      const dynamicDescriptor = buildRuntimeEndpointCapabilityDescriptors({
        endpoint,
        supportLevel: 'native',
        address: descriptor.address,
        ownerModuleId: descriptor.address.kind === 'native-runtime' ? descriptor.address.runtimeAdapterId : descriptor.address.connectorId,
        routeOwnerId: 'sessions',
      }).find((candidate) => candidate.id === descriptor.id);
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

  resolveEndpointForAddress(address: RuntimeAddress): RuntimeEndpointProfile {
    const endpoint = address.kind === 'native-runtime'
      ? this.endpoints.getNative(address.runtimeAdapterId, address.runtimeInstanceId)
      : this.endpoints.getConnector(address.protocolId, address.connectorId, address.endpointId);
    assertEndpointAgent(endpoint, address.agentId);
    return endpoint;
  }

  updateRuntimeEndpointControlState(input: {
    readonly address: RuntimeAddress;
    readonly connection?: GatewayConnectionStatePayload | null;
    readonly readiness?: GatewayControlReadiness | null;
    readonly capabilities?: GatewayCapabilitiesSnapshot | null;
    readonly updatedAt: number;
  }): RuntimeEndpointControlStateSummary {
    const endpoint = this.resolveEndpointForAddress(input.address);
    return this.endpointControlStates.update(endpoint, input, input.updatedAt);
  }

  resolveSessionIdentityForAddress(address: RuntimeAddress): RuntimeSessionIdentity {
    const endpoint = this.resolveEndpointForAddress(address);
    return {
      protocolId: endpoint.protocolId,
      runtimeEndpointId: endpoint.id,
    };
  }

  rememberSessionAddress(sessionKey: string, address: RuntimeAddress): RuntimeSessionContext {
    const endpoint = this.resolveEndpointForAddress(address);
    return this.contexts.resolve(sessionKey, {
      protocolId: endpoint.protocolId,
      runtimeEndpointId: endpoint.id,
      endpointSessionId: sessionKey,
      agentId: address.agentId,
      address: {
        ...address,
        sessionKey,
      },
    });
  }

  resolveApprovalNotificationsForAddress(address: RuntimeAddress): RuntimeApprovalNotificationAdapter | null {
    this.resolveEndpointForAddress(address);
    if (address.kind === 'native-runtime') {
      return this.adapters.get(address.runtimeAdapterId).approvalNotifications ?? null;
    }
    return this.connectors.get(address.protocolId, address.connectorId).approvalNotifications ?? null;
  }

  resolveTransport(context: RuntimeSessionContext): RuntimeSessionTransport {
    return this.transports.resolve(context);
  }

  resolveTransportForAddress(address: RuntimeAddress): RuntimeSessionTransport {
    return this.transports.resolveAddress(address);
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
    const scopeAddress = connectorScopeAddress(input);
    this.capabilities.replaceForRuntimeEndpointScope(scopeAddress, endpoint.agentIds.flatMap((agentId) => buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      supportLevel: 'native',
      address: {
        ...scopeAddress,
        agentId,
      },
      ownerModuleId: input.connectorId,
      routeOwnerId: 'sessions',
    })));
    this.endpointControlStates.update(endpoint, {
      readiness: toGatewayControlReadiness(readiness),
    }, Date.now());
  }

  private unregisterConnectorRuntimeEndpoint(input: { protocolId: RuntimeProtocolId; connectorId: RuntimeConnectorId; endpointId: RuntimeEndpointId }): void {
    const removed = this.endpoints.unregisterConnectorEndpoint(input.protocolId, input.connectorId, input.endpointId);
    const scopeAddress = connectorScopeAddress(input);
    this.capabilities.removeForRuntimeEndpointScope(scopeAddress);
    if (removed) {
      this.endpointControlStates.remove(removed);
    }
  }

  rememberSessionContext(context: RuntimeSessionContext): RuntimeSessionContext {
    return this.contexts.remember(context);
  }

  forgetSessionContext(sessionKey: string): void {
    this.contexts.forget(sessionKey);
  }

  resolveSessionContext(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeSessionContext {
    return this.contexts.resolve(sessionKey, metadata);
  }

  resolveProtocolForSession(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeProtocolAdapter {
    const context = this.resolveSessionContext(sessionKey, metadata);
    return this.getProtocol(context.protocolId);
  }

  resolveEndpointForSession(sessionKey: string, metadata?: Partial<RuntimeSessionContext> | null): RuntimeEndpointProfile {
    const context = this.resolveSessionContext(sessionKey, metadata);
    return this.getEndpoint(context.runtimeEndpointId);
  }
}

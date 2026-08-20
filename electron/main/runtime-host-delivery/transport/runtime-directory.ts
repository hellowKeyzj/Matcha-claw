import type {
  RuntimeAdapterInstanceSummary,
  RuntimeAdapterSummary,
  RuntimeConnectorSummary,
  RuntimeEndpointSummary,
} from '../../../../src/types/runtime-topology';
import type { RuntimeHostDeliveryIssuer } from '../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Runtime endpoint directory is unavailable',
} as const;
const LEGACY_CONNECTOR_REJECTION = {
  success: false,
  error: 'Legacy runtime connector lifecycle route is disabled; use /api/capabilities/execute with a runtime-endpoint target',
} as const;
const PLATFORM_TOOLS_UNAVAILABLE = {
  success: false,
  error: 'Platform tools catalog is unavailable',
} as const;
const RUNTIME_ENDPOINT_DIRECTORY_PATH = '/api/runtime-endpoints/list';
const PLATFORM_TOOLS_PATH = '/api/platform/tools';

export type RuntimeEndpointDirectoryResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ endpoints: readonly RuntimeEndpointSummary[] }> | typeof UNAVAILABLE;
}>;

export type RuntimeTopologyProjectionResponse = Readonly<{
  status: 200 | 503;
  body:
    | Readonly<{ adapters: readonly RuntimeAdapterSummary[] }>
    | Readonly<{ instances: readonly RuntimeAdapterInstanceSummary[] }>
    | Readonly<{ connectors: readonly RuntimeConnectorSummary[] }>
    | typeof UNAVAILABLE;
}>;

export type RuntimeConnectorLifecycleResponse = Readonly<{
  status: 400;
  body: typeof LEGACY_CONNECTOR_REJECTION;
}>;

export type PlatformToolSummary = Readonly<{
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  description?: string;
  version?: string;
}>;

export type PlatformToolsResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ success: true; tools: readonly PlatformToolSummary[] }> | typeof PLATFORM_TOOLS_UNAVAILABLE;
}>;

export interface RuntimeEndpointDirectoryTransport {
  list(): Promise<RuntimeEndpointDirectoryResponse>;
  listAdapters(): Promise<RuntimeTopologyProjectionResponse>;
  listAdapterInstances(): Promise<RuntimeTopologyProjectionResponse>;
  listConnectors(): Promise<RuntimeTopologyProjectionResponse>;
  rejectLegacyConnectorLifecycle(): Promise<RuntimeConnectorLifecycleResponse>;
  listPlatformTools(): Promise<PlatformToolsResponse>;
}

export function createRuntimeEndpointDirectoryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  sessionTransportPort: number,
  fetcher: typeof fetch = fetch,
): RuntimeEndpointDirectoryTransport {
  const directoryUrl = `http://127.0.0.1:${sessionTransportPort}${RUNTIME_ENDPOINT_DIRECTORY_PATH}`;
  const platformToolsUrl = `http://127.0.0.1:${sessionTransportPort}${PLATFORM_TOOLS_PATH}`;
  return {
    async list(): Promise<RuntimeEndpointDirectoryResponse> {
      try {
        const response = await fetcher(directoryUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: RUNTIME_ENDPOINT_DIRECTORY_PATH,
              scope: 'runtime:endpoints:read',
              capability: 'runtime.endpoints.directory',
              subject: 'runtime-endpoint-directory',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Length': '0',
          },
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isResponse(body)) {
          return { status: 200, body };
        }
      } catch {
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },

    async listAdapters(): Promise<RuntimeTopologyProjectionResponse> {
      const directory = await this.list();
      if (directory.status !== 200) return directory;
      return { status: 200, body: { adapters: adaptersFromEndpoints(directory.body.endpoints) } };
    },

    async listAdapterInstances(): Promise<RuntimeTopologyProjectionResponse> {
      const directory = await this.list();
      if (directory.status !== 200) return directory;
      return { status: 200, body: { instances: adapterInstancesFromEndpoints(directory.body.endpoints) } };
    },

    async listConnectors(): Promise<RuntimeTopologyProjectionResponse> {
      const directory = await this.list();
      if (directory.status !== 200) return directory;
      return { status: 200, body: { connectors: [] } };
    },

    async rejectLegacyConnectorLifecycle(): Promise<RuntimeConnectorLifecycleResponse> {
      return { status: 400, body: LEGACY_CONNECTOR_REJECTION };
    },

    async listPlatformTools(): Promise<PlatformToolsResponse> {
      try {
        const response = await fetcher(platformToolsUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: PLATFORM_TOOLS_PATH,
              scope: 'platform:tools:read',
              capability: 'platform.tools.list',
              subject: 'platform-tools',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Length': '0',
          },
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isPlatformToolsResponse(body)) {
          return { status: 200, body };
        }
      } catch {
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: PLATFORM_TOOLS_UNAVAILABLE };
    },
  };
}

function isPlatformToolsResponse(value: unknown): value is Readonly<{ success: true; tools: readonly PlatformToolSummary[] }> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'tools'])
    && value.success === true
    && Array.isArray(value.tools)
    && value.tools.every(isPlatformTool);
}

function isPlatformTool(value: unknown): value is PlatformToolSummary {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!['id', 'name', 'source', 'enabled', 'description', 'version'].every((key) => keys.includes(key) || key === 'description' || key === 'version')) {
    return false;
  }
  return keys.every((key) => ['id', 'name', 'source', 'enabled', 'description', 'version'].includes(key))
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.name === 'string'
    && typeof value.source === 'string'
    && typeof value.enabled === 'boolean'
    && (value.description === undefined || typeof value.description === 'string')
    && (value.version === undefined || typeof value.version === 'string');
}

function isResponse(value: unknown): value is Readonly<{ endpoints: readonly RuntimeEndpointSummary[] }> {
  if (!isRecord(value)
    || !hasExactKeys(value, ['endpoints'])
    || !Array.isArray(value.endpoints)
    || value.endpoints.length !== 2
    || !value.endpoints.every(isEndpoint)) {
    return false;
  }
  return value.endpoints[0].id === 'openclaw-local'
    && value.endpoints[1].id === 'matcha-agent-local';
}

function adaptersFromEndpoints(endpoints: readonly RuntimeEndpointSummary[]): readonly RuntimeAdapterSummary[] {
  return endpoints.map((endpoint) => {
    const runtimeAdapterId = endpoint.runtimeAdapterId ?? '';
    return {
      runtimeAdapterId,
      protocolId: endpoint.protocolId,
      endpointIds: [endpoint.id],
    };
  });
}

function adapterInstancesFromEndpoints(endpoints: readonly RuntimeEndpointSummary[]): readonly RuntimeAdapterInstanceSummary[] {
  return endpoints.map((endpoint) => ({
    runtimeAdapterId: endpoint.runtimeAdapterId ?? '',
    runtimeInstanceId: endpoint.runtimeInstanceId ?? '',
    endpointId: endpoint.id,
    endpointRef: endpoint.endpointRef,
    source: endpoint.source,
    location: endpoint.location,
    lifecycle: endpoint.lifecycle,
    agentIds: [...endpoint.agentIds],
    defaultAgentId: endpoint.defaultAgentId,
  }));
}

type FixedEndpointIdentity = Readonly<{
  protocolId: string;
  runtimeAdapterId: string;
  agentId: string;
  displayName: string;
}>;

function isEndpoint(value: unknown): value is RuntimeEndpointSummary {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'protocolId', 'runtimeAdapterId', 'runtimeInstanceId', 'endpointRef', 'source', 'location',
    'lifecycle', 'displayName', 'agentIds', 'defaultAgentId', 'agents', 'acceptsDynamicAgents',
    'capabilities', 'capabilityFamilies', 'controlState',
  ])) {
    return false;
  }
  const identity = fixedEndpointIdentity(value);
  return identity !== undefined
    && isFixedEndpointIdentity(value, identity)
    && value.displayName === identity.displayName
    && isLocation(value.location)
    && isLifecycle(value.lifecycle)
    && isFixedAgentIds(value.agentIds, identity.agentId)
    && value.defaultAgentId === identity.agentId
    && isFixedAgents(value.agents, identity, value.lifecycle)
    && value.acceptsDynamicAgents === true
    && isSupportedCapabilities(value.capabilities)
    && isFixedCapabilityFamilies(value.capabilityFamilies, identity)
    && isControlState(value.controlState, value.lifecycle);
}

function fixedEndpointIdentity(value: Record<string, unknown>): FixedEndpointIdentity | undefined {
  if (value.id === 'openclaw-local') {
    return {
      protocolId: 'openclaw-v4',
      runtimeAdapterId: 'openclaw',
      agentId: 'main',
      displayName: 'OpenClaw',
    };
  }
  if (value.id === 'matcha-agent-local') {
    return {
      protocolId: 'matcha-agent-app-server',
      runtimeAdapterId: 'matcha-agent',
      agentId: 'matcha',
      displayName: 'Matcha Agent',
    };
  }
  return undefined;
}

function isFixedEndpointIdentity(value: Record<string, unknown>, identity: FixedEndpointIdentity): boolean {
  return value.protocolId === identity.protocolId
    && value.runtimeAdapterId === identity.runtimeAdapterId
    && value.runtimeInstanceId === 'local'
    && isNativeEndpoint(value.endpointRef, identity.runtimeAdapterId)
    && isSource(value.source, identity.runtimeAdapterId);
}

function isNativeEndpoint(value: unknown, runtimeAdapterId: string): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === runtimeAdapterId
    && value.runtimeInstanceId === 'local';
}

function isSource(value: unknown, runtimeAdapterId: string): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'runtime-adapter'
    && value.runtimeAdapterId === runtimeAdapterId
    && value.runtimeInstanceId === 'local';
}

function isLocation(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind'])
    && value.kind === 'local';
}

function isLifecycle(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['phase', 'connected', 'ready', 'updatedAt'])) {
    return false;
  }
  if (value.updatedAt !== null) return false;
  if (value.phase === 'ready') return value.connected === true && value.ready === true;
  return ['declared', 'connecting', 'unavailable', 'disconnected'].includes(String(value.phase))
    && value.connected === false
    && value.ready === false;
}

function isFixedAgentIds(value: unknown, agentId: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === agentId;
}

function isFixedAgents(value: unknown, identity: FixedEndpointIdentity, lifecycle: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return false;
  const agent = value[0];
  const source = isRecord(lifecycle) && lifecycle.phase === 'ready' ? 'discovered' : 'declared';
  return hasExactKeys(agent, ['agentId', 'source', 'capabilities'])
    && agent.agentId === identity.agentId
    && agent.source === source
    && isSupportedCapabilities(agent.capabilities);
}

function isSupportedCapabilities(value: unknown): boolean {
  return isCapabilities(value)
    && ['chat', 'streaming', 'tools', 'approvals', 'replay', 'modelSelection']
      .every((key) => (value as Record<string, unknown>)[key] === true);
}

function isCapabilities(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['chat', 'streaming', 'tools', 'approvals', 'replay', 'modelSelection'])
    && ['chat', 'streaming', 'tools', 'approvals', 'replay', 'modelSelection']
      .every((key) => typeof value[key] === 'boolean');
}

function isFixedCapabilityFamilies(value: unknown, identity: FixedEndpointIdentity): boolean {
  const supportedFamilies = identity.runtimeAdapterId === 'openclaw'
    ? ['session', 'task', 'subagent', 'team', 'cron', 'workspace', 'skill', 'channel', 'lifecycle']
    : ['session', 'team', 'lifecycle'];
  const expected = ['session', 'task', 'subagent', 'team', 'cron', 'workspace', 'skill', 'channel', 'lifecycle'];
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((family, index) => isRecord(value[index])
      && hasExactKeys(value[index], ['family', 'availability'])
      && value[index].family === family
      && value[index].availability === (supportedFamilies.includes(family) ? 'supported' : 'unsupported'));
}

function isControlState(value: unknown, lifecycle: unknown): boolean {
  if (!isRecord(value)
    || !hasExactKeys(value, ['connection', 'readiness', 'capabilities', 'updatedAt'])
    || value.connection !== null
    || value.capabilities !== null
    || value.updatedAt !== null) {
    return false;
  }
  const phase = isRecord(lifecycle) ? lifecycle.phase : undefined;
  if (phase === 'declared') return value.readiness === null;
  const readiness = phase === 'ready'
    ? { ready: true, phase: 'ready' }
    : phase === 'connecting'
      ? { ready: false, phase: 'starting' }
      : ['unavailable', 'disconnected'].includes(String(phase))
        ? { ready: false, phase: 'unavailable' }
        : undefined;
  return readiness !== undefined
    && isRecord(value.readiness)
    && hasExactKeys(value.readiness, ['ready', 'phase'])
    && value.readiness.ready === readiness.ready
    && value.readiness.phase === readiness.phase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

import { create } from 'zustand';
import { selectManagementEndpoint, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { buildCapabilityScopeKey, runtimeEndpointsEqual, runtimeScopeQuery, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';
import { hostApiFetch } from '@/lib/host-api';
import { probeConnector, readConnectorStatuses, removeConnector, updateConnector, upsertConnector } from './services/client';
import type {
  ExternalConnectorSummary,
  OpenClawMcpServerSummary,
  ExternalMcpServerProgramDescriptor,
  ExternalConnectorSpec,
  ExternalConnectorMutationPayload,
  ExternalConnectorPatch,
  ExternalConnectorRemoveMutationReceipt,
} from './types';
import type { ExternalConnectorConnectionStatus } from '@/types/connectors-observation';

export type { ExternalConnectorConnectionStatus, ExternalConnectorConnectionStatusResultType } from '@/types/connectors-observation';

type ExternalConnectorListPayload = {
  connectors: ExternalConnectorSummary[];
};

type OpenClawMcpServerListPayload = {
  servers: OpenClawMcpServerSummary[];
};

type ExternalMcpServerProgramCatalogPayload = {
  programs: ExternalMcpServerProgramDescriptor[];
};

type ExternalConnectorsState = {
  scope: RuntimeInstanceScope | null;
  selectScope: (scope: RuntimeInstanceScope | null) => void;
  connectors: ExternalConnectorSummary[];
  connectorStatuses: Record<string, ExternalConnectorConnectionStatus>;
  mcpServers: OpenClawMcpServerSummary[];
  mcpServerPrograms: ExternalMcpServerProgramDescriptor[];
  ready: boolean;
  loading: boolean;
  mutatingId: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  probe: (connectorId: string) => Promise<ExternalConnectorConnectionStatus>;
  upsert: (connector: ExternalConnectorSpec) => Promise<ExternalConnectorMutationPayload>;
  update: (connectorId: string, patch: ExternalConnectorPatch) => Promise<ExternalConnectorMutationPayload>;
  remove: (connectorId: string) => Promise<ExternalConnectorRemoveMutationReceipt>;
  clearError: () => void;
};

function toConnectorStatusMap(statuses: ExternalConnectorConnectionStatus[]): Record<string, ExternalConnectorConnectionStatus> {
  return Object.fromEntries(statuses.map((status) => [status.connectorId, status]));
}

async function readOpenClawMcpServers(scope: RuntimeInstanceScope): Promise<OpenClawMcpServerSummary[]> {
  const payload = await hostApiFetch<OpenClawMcpServerListPayload>(`/api/openclaw/mcp-servers?${runtimeScopeQuery(scope)}`);
  return Array.isArray(payload.servers) ? payload.servers : [];
}

const externalConnectorsStore = create<ExternalConnectorsState>((set, get) => {
  let scopeRevision = 0;
  const current = (scope: RuntimeInstanceScope, revision: number) => {
    const endpoint = selectManagementEndpoint(useRuntimeEndpointsStore.getState());
    return revision === scopeRevision && endpoint !== null && runtimeEndpointsEqual(endpoint, scope.endpoint);
  };
  let refreshPromise: Promise<void> | null = null;
  let refreshChanges: {
    connectors: Set<string>;
    statuses: Set<string>;
    errorInvalidated: boolean;
  } | null = null;
  let latestMcpServersReadId = 0;
  let latestMutationMcpServersReadId = 0;
  let latestMcpServersCommitId = 0;
  const pendingOperations = new Map<symbol, string>();
  const connectorRevisions = new Map<string, number>();
  const latestStatusOperations = new Map<string, symbol>();

  function invalidateRefreshError(): void {
    if (refreshChanges) refreshChanges.errorInvalidated = true;
  }

  function acceptConnectorRevision(connectorId: string, revision: number | undefined): boolean {
    if (revision === undefined || revision < (connectorRevisions.get(connectorId) ?? 0)) return false;
    connectorRevisions.set(connectorId, revision);
    return true;
  }

  function beginOperation(connectorId: string): symbol {
    const operation = Symbol();
    pendingOperations.set(operation, connectorId);
    latestStatusOperations.set(connectorId, operation);
    set({ mutatingId: connectorId, error: null });
    return operation;
  }

  function finishOperation(connectorId: string, operation: symbol): void {
    pendingOperations.delete(operation);
    if (latestStatusOperations.get(connectorId) === operation) {
      latestStatusOperations.delete(connectorId);
    }
    set({ mutatingId: [...pendingOperations.values()].at(-1) ?? null });
  }

  async function refreshMutationMcpServers(scope: RuntimeInstanceScope, revision: number, mcpServersReadId: number): Promise<void> {
    const canPublish = () => current(scope, revision)
      && mcpServersReadId === latestMutationMcpServersReadId && mcpServersReadId > latestMcpServersCommitId;
    try {
      const mcpServers = await readOpenClawMcpServers(scope);
      if (!canPublish()) return;
      latestMcpServersCommitId = mcpServersReadId;
      set({ mcpServers });
    } catch (error) {
      if (canPublish()) set({
        error: `连接器变更已确认，但 MCP 清单刷新失败：${error instanceof Error ? error.message : '读取失败'}。请点击刷新读取最新清单，勿重复提交变更。`,
      });
    }
  }

  async function saveConnector(connectorId: string, save: () => Promise<ExternalConnectorMutationPayload>): Promise<ExternalConnectorMutationPayload> {
    const scope = get().scope;
    const revision = scopeRevision;
    if (!scope || !current(scope, revision)) throw new Error('请选择运行时');
    const operation = beginOperation(connectorId);
    try {
      const result = await save();
      if (!current(scope, revision)) return result;
      const mcpServersReadId = ++latestMcpServersReadId;
      latestMutationMcpServersReadId = mcpServersReadId;
      invalidateRefreshError();
      if (acceptConnectorRevision(connectorId, result.desired.revision)) {
        refreshChanges?.connectors.add(connectorId);
        refreshChanges?.statuses.add(connectorId);
        latestStatusOperations.set(connectorId, operation);
        set((state) => ({
          connectors: [...state.connectors.filter((item) => item.id !== result.connector.id), result.connector]
            .sort((a, b) => a.id.localeCompare(b.id)),
          connectorStatuses: {
            ...state.connectorStatuses,
            [result.connector.id]: {
              connectorId: result.connector.id,
              resultType: 'unknown',
              safeProbe: false,
            },
          },
        }));
      }
      await refreshMutationMcpServers(scope, revision, mcpServersReadId);
      return result;
    } catch (error) {
      if (current(scope, revision)) set({ error: error instanceof Error ? error.message : '保存连接器失败' });
      throw error;
    } finally {
      if (current(scope, revision)) finishOperation(connectorId, operation);
    }
  }

  return ({
  scope: null,
  selectScope: (scope) => {
    if ((scope ? buildCapabilityScopeKey(scope) : null) === (get().scope ? buildCapabilityScopeKey(get().scope!) : null)) return;
    scopeRevision += 1;
    refreshPromise = null;
    refreshChanges = null;
    pendingOperations.clear();
    connectorRevisions.clear();
    latestStatusOperations.clear();
    set({ scope, connectors: [], connectorStatuses: {}, mcpServers: [], mcpServerPrograms: [], ready: false, loading: false, mutatingId: null, error: null });
  },
  connectors: [],
  connectorStatuses: {},
  mcpServers: [],
  mcpServerPrograms: [],
  ready: false,
  loading: false,
  mutatingId: null,
  error: null,

  refresh: () => {
    const scope = get().scope;
    const revision = scopeRevision;
    if (!scope || !current(scope, revision)) return Promise.resolve();
    if (refreshPromise) return refreshPromise;
    const mcpServersReadId = ++latestMcpServersReadId;
    const changes = { connectors: new Set<string>(), statuses: new Set<string>(), errorInvalidated: false };
    refreshChanges = changes;
    latestStatusOperations.clear();
    set({ loading: true, error: null });
    refreshPromise = (async () => {
      try {
        const [payload, catalog, statuses, mcpServers] = await Promise.all([
          hostApiFetch<ExternalConnectorListPayload>('/api/external-connectors'),
          hostApiFetch<ExternalMcpServerProgramCatalogPayload>('/api/external-connectors/mcp-server-programs'),
          readConnectorStatuses(scope),
          readOpenClawMcpServers(scope),
        ]);
        if (!current(scope, revision)) return;
        const publishMcpServers = mcpServersReadId > latestMcpServersCommitId;
        if (publishMcpServers) latestMcpServersCommitId = mcpServersReadId;
        set((state) => {
          const changedConnectors = state.connectors.filter((connector) => changes.connectors.has(connector.id));
          const changedConnectorIds = new Set(changedConnectors.map((connector) => connector.id));
          const connectors = Array.isArray(payload.connectors) ? payload.connectors : [];
          return {
            connectors: changes.connectors.size === 0 ? connectors : [
              ...connectors.filter((connector) => !changes.connectors.has(connector.id)),
              ...changedConnectors,
            ].sort((a, b) => a.id.localeCompare(b.id)),
            connectorStatuses: {
              ...toConnectorStatusMap(statuses.filter((status) => !changes.statuses.has(status.connectorId))),
              ...Object.fromEntries(Object.entries(state.connectorStatuses).filter(([id]) => changes.statuses.has(id))),
            },
            ...(publishMcpServers ? { mcpServers: [
              ...mcpServers.filter((server) => !server.connectorId || !changes.connectors.has(server.connectorId)),
              ...state.mcpServers.filter((server) => server.connectorId && changedConnectorIds.has(server.connectorId)),
            ].sort((a, b) => a.serverId.localeCompare(b.serverId)) } : {}),
            mcpServerPrograms: Array.isArray(catalog.programs) ? catalog.programs : [],
            ready: true,
            loading: false,
          };
        });
      } catch (error) {
        if (!current(scope, revision)) return;
        set({
          loading: false,
          ...(!changes.errorInvalidated ? { error: error instanceof Error ? error.message : '加载连接器失败' } : {}),
        });
        throw error;
      } finally {
        if (revision === scopeRevision) {
          refreshPromise = null;
          refreshChanges = null;
        }
      }
    })();
    return refreshPromise;
  },

  probe: async (connectorId) => {
    const scope = get().scope;
    const revision = scopeRevision;
    if (!scope || !current(scope, revision)) throw new Error('请选择运行时');
    const operation = beginOperation(connectorId);
    try {
      const status = await probeConnector(scope, connectorId);
      if (current(scope, revision) && latestStatusOperations.get(connectorId) === operation) {
        invalidateRefreshError();
        refreshChanges?.statuses.add(connectorId);
        set((state) => ({
          connectorStatuses: {
            ...state.connectorStatuses,
            [status.connectorId]: status,
          },
        }));
      }
      return status;
    } catch (error) {
      if (current(scope, revision)) set({ error: error instanceof Error ? error.message : '检测连接器失败' });
      throw error;
    } finally {
      if (current(scope, revision)) finishOperation(connectorId, operation);
    }
  },

  upsert: (connector) => saveConnector(connector.id, () => upsertConnector(connector)),
  update: (connectorId, patch) => saveConnector(connectorId, () => updateConnector(connectorId, patch)),

  remove: async (connectorId) => {
    const scope = get().scope;
    const revision = scopeRevision;
    if (!scope || !current(scope, revision)) throw new Error('请选择运行时');
    const operation = beginOperation(connectorId);
    try {
      const result = await removeConnector(connectorId);
      if (!current(scope, revision)) return result;
      const mcpServersReadId = ++latestMcpServersReadId;
      latestMutationMcpServersReadId = mcpServersReadId;
      invalidateRefreshError();
      if (acceptConnectorRevision(connectorId, result.desired.revision)) {
        refreshChanges?.connectors.add(connectorId);
        refreshChanges?.statuses.add(connectorId);
        latestStatusOperations.set(connectorId, operation);
        set((state) => {
          const { [connectorId]: _removedStatus, ...connectorStatuses } = state.connectorStatuses;
          return {
            connectors: state.connectors.filter((connector) => connector.id !== connectorId),
            connectorStatuses,
          };
        });
      }
      await refreshMutationMcpServers(scope, revision, mcpServersReadId);
      return result;
    } catch (error) {
      if (current(scope, revision)) set({ error: error instanceof Error ? error.message : '删除连接器失败' });
      throw error;
    } finally {
      if (current(scope, revision)) finishOperation(connectorId, operation);
    }
  },

  clearError: () => set((state) => (state.error ? { ...state, error: null } : state)),
  });
});

export function useExternalConnectorsStore<T>(selector: (state: Readonly<ExternalConnectorsState>) => T): T {
  return externalConnectorsStore(selector);
}

export function selectExternalConnectorScope(scope: RuntimeInstanceScope | null): void {
  externalConnectorsStore.getState().selectScope(scope);
}

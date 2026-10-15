import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { probeConnector, readConnectorStatuses, removeConnector, upsertConnector } from '@/lib/connectors-call';
import type { ExternalConnectorConnectionStatus } from '@/types/connectors-observation';

export type { ExternalConnectorConnectionStatus, ExternalConnectorConnectionStatusResultType } from '@/types/connectors-observation';

export type ExternalConnectorKind = 'mcp-stdio' | 'mcp-http' | 'cli' | 'sdk' | 'http';

export type OpenClawMcpServerKind = 'mcp-stdio' | 'mcp-http' | 'unknown';
export type OpenClawMcpServerSource = 'preset' | 'external' | 'openclaw';

export interface OpenClawMcpServerSummary {
  readonly serverId: string;
  readonly connectorId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly kind: OpenClawMcpServerKind;
  readonly source: OpenClawMcpServerSource;
  readonly enabled: boolean;
  readonly managed: boolean;
  readonly editable: boolean;
  readonly removable: boolean;
}

export type ExternalMcpServerProgramSource = 'system-runtime' | 'external-command' | 'external-url' | 'bundled-plugin' | 'bundled-mcp-app' | 'managed-local';

export interface ExternalMcpServerProgramRef {
  readonly source: ExternalMcpServerProgramSource;
  readonly programId?: string;
}

export interface ExternalMcpServerProgramDescriptor {
  readonly id: string;
  readonly source: ExternalMcpServerProgramSource;
  readonly displayName: string;
  readonly rootPath?: string;
  readonly manifestPath?: string;
  readonly entrypointPath?: string;
  readonly connectorKinds: readonly Extract<ExternalConnectorKind, 'mcp-stdio' | 'mcp-http'>[];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly transport?: 'streamable-http' | 'sse';
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface ExternalConnectorSecretRef {
  readonly kind: 'secret-ref';
  readonly ref: string;
}

export interface ExternalConnectorBaseSpec {
  readonly id: string;
  readonly kind: ExternalConnectorKind;
  readonly displayName?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly workspaceId?: string;
  readonly sourceId?: string;
  readonly mcpServerProgram?: ExternalMcpServerProgramRef;
  readonly tags?: readonly string[];
}

export interface ExternalConnectorProcessSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'mcp-stdio' | 'cli';
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly secretEnv?: Record<string, ExternalConnectorSecretRef>;
}

export interface ExternalConnectorMcpHttpSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'mcp-http';
  readonly url: string;
  readonly transport?: 'streamable-http' | 'sse';
  readonly headers?: Record<string, string>;
  readonly secretHeaders?: Record<string, ExternalConnectorSecretRef>;
  readonly connectionTimeoutMs?: number;
}

export interface ExternalConnectorHttpSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'http';
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  readonly secretHeaders?: Record<string, ExternalConnectorSecretRef>;
}

export interface ExternalConnectorSdkSpec extends ExternalConnectorBaseSpec {
  readonly kind: 'sdk';
  readonly provider: string;
  readonly packageName?: string;
  readonly config?: Record<string, unknown>;
  readonly secretConfigRefs?: Record<string, ExternalConnectorSecretRef>;
}

export type ExternalConnectorSpec =
  | ExternalConnectorProcessSpec
  | ExternalConnectorMcpHttpSpec
  | ExternalConnectorHttpSpec
  | ExternalConnectorSdkSpec;

type ExternalConnectorListPayload = {
  connectors: ExternalConnectorSpec[];
};

type OpenClawMcpServerListPayload = {
  servers: OpenClawMcpServerSummary[];
};

type ExternalMcpServerProgramCatalogPayload = {
  programs: ExternalMcpServerProgramDescriptor[];
};

export type ExternalConnectorMutationDesiredStatus = 'stored' | 'removed';

export interface ExternalConnectorMutationDesired {
  readonly status: ExternalConnectorMutationDesiredStatus;
  readonly revision?: number;
}

export type ExternalConnectorMutationApplied =
  | {
      readonly status: 'written';
      readonly changed: boolean;
    }
  | {
      readonly status: 'unknown' | 'unavailable';
      readonly changed?: never;
    };

export interface ExternalConnectorMutationObserved {
  readonly status: 'not-observed';
}

export interface ExternalConnectorUpsertMutationReceipt {
  readonly success: true;
  readonly connector: ExternalConnectorSpec;
  readonly resultType: 'created' | 'updated';
  readonly desired: ExternalConnectorMutationDesired & { readonly status: 'stored' };
  readonly applied: ExternalConnectorMutationApplied;
  readonly observed: ExternalConnectorMutationObserved;
}

export interface ExternalConnectorRemoveMutationReceipt {
  readonly success: true;
  readonly connector?: never;
  readonly desired: ExternalConnectorMutationDesired & { readonly status: 'removed' };
  readonly applied: ExternalConnectorMutationApplied;
  readonly observed: ExternalConnectorMutationObserved;
}

export type ExternalConnectorMutationReceipt =
  | ExternalConnectorUpsertMutationReceipt
  | ExternalConnectorRemoveMutationReceipt;

export type ExternalConnectorMutationPayload = ExternalConnectorUpsertMutationReceipt;

type ExternalConnectorsState = {
  connectors: ExternalConnectorSpec[];
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
  remove: (connectorId: string) => Promise<void>;
  clearError: () => void;
};

function toConnectorStatusMap(statuses: ExternalConnectorConnectionStatus[]): Record<string, ExternalConnectorConnectionStatus> {
  return Object.fromEntries(statuses.map((status) => [status.connectorId, status]));
}

async function readOpenClawMcpServers(): Promise<OpenClawMcpServerSummary[]> {
  const payload = await hostApiFetch<OpenClawMcpServerListPayload>('/api/openclaw/mcp-servers');
  return Array.isArray(payload.servers) ? payload.servers : [];
}

export const useExternalConnectorsStore = create<ExternalConnectorsState>((set) => {
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

  return ({
  connectors: [],
  connectorStatuses: {},
  mcpServers: [],
  mcpServerPrograms: [],
  ready: false,
  loading: false,
  mutatingId: null,
  error: null,

  refresh: () => {
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
          readConnectorStatuses(),
          readOpenClawMcpServers(),
        ]);
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
        set({
          loading: false,
          ...(!changes.errorInvalidated ? { error: error instanceof Error ? error.message : '加载连接器失败' } : {}),
        });
        throw error;
      } finally {
        refreshPromise = null;
        refreshChanges = null;
      }
    })();
    return refreshPromise;
  },

  probe: async (connectorId) => {
    const operation = beginOperation(connectorId);
    try {
      const status = await probeConnector(connectorId);
      if (latestStatusOperations.get(connectorId) === operation) {
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
      set({ error: error instanceof Error ? error.message : '检测连接器失败' });
      throw error;
    } finally {
      finishOperation(connectorId, operation);
    }
  },

  upsert: async (connector) => {
    const operation = beginOperation(connector.id);
    try {
      const result = await upsertConnector(connector);
      const mcpServersReadId = ++latestMcpServersReadId;
      latestMutationMcpServersReadId = mcpServersReadId;
      invalidateRefreshError();
      if (acceptConnectorRevision(connector.id, result.desired.revision)) {
        refreshChanges?.connectors.add(connector.id);
        refreshChanges?.statuses.add(connector.id);
        latestStatusOperations.set(connector.id, operation);
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
      const mcpServers = await readOpenClawMcpServers();
      if (mcpServersReadId === latestMutationMcpServersReadId && mcpServersReadId > latestMcpServersCommitId) {
        latestMcpServersCommitId = mcpServersReadId;
        set({ mcpServers });
      }
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '保存连接器失败' });
      throw error;
    } finally {
      finishOperation(connector.id, operation);
    }
  },

  remove: async (connectorId) => {
    const operation = beginOperation(connectorId);
    try {
      const result = await removeConnector(connectorId);
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
      const mcpServers = await readOpenClawMcpServers();
      if (mcpServersReadId === latestMutationMcpServersReadId && mcpServersReadId > latestMcpServersCommitId) {
        latestMcpServersCommitId = mcpServersReadId;
        set({ mcpServers });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '删除连接器失败' });
      throw error;
    } finally {
      finishOperation(connectorId, operation);
    }
  },

  clearError: () => set((state) => (state.error ? { ...state, error: null } : state)),
  });
});

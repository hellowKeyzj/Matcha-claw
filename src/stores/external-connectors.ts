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

export const useExternalConnectorsStore = create<ExternalConnectorsState>((set, get) => ({
  connectors: [],
  connectorStatuses: {},
  mcpServers: [],
  mcpServerPrograms: [],
  ready: false,
  loading: false,
  mutatingId: null,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [payload, catalog, statuses, mcpServers] = await Promise.all([
        hostApiFetch<ExternalConnectorListPayload>('/api/external-connectors'),
        hostApiFetch<ExternalMcpServerProgramCatalogPayload>('/api/external-connectors/mcp-server-programs'),
        readConnectorStatuses(),
        readOpenClawMcpServers(),
      ]);
      set({
        connectors: Array.isArray(payload.connectors) ? payload.connectors : [],
        connectorStatuses: toConnectorStatusMap(statuses),
        mcpServers,
        mcpServerPrograms: Array.isArray(catalog.programs) ? catalog.programs : [],
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '加载连接器失败',
      });
      throw error;
    }
  },

  probe: async (connectorId) => {
    set({ mutatingId: connectorId, error: null });
    try {
      const status = await probeConnector(connectorId);
      set((state) => ({
        connectorStatuses: {
          ...state.connectorStatuses,
          [status.connectorId]: status,
        },
      }));
      return status;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '检测连接器失败' });
      throw error;
    } finally {
      set((state) => ({ mutatingId: state.mutatingId === connectorId ? null : state.mutatingId }));
    }
  },

  upsert: async (connector) => {
    set({ mutatingId: connector.id, error: null });
    try {
      const result = await upsertConnector(connector);
      const mcpServers = await readOpenClawMcpServers();
      const connectors = get().connectors.filter((item) => item.id !== result.connector.id);
      set((state) => ({
        connectors: [...connectors, result.connector].sort((a, b) => a.id.localeCompare(b.id)),
        connectorStatuses: {
          ...state.connectorStatuses,
          [result.connector.id]: {
            connectorId: result.connector.id,
            resultType: 'unknown',
            safeProbe: false,
          },
        },
        mcpServers,
        ready: true,
      }));
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '保存连接器失败' });
      throw error;
    } finally {
      set((state) => ({ mutatingId: state.mutatingId === connector.id ? null : state.mutatingId }));
    }
  },

  remove: async (connectorId) => {
    set({ mutatingId: connectorId, error: null });
    try {
      await removeConnector(connectorId);
      const mcpServers = await readOpenClawMcpServers();
      set((state) => {
        const { [connectorId]: _removedStatus, ...connectorStatuses } = state.connectorStatuses;
        return {
          connectors: state.connectors.filter((connector) => connector.id !== connectorId),
          connectorStatuses,
          mcpServers,
        };
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : '删除连接器失败' });
      throw error;
    } finally {
      set((state) => ({ mutatingId: state.mutatingId === connectorId ? null : state.mutatingId }));
    }
  },

  clearError: () => set((state) => (state.error ? { ...state, error: null } : state)),
}));

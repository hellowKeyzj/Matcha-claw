import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';

export type ExternalConnectorKind = 'mcp-stdio' | 'mcp-http' | 'cli' | 'sdk' | 'http';

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

export type ExternalConnectorConnectionStatusResultType = 'connected' | 'disconnected' | 'unsupported' | 'disabled' | 'unknown';

export interface ExternalConnectorConnectionStatus {
  readonly connectorId: string;
  readonly resultType: ExternalConnectorConnectionStatusResultType;
  readonly checkedAt?: string;
  readonly latencyMs?: number;
  readonly reason?: string;
  readonly safeProbe: boolean;
}

type ExternalConnectorListPayload = {
  connectors: ExternalConnectorSpec[];
};

type ExternalMcpServerProgramCatalogPayload = {
  programs: ExternalMcpServerProgramDescriptor[];
};

type ExternalConnectorConnectionStatusListPayload = {
  statuses: ExternalConnectorConnectionStatus[];
};

type ExternalConnectorConnectionStatusPayload = {
  status: ExternalConnectorConnectionStatus;
};

type ExternalConnectorMutationPayload = {
  success: true;
  connector: ExternalConnectorSpec;
  resultType?: 'created' | 'updated';
  downstreamSyncResults?: unknown[];
};

type ExternalConnectorsState = {
  connectors: ExternalConnectorSpec[];
  connectorStatuses: Record<string, ExternalConnectorConnectionStatus>;
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

async function externalConnectorPost<TResult>(path: string, body: Record<string, unknown>): Promise<TResult> {
  return await hostApiFetch<TResult>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function toConnectorStatusMap(statuses: ExternalConnectorConnectionStatus[]): Record<string, ExternalConnectorConnectionStatus> {
  return Object.fromEntries(statuses.map((status) => [status.connectorId, status]));
}

export const useExternalConnectorsStore = create<ExternalConnectorsState>((set, get) => ({
  connectors: [],
  connectorStatuses: {},
  mcpServerPrograms: [],
  ready: false,
  loading: false,
  mutatingId: null,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [payload, catalog, statusPayload] = await Promise.all([
        hostApiFetch<ExternalConnectorListPayload>('/api/external-connectors'),
        hostApiFetch<ExternalMcpServerProgramCatalogPayload>('/api/external-connectors/mcp-server-programs'),
        hostApiFetch<ExternalConnectorConnectionStatusListPayload>('/api/external-connectors/status'),
      ]);
      set({
        connectors: Array.isArray(payload.connectors) ? payload.connectors : [],
        connectorStatuses: toConnectorStatusMap(Array.isArray(statusPayload.statuses) ? statusPayload.statuses : []),
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
      const result = await externalConnectorPost<ExternalConnectorConnectionStatusPayload>('/api/external-connectors/probe', { connectorId });
      set((state) => ({
        connectorStatuses: {
          ...state.connectorStatuses,
          [result.status.connectorId]: result.status,
        },
      }));
      return result.status;
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
      const result = await externalConnectorPost<ExternalConnectorMutationPayload>('/api/external-connectors/upsert', { connector });
      const connectors = get().connectors.filter((item) => item.id !== result.connector.id);
      set((state) => ({
        connectors: [...connectors, result.connector].sort((a, b) => a.id.localeCompare(b.id)),
        connectorStatuses: {
          ...state.connectorStatuses,
          [result.connector.id]: {
            connectorId: result.connector.id,
            resultType: 'unknown',
            reason: 'connector changed and has not been probed',
            safeProbe: false,
          },
        },
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
      await externalConnectorPost<ExternalConnectorMutationPayload>('/api/external-connectors/remove', { connectorId });
      set((state) => {
        const { [connectorId]: _removedStatus, ...connectorStatuses } = state.connectorStatuses;
        return {
          connectors: state.connectors.filter((connector) => connector.id !== connectorId),
          connectorStatuses,
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

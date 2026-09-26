import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '../types/desktop/runtime-address';

export type SessionConnectorStatusResultType =
  | 'connected'
  | 'disconnected'
  | 'pending'
  | 'unsupported'
  | 'disabled'
  | 'unknown'
  | 'error';

export interface SessionConnectorStatusDetails {
  readonly serverId?: string;
  readonly sessionKey?: string;
  readonly toolCount?: number;
  readonly launchSummary?: string;
  readonly enabledNextRun?: boolean;
  readonly enabledConfigurable?: boolean;
}

export interface SessionConnectorStatus {
  readonly connectorId: string;
  readonly displayName?: string;
  readonly adapterId: string;
  readonly targetKind: 'session';
  readonly resultType: SessionConnectorStatusResultType;
  readonly checkedAt?: string;
  readonly reason?: string;
  readonly details?: SessionConnectorStatusDetails;
}

type SessionConnectorStatusPayload = {
  statuses: SessionConnectorStatus[];
};

type SessionConnectorStatusState = {
  statusesBySessionKey: Record<string, SessionConnectorStatus[]>;
  loadingBySessionKey: Record<string, boolean>;
  errorBySessionKey: Record<string, string | null>;
  refreshSessionStatus: (sessionIdentity: SessionIdentity) => Promise<SessionConnectorStatus[]>;
  setSessionMcpServerEnabled: (sessionIdentity: SessionIdentity, serverId: string, enabled: boolean) => Promise<void>;
  clearSessionStatus: (sessionIdentity: SessionIdentity) => void;
};

export const useSessionConnectorStatusStore = create<SessionConnectorStatusState>((set) => ({
  statusesBySessionKey: {},
  loadingBySessionKey: {},
  errorBySessionKey: {},

  refreshSessionStatus: async (sessionIdentity) => {
    const key = buildSessionIdentityKey(sessionIdentity);
    set((state) => ({
      loadingBySessionKey: { ...state.loadingBySessionKey, [key]: true },
      errorBySessionKey: { ...state.errorBySessionKey, [key]: null },
    }));
    try {
      const payload = await hostApiFetch<SessionConnectorStatusPayload>('/api/external-connectors/session-status', {
        method: 'POST',
        body: JSON.stringify({ sessionIdentity }),
      });
      const statuses = Array.isArray(payload.statuses) ? payload.statuses : [];
      set((state) => ({
        statusesBySessionKey: { ...state.statusesBySessionKey, [key]: statuses },
        loadingBySessionKey: { ...state.loadingBySessionKey, [key]: false },
      }));
      return statuses;
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载会话连接器状态失败';
      set((state) => ({
        loadingBySessionKey: { ...state.loadingBySessionKey, [key]: false },
        errorBySessionKey: { ...state.errorBySessionKey, [key]: message },
      }));
      throw error;
    }
  },

  setSessionMcpServerEnabled: async (sessionIdentity, serverId, enabled) => {
    const key = buildSessionIdentityKey(sessionIdentity);
    set((state) => ({
      errorBySessionKey: { ...state.errorBySessionKey, [key]: null },
    }));
    try {
      await hostApiFetch('/api/external-connectors/session-mcp-server-enabled', {
        method: 'POST',
        body: JSON.stringify({ sessionIdentity, serverId, enabled }),
      });
      set((state) => ({
        statusesBySessionKey: {
          ...state.statusesBySessionKey,
          [key]: (state.statusesBySessionKey[key] ?? []).map((status) => (
            status.details?.serverId === serverId
              ? {
                ...status,
                reason: enabled ? '已启用' : '已禁用',
                details: { ...status.details, enabledNextRun: enabled },
              }
              : status
          )),
        },
      }));
      await useSessionConnectorStatusStore.getState().refreshSessionStatus(sessionIdentity);
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新会话 MCP 状态失败';
      set((state) => ({
        errorBySessionKey: { ...state.errorBySessionKey, [key]: message },
      }));
      throw error;
    }
  },

  clearSessionStatus: (sessionIdentity) => {
    const key = buildSessionIdentityKey(sessionIdentity);
    set((state) => {
      const { [key]: _removedStatuses, ...statusesBySessionKey } = state.statusesBySessionKey;
      const { [key]: _removedLoading, ...loadingBySessionKey } = state.loadingBySessionKey;
      const { [key]: _removedError, ...errorBySessionKey } = state.errorBySessionKey;
      return { statusesBySessionKey, loadingBySessionKey, errorBySessionKey };
    });
  },
}));

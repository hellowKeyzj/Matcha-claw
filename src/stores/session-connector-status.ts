import { create } from 'zustand';
import { readSessionConnectorStatuses, setSessionMcpServerEnabled } from '@/lib/connectors-call';
import type { SessionConnectorStatus, SessionConnectorStatusResultType as ConnectorResultType } from '@/types/connectors-observation';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '../types/desktop/runtime-address';

export type { SessionConnectorStatus, SessionConnectorStatusDetails } from '@/types/connectors-observation';
export type SessionConnectorStatusResultType = ConnectorResultType | 'error';

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
      const statuses = await readSessionConnectorStatuses(sessionIdentity);
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
      await setSessionMcpServerEnabled(sessionIdentity, serverId, enabled);
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

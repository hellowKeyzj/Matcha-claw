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

export const useSessionConnectorStatusStore = create<SessionConnectorStatusState>((set) => {
  const observations = new Map<string, symbol>();
  const mutations = new Map<string, {
    pending: Set<symbol>;
    latestByServer: Map<string, symbol>;
  }>();

  function invalidateObservation(key: string): void {
    observations.delete(key);
    set((state) => ({ loadingBySessionKey: { ...state.loadingBySessionKey, [key]: false } }));
  }

  return ({
  statusesBySessionKey: {},
  loadingBySessionKey: {},
  errorBySessionKey: {},

  refreshSessionStatus: async (sessionIdentity) => {
    const key = buildSessionIdentityKey(sessionIdentity);
    const observation = Symbol();
    observations.set(key, observation);
    set((state) => ({
      loadingBySessionKey: { ...state.loadingBySessionKey, [key]: true },
      errorBySessionKey: { ...state.errorBySessionKey, [key]: null },
    }));
    try {
      const statuses = await readSessionConnectorStatuses(sessionIdentity);
      if (observations.get(key) === observation) set((state) => ({
        statusesBySessionKey: { ...state.statusesBySessionKey, [key]: statuses },
        loadingBySessionKey: { ...state.loadingBySessionKey, [key]: false },
      }));
      return statuses;
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载会话连接器状态失败';
      if (observations.get(key) === observation) set((state) => ({
        loadingBySessionKey: { ...state.loadingBySessionKey, [key]: false },
        errorBySessionKey: { ...state.errorBySessionKey, [key]: message },
      }));
      throw error;
    } finally {
      if (observations.get(key) === observation) observations.delete(key);
    }
  },

  setSessionMcpServerEnabled: async (sessionIdentity, serverId, enabled) => {
    const key = buildSessionIdentityKey(sessionIdentity);
    const sessionMutations = mutations.get(key) ?? {
      pending: new Set<symbol>(),
      latestByServer: new Map<string, symbol>(),
    };
    const mutation = Symbol();
    sessionMutations.pending.add(mutation);
    sessionMutations.latestByServer.set(serverId, mutation);
    mutations.set(key, sessionMutations);
    set((state) => ({
      errorBySessionKey: { ...state.errorBySessionKey, [key]: null },
    }));
    try {
      try {
        await setSessionMcpServerEnabled(sessionIdentity, serverId, enabled);
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新会话 MCP 状态失败';
        if (mutations.get(key) === sessionMutations) {
          set((state) => ({
            errorBySessionKey: { ...state.errorBySessionKey, [key]: message },
          }));
        }
        throw error;
      }
      if (mutations.get(key) !== sessionMutations) return;
      invalidateObservation(key);
      if (sessionMutations.latestByServer.get(serverId) === mutation) set((state) => ({
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
    } finally {
      sessionMutations.pending.delete(mutation);
      if (mutations.get(key) === sessionMutations && sessionMutations.pending.size === 0) mutations.delete(key);
    }
  },

  clearSessionStatus: (sessionIdentity) => {
    const key = buildSessionIdentityKey(sessionIdentity);
    observations.delete(key);
    mutations.delete(key);
    set((state) => {
      const { [key]: _removedStatuses, ...statusesBySessionKey } = state.statusesBySessionKey;
      const { [key]: _removedLoading, ...loadingBySessionKey } = state.loadingBySessionKey;
      const { [key]: _removedError, ...errorBySessionKey } = state.errorBySessionKey;
      return { statusesBySessionKey, loadingBySessionKey, errorBySessionKey };
    });
  },
  });
});

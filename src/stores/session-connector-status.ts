import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { buildSessionIdentityKey, type SessionIdentity } from '../../runtime-host/shared/runtime-address';

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
  readonly refreshJobId?: string;
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

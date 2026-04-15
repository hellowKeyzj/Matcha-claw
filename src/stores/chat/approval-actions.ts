import { useGatewayStore } from '../gateway';
import {
  normalizeApprovalDecision,
  normalizeApprovalTimestampMs,
  parseGatewayApprovalResponse,
  resolveApprovalSessionKey,
} from './approval-helpers';
import {
  buildApprovalRequestedPatch,
  buildApprovalResolvedPatch,
  buildSyncPendingApprovalsPatch,
  groupApprovalsBySession,
} from './approval-handlers';
import type {
  ApprovalDecision,
  ApprovalItem,
  ChatStoreState,
} from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreApprovalActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  beginMutating: () => void;
  finishMutating: () => void;
}

type StoreApprovalActions = Pick<
  ChatStoreState,
  'syncPendingApprovals' | 'handleApprovalRequested' | 'handleApprovalResolved' | 'resolveApproval'
>;

function isStaleApprovalResolveError(message: string): boolean {
  return /not found|expired|already resolved|unknown approval|invalid approval/i.test(message);
}

export function createStoreApprovalActions(input: CreateStoreApprovalActionsInput): StoreApprovalActions {
  const { set, get, beginMutating, finishMutating } = input;

  return {
    syncPendingApprovals: async (sessionKeyHint?: string) => {
      try {
        const payload = await useGatewayStore.getState().rpc<unknown>('exec.approvals.get', {});
        const parsed = parseGatewayApprovalResponse(payload);
        if (!parsed.recognized) return;

        const grouped = groupApprovalsBySession(parsed.items);
        set((state) => buildSyncPendingApprovalsPatch({
          state,
          grouped,
          sessionKeyHint,
        }));
      } catch {
        // ignore
      }
    },

    handleApprovalRequested: (payload: Record<string, unknown>) => {
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      const sessionKey = resolveApprovalSessionKey(payload);
      if (!id || !sessionKey) return;

      const runId = typeof payload.runId === 'string' ? payload.runId.trim() : undefined;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : undefined;
      const createdAtMs = normalizeApprovalTimestampMs(payload.createdAt)
        ?? normalizeApprovalTimestampMs(payload.requestedAt)
        ?? Date.now();
      const expiresAtMs = normalizeApprovalTimestampMs(payload.expiresAt);

      const nextItem: ApprovalItem = {
        id,
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(toolName ? { toolName } : {}),
        createdAtMs,
        ...(expiresAtMs ? { expiresAtMs } : {}),
      };

      set((state) => buildApprovalRequestedPatch({
        state,
        approval: nextItem,
      }));
    },

    handleApprovalResolved: (payload: Record<string, unknown>) => {
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      if (!id) return;

      set((state) => {
        const patch = buildApprovalResolvedPatch({
          state,
          id,
          resolvedSessionKey: resolveApprovalSessionKey(payload) ?? undefined,
          decision: normalizeApprovalDecision(payload.decision),
        });
        return patch ?? state;
      });
    },

    resolveApproval: async (id: string, decision: ApprovalDecision) => {
      const approvalId = id.trim();
      if (!approvalId) return;
      beginMutating();
      try {
        await useGatewayStore.getState().rpc(
          'exec.approval.resolve',
          { id: approvalId, decision },
        );
        get().handleApprovalResolved({
          id: approvalId,
          decision,
          sessionKey: get().currentSessionKey,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStaleApprovalResolveError(message)) {
          get().handleApprovalResolved({
            id: approvalId,
            decision: 'deny',
            sessionKey: get().currentSessionKey,
          });
        }
        set({ error: message });
        await get().syncPendingApprovals(get().currentSessionKey);
      } finally {
        finishMutating();
      }
    },
  };
}


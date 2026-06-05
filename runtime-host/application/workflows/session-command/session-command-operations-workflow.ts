import type {
  SessionLoadResult,
  SessionNewResult,
  SessionWindowResult,
} from '../../../shared/session-adapter-types';
import {
  readAbortSessionRequest,
  readCreateSessionRequest,
  readPatchSessionRequest,
  readRenameSessionRequest,
  readResolveApprovalRequest,
  readRuntimeAddressRequest,
  readSessionListRequest,
  readSessionLoadRequest,
  readSessionStatusRequest,
  readSessionWindowRequest,
} from '../../sessions/session-runtime-requests';
import { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import {
  badRequest,
  ok,
  type ApplicationResponseOf,
} from '../../common/application-response';
import type {
  SessionHydratingLoadResult,
  SessionHydratingWindowResult,
  SessionHydrationWorkflow,
} from '../session-hydration/session-hydration-workflow';
import type { SessionApprovalWorkflow } from '../session-approval/session-approval-workflow';
import type { SessionLifecycleWorkflow } from '../session-lifecycle/session-lifecycle-workflow';
import type { SessionModelSelectionWorkflow } from '../session-model-selection/session-model-selection-workflow';

export interface SessionCommandOperationsWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  sessionLifecycleWorkflow: SessionLifecycleWorkflow;
  sessionHydrationWorkflow: SessionHydrationWorkflow;
  sessionApprovalWorkflow: SessionApprovalWorkflow;
  sessionModelSelectionWorkflow: SessionModelSelectionWorkflow;
}

export class SessionCommandOperationsWorkflow {
  constructor(private readonly deps: SessionCommandOperationsWorkflowDeps) {}

  async createSession(payload: unknown): Promise<ApplicationResponseOf<SessionNewResult>> {
    const {
      explicitSessionKey,
      runtimeAddress,
      runtimeAddressError,
    } = readCreateSessionRequest(payload);
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    return await this.deps.sessionLifecycleWorkflow.create({
      explicitSessionKey,
      runtimeAddress,
    });
  }

  async deleteSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, runtimeAddress, runtimeAddressError } = readRuntimeAddressRequest(payload);
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    return await this.deps.sessionLifecycleWorkflow.delete({ sessionKey, runtimeAddress });
  }

  async archiveSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.updateSessionStatus(payload, 'archived');
  }

  async unarchiveSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.updateSessionStatus(payload, 'completed');
  }

  async updateSessionStatus(
    payload: unknown,
    forcedStatus?: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<ApplicationResponseOf> {
    const {
      sessionKey,
      runtimeAddress,
      runtimeAddressError,
      status: requestedStatus,
    } = readSessionStatusRequest(payload);
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    const status = forcedStatus ?? requestedStatus;
    if (!status) {
      return badRequest('status is required');
    }
    return await this.deps.sessionLifecycleWorkflow.updateStatus({ sessionKey, runtimeAddress, status });
  }

  async listSessions(payload: unknown) {
    const { runtimeAddress, runtimeAddressError } = readSessionListRequest(payload);
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    return await this.deps.sessionLifecycleWorkflow.list({ runtimeAddress });
  }

  async loadSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const {
      sessionKey,
      limit,
      runtimeAddress,
      runtimeAddressError,
    } = readSessionLoadRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    return this.deps.sessionHydrationWorkflow.load({
      sessionKey,
      runtimeAddress,
      limit,
    });
  }

  async resumeSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const {
      sessionKey,
      runtimeAddress,
      runtimeAddressError,
    } = readSessionLoadRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    return this.deps.sessionHydrationWorkflow.resume({
      sessionKey,
      runtimeAddress,
    });
  }

  async patchSession(payload: unknown): Promise<ApplicationResponseOf> {
    const {
      sessionKey,
      runtimeAddress,
      runtimeAddressError,
      runtimeModelRef,
    } = readPatchSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    if (!runtimeModelRef) {
      return badRequest('runtimeModelRef is required');
    }
    return await this.deps.sessionModelSelectionWorkflow.patch({
      sessionKey,
      runtimeAddress,
      runtimeModelRef,
    });
  }

  async renameSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, runtimeAddress, runtimeAddressError, label } = readRenameSessionRequest(payload);
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!label) {
      return badRequest('label is required');
    }
    return await this.deps.sessionLifecycleWorkflow.rename({ sessionKey, runtimeAddress, label });
  }

  async switchSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.loadSession(payload);
  }

  async getSessionStateSnapshot(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const {
      sessionKey: requestedSessionKey,
      runtimeAddress,
      runtimeAddressError,
    } = readSessionLoadRequest(payload);
    const sessionKey = requestedSessionKey;
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    return this.deps.sessionHydrationWorkflow.state({
      sessionKey,
      runtimeAddress,
    });
  }

  async getSessionWindow(payload: unknown): Promise<ApplicationResponseOf<SessionWindowResult | SessionHydratingWindowResult | { success: false; error: string }>> {
    const {
      sessionKey,
      mode,
      limit,
      offset,
      runtimeAddress,
      runtimeAddressError,
    } = readSessionWindowRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }

    if ((mode === 'older' || mode === 'newer') && offset == null) {
      return badRequest(`offset is required for mode: ${mode}`);
    }

    return await this.deps.sessionHydrationWorkflow.window({
      sessionKey,
      runtimeAddress,
      mode,
      limit,
      offset,
    });
  }

  async abortSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const {
      sessionKey,
      approvalIds,
      runtimeAddress,
      runtimeAddressError,
    } = readAbortSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }

    return await this.deps.sessionApprovalWorkflow.abort({
      sessionKey,
      approvalIds,
      runtimeAddress,
    });
  }

  async listPendingApprovals(payload: unknown): Promise<ApplicationResponseOf<unknown>> {
    const {
      runtimeAddress,
      runtimeAddressError,
    } = readRuntimeAddressRequest(payload);
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }
    return ok({
      approvals: this.deps.stateStore.listApprovals(runtimeAddress)
        .map((entry) => structuredClone(entry.approval))
        .sort((left, right) => left.createdAtMs - right.createdAtMs),
    });
  }

  async resolveApproval(payload: unknown): Promise<ApplicationResponseOf> {
    const {
      id,
      decision,
      sessionKey,
      runtimeAddress,
      runtimeAddressError,
    } = readResolveApprovalRequest(payload);
    if (!id) {
      return badRequest('approval id is required');
    }
    if (!decision) {
      return badRequest('approval decision is required');
    }
    if (!sessionKey) {
      return badRequest('approval sessionKey is required');
    }
    if (runtimeAddressError || !runtimeAddress) {
      return badRequest(runtimeAddressError ?? 'RuntimeAddress is required');
    }

    return await this.deps.sessionApprovalWorkflow.resolve({
      id,
      decision,
      sessionKey,
      runtimeAddress,
    });
  }

  async executeSessionHydration(payload: unknown): Promise<SessionLoadResult | SessionWindowResult> {
    return await this.deps.sessionHydrationWorkflow.execute(payload);
  }
}

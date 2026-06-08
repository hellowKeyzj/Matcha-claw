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
  readSessionIdentityRequest,
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
import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
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

function sessionIdentityMatchesSessionKey(sessionIdentity: SessionIdentity, sessionKey: string): boolean {
  return sessionIdentity.sessionKey === sessionKey;
}

export class SessionCommandOperationsWorkflow {
  constructor(private readonly deps: SessionCommandOperationsWorkflowDeps) {}

  async createSession(payload: unknown): Promise<ApplicationResponseOf<SessionNewResult>> {
    const {
      explicitSessionKey,
      endpoint,
      endpointError,
      agentId,
    } = readCreateSessionRequest(payload);
    if (endpointError || !endpoint) {
      return badRequest(endpointError ?? 'RuntimeEndpointRef is required');
    }
    if (!agentId) {
      return badRequest('agentId is required');
    }
    return await this.deps.sessionLifecycleWorkflow.create({
      explicitSessionKey,
      endpoint,
      agentId,
    });
  }

  async deleteSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, sessionIdentity, sessionIdentityError } = readSessionIdentityRequest(payload);
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!sessionIdentityMatchesSessionKey(sessionIdentity, sessionKey)) {
      return badRequest('sessionKey must match SessionIdentity.sessionKey');
    }
    return await this.deps.sessionLifecycleWorkflow.delete({ identity: sessionIdentity });
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
      sessionIdentity,
      sessionIdentityError,
      status: requestedStatus,
    } = readSessionStatusRequest(payload);
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!sessionIdentityMatchesSessionKey(sessionIdentity, sessionKey)) {
      return badRequest('sessionKey must match SessionIdentity.sessionKey');
    }
    const status = forcedStatus ?? requestedStatus;
    if (!status) {
      return badRequest('status is required');
    }
    return await this.deps.sessionLifecycleWorkflow.updateStatus({ identity: sessionIdentity, status });
  }

  async listSessions(payload: unknown) {
    const { endpoint, endpointError } = readSessionListRequest(payload);
    if (endpointError || !endpoint) {
      return badRequest(endpointError ?? 'RuntimeEndpointRef is required');
    }
    return await this.deps.sessionLifecycleWorkflow.list({ endpoint });
  }

  async loadSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const {
      sessionKey,
      limit,
      sessionIdentity,
      sessionIdentityError,
    } = readSessionLoadRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    return this.deps.sessionHydrationWorkflow.load({
      sessionKey,
      sessionIdentity,
      limit,
    });
  }

  async resumeSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const {
      sessionKey,
      sessionIdentity,
      sessionIdentityError,
    } = readSessionLoadRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    return this.deps.sessionHydrationWorkflow.resume({
      sessionKey,
      sessionIdentity,
    });
  }

  async patchSession(payload: unknown): Promise<ApplicationResponseOf> {
    const {
      sessionKey,
      sessionIdentity,
      sessionIdentityError,
      runtimeModelRef,
    } = readPatchSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    if (!sessionIdentityMatchesSessionKey(sessionIdentity, sessionKey)) {
      return badRequest('sessionKey must match SessionIdentity.sessionKey');
    }
    if (!runtimeModelRef) {
      return badRequest('runtimeModelRef is required');
    }
    return await this.deps.sessionModelSelectionWorkflow.patch({
      sessionKey,
      sessionIdentity,
      runtimeModelRef,
    });
  }

  async renameSession(payload: unknown): Promise<ApplicationResponseOf> {
    const { sessionKey, sessionIdentity, sessionIdentityError, label } = readRenameSessionRequest(payload);
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!sessionIdentityMatchesSessionKey(sessionIdentity, sessionKey)) {
      return badRequest('sessionKey must match SessionIdentity.sessionKey');
    }
    if (!label) {
      return badRequest('label is required');
    }
    return await this.deps.sessionLifecycleWorkflow.rename({ identity: sessionIdentity, label });
  }

  async switchSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.loadSession(payload);
  }

  async getSessionStateSnapshot(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    const {
      sessionKey: requestedSessionKey,
      sessionIdentity,
      sessionIdentityError,
    } = readSessionLoadRequest(payload);
    const sessionKey = requestedSessionKey;
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    return this.deps.sessionHydrationWorkflow.state({
      sessionKey,
      sessionIdentity,
    });
  }

  async getSessionWindow(payload: unknown): Promise<ApplicationResponseOf<SessionWindowResult | SessionHydratingWindowResult | { success: false; error: string }>> {
    const {
      sessionKey,
      mode,
      limit,
      offset,
      sessionIdentity,
      sessionIdentityError,
    } = readSessionWindowRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }

    if ((mode === 'older' || mode === 'newer') && offset == null) {
      return badRequest(`offset is required for mode: ${mode}`);
    }

    return await this.deps.sessionHydrationWorkflow.window({
      sessionKey,
      sessionIdentity,
      mode,
      limit,
      offset,
    });
  }

  async abortSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const {
      sessionKey,
      approvalIds,
      sessionIdentity,
      sessionIdentityError,
    } = readAbortSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }

    return await this.deps.sessionApprovalWorkflow.abort({
      sessionKey,
      approvalIds,
      sessionIdentity,
    });
  }

  async listPendingApprovals(payload: unknown): Promise<ApplicationResponseOf<unknown>> {
    const {
      sessionIdentity,
      sessionIdentityError,
    } = readSessionIdentityRequest(payload);
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    return ok({
      approvals: this.deps.stateStore.listApprovals(sessionIdentity)
        .map((entry) => structuredClone(entry.approval))
        .sort((left, right) => left.createdAtMs - right.createdAtMs),
    });
  }

  async resolveApproval(payload: unknown): Promise<ApplicationResponseOf> {
    const {
      id,
      decision,
      sessionKey,
      sessionIdentity,
      sessionIdentityError,
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
    if (sessionIdentityError || !sessionIdentity) {
      return badRequest(sessionIdentityError ?? 'SessionIdentity is required');
    }
    if (!sessionIdentityMatchesSessionKey(sessionIdentity, sessionKey)) {
      return badRequest('sessionKey must match SessionIdentity.sessionKey');
    }

    return await this.deps.sessionApprovalWorkflow.resolve({
      id,
      decision,
      sessionKey,
      sessionIdentity,
    });
  }

  async executeSessionHydration(payload: unknown): Promise<SessionLoadResult | SessionWindowResult> {
    return await this.deps.sessionHydrationWorkflow.execute(payload);
  }
}

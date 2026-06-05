import type {
  SessionLoadResult,
  SessionNewResult,
  SessionWindowResult,
} from '../../shared/session-adapter-types';
import type {
  SessionHydratingLoadResult,
  SessionHydratingWindowResult,
} from '../workflows/session-hydration/session-hydration-workflow';
import type { SessionCommandOperationsWorkflow } from '../workflows/session-command/session-command-operations-workflow';
import type { ApplicationResponseOf } from '../common/application-response';

export interface SessionCommandServiceDeps {
  operationsWorkflow: Pick<
    SessionCommandOperationsWorkflow,
    | 'createSession'
    | 'deleteSession'
    | 'archiveSession'
    | 'unarchiveSession'
    | 'updateSessionStatus'
    | 'listSessions'
    | 'loadSession'
    | 'resumeSession'
    | 'patchSession'
    | 'renameSession'
    | 'switchSession'
    | 'getSessionStateSnapshot'
    | 'getSessionWindow'
    | 'abortSession'
    | 'listPendingApprovals'
    | 'resolveApproval'
    | 'executeSessionHydration'
  >;
}

export class SessionCommandService {
  constructor(private readonly deps: SessionCommandServiceDeps) {}

  async createSession(payload: unknown): Promise<ApplicationResponseOf<SessionNewResult>> {
    return await this.deps.operationsWorkflow.createSession(payload);
  }

  async deleteSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.deleteSession(payload);
  }

  async archiveSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.archiveSession(payload);
  }

  async unarchiveSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.unarchiveSession(payload);
  }

  async updateSessionStatus(
    payload: unknown,
    forcedStatus?: 'active' | 'completed' | 'archived' | 'deleted',
  ): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.updateSessionStatus(payload, forcedStatus);
  }

  async listSessions(payload: unknown) {
    return await this.deps.operationsWorkflow.listSessions(payload);
  }

  async loadSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.deps.operationsWorkflow.loadSession(payload);
  }

  async resumeSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.deps.operationsWorkflow.resumeSession(payload);
  }

  async patchSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.patchSession(payload);
  }

  async renameSession(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.renameSession(payload);
  }

  async switchSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.deps.operationsWorkflow.switchSession(payload);
  }

  async getSessionStateSnapshot(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult | SessionHydratingLoadResult | { success: false; error: string }>> {
    return await this.deps.operationsWorkflow.getSessionStateSnapshot(payload);
  }

  async getSessionWindow(payload: unknown): Promise<ApplicationResponseOf<SessionWindowResult | SessionHydratingWindowResult | { success: false; error: string }>> {
    return await this.deps.operationsWorkflow.getSessionWindow(payload);
  }

  async abortSession(payload: unknown): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    return await this.deps.operationsWorkflow.abortSession(payload);
  }

  async listPendingApprovals(payload: unknown): Promise<ApplicationResponseOf<unknown>> {
    return await this.deps.operationsWorkflow.listPendingApprovals(payload);
  }

  async resolveApproval(payload: unknown): Promise<ApplicationResponseOf> {
    return await this.deps.operationsWorkflow.resolveApproval(payload);
  }

  async executeSessionHydration(payload: unknown): Promise<SessionLoadResult | SessionWindowResult> {
    return await this.deps.operationsWorkflow.executeSessionHydration(payload);
  }
}

import type {
  SessionUpdateEvent,
} from '../../shared/session-adapter-types';
import type { SessionCatalogPort } from './session-catalog';
import { SessionCommandService } from './session-command-service';
import { SessionGatewayIngressService } from './session-gateway-ingress-service';
import { SessionPromptService } from './session-prompt-service';
import { SessionRuntimeStateStore } from './session-runtime-state';
import { SessionSnapshotService } from './session-snapshot-service';
import { SessionTimelineRuntime } from './session-timeline-runtime';
import { SessionOperationCoordinator } from './session-operation-coordinator';
import type { RuntimeEndpointRef } from '../agent-runtime/contracts/runtime-address';

interface SessionRuntimeServiceDeps {
  sessionCatalog: SessionCatalogPort;
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  ingressService: SessionGatewayIngressService;
  commandService: SessionCommandService;
  promptService: SessionPromptService;
  operationCoordinator: SessionOperationCoordinator;
}

export class SessionRuntimeService {
  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  async consumeEndpointConversationEvent(endpoint: RuntimeEndpointRef, payload: unknown): Promise<SessionUpdateEvent[]> {
    return await this.deps.ingressService.consumeEndpointConversationEvent(endpoint, payload);
  }

  consumeEndpointNotification(endpoint: RuntimeEndpointRef, payload: Parameters<SessionGatewayIngressService['consumeEndpointNotification']>[1]): SessionUpdateEvent[] {
    return this.deps.ingressService.consumeEndpointNotification(endpoint, payload);
  }

  async createSession(payload: unknown) {
    return await this.deps.commandService.createSession(payload);
  }

  async deleteSession(payload: unknown) {
    return await this.deps.commandService.deleteSession(payload);
  }

  async archiveSession(payload: unknown) {
    return await this.deps.commandService.archiveSession(payload);
  }

  async unarchiveSession(payload: unknown) {
    return await this.deps.commandService.unarchiveSession(payload);
  }

  async updateSessionStatus(payload: unknown) {
    return await this.deps.commandService.updateSessionStatus(payload);
  }

  async listSessions(payload: unknown) {
    return await this.deps.commandService.listSessions(payload);
  }

  async refreshSessionCatalog() {
    await this.deps.sessionCatalog.refreshCache();
  }

  async loadSession(payload: unknown) {
    return await this.deps.commandService.loadSession(payload);
  }

  async resumeSession(payload: unknown) {
    return await this.deps.commandService.resumeSession(payload);
  }

  async patchSession(payload: unknown) {
    return await this.deps.commandService.patchSession(payload);
  }

  async renameSession(payload: unknown) {
    return await this.deps.commandService.renameSession(payload);
  }

  async switchSession(payload: unknown) {
    return await this.deps.commandService.switchSession(payload);
  }

  async getSessionStateSnapshot(payload: unknown) {
    return await this.deps.commandService.getSessionStateSnapshot(payload);
  }

  async getSessionWindow(payload: unknown) {
    return await this.deps.commandService.getSessionWindow(payload);
  }

  async executeSessionHydration(payload: unknown) {
    return await this.deps.commandService.executeSessionHydration(payload);
  }

  async abortSession(payload: unknown) {
    return await this.deps.commandService.abortSession(payload);
  }

  async listPendingApprovals(payload: unknown) {
    return await this.deps.commandService.listPendingApprovals(payload);
  }

  async resolveApproval(payload: unknown) {
    return await this.deps.commandService.resolveApproval(payload);
  }


  async promptSession(payload: unknown) {
    return await this.deps.promptService.promptSession(payload);
  }
}

import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../gateway/gateway-runtime-port';
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

  consumeGatewayConnectionState(payload: GatewayConnectionStatePayload): SessionUpdateEvent[] {
    if (payload.state === 'connected') {
      this.deps.stateStore.markTransportConnected(payload.transportEpoch);
      this.deps.stateStore.expireTransportControlIssues(payload.transportEpoch);
    }
    return this.deps.ingressService.consumeGatewayConnectionState(payload);
  }

  consumeGatewayControlReadiness(payload: GatewayControlReadiness): SessionUpdateEvent[] {
    if (payload.ready) {
      this.deps.stateStore.expireTransportControlIssues(this.deps.stateStore.getLatestConnectedTransportEpoch());
    }
    return this.deps.ingressService.consumeGatewayControlReadiness(payload);
  }

  consumeGatewayCapabilities(payload: GatewayCapabilitiesSnapshot | null): SessionUpdateEvent[] {
    return this.deps.ingressService.consumeGatewayCapabilities(payload);
  }

  async consumeGatewayConversationEvent(payload: unknown): Promise<SessionUpdateEvent[]> {
    return await this.deps.ingressService.consumeGatewayConversationEvent(payload);
  }

  consumeGatewayNotification(payload: Parameters<SessionGatewayIngressService['consumeGatewayNotification']>[0]): SessionUpdateEvent[] {
    return this.deps.ingressService.consumeGatewayNotification(payload);
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

  async listSessions() {
    return await this.deps.commandService.listSessions();
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

  async listPendingApprovals() {
    return await this.deps.commandService.listPendingApprovals();
  }

  async resolveApproval(payload: unknown) {
    return await this.deps.commandService.resolveApproval(payload);
  }

  async promptSession(payload: unknown) {
    return await this.deps.promptService.promptSession(payload);
  }
}

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

interface SessionRuntimeServiceDeps {
  sessionCatalog: SessionCatalogPort;
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  ingressService: SessionGatewayIngressService;
  commandService: SessionCommandService;
  promptService: SessionPromptService;
}

export class SessionRuntimeService {
  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  notifyTransportConnected(transportEpoch: number): void {
    if (!this.deps.stateStore.markTransportConnected(transportEpoch)) {
      return;
    }
    for (const [sessionKey, state] of this.deps.stateStore.listSessionStates()) {
      if (!state.runtime.sending || !state.runtime.activeRunId) {
        continue;
      }
      if (state.activeTransportEpoch == null || state.activeTransportEpoch >= transportEpoch) {
        continue;
      }
      this.deps.timelineRuntime.resetPendingRunState(sessionKey, {
        runPhase: 'error',
        lastError: 'The active run disconnected before a terminal event was received.',
        lastIssue: null,
      });
    }
  }

  consumeGatewayConversationEvent(payload: unknown): SessionUpdateEvent[] {
    return this.deps.ingressService.consumeGatewayConversationEvent(payload);
  }

  async createSession(payload: unknown) {
    return await this.deps.commandService.createSession(payload);
  }

  async deleteSession(payload: unknown) {
    return await this.deps.commandService.deleteSession(payload);
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

  async abortSessionRuntime(payload: unknown) {
    return await this.deps.commandService.abortSessionRuntime(payload);
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

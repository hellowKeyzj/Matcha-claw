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

  notifyTransportConnected(transportEpoch: number): void {
    if (!this.deps.stateStore.markTransportConnected(transportEpoch)) {
      return;
    }
    for (const [sessionKey, state] of this.deps.stateStore.listSessionStates()) {
      if (!state.runtime.sending) {
        continue;
      }
      if (state.activeTransportEpoch == null || state.activeTransportEpoch >= transportEpoch) {
        continue;
      }
      void this.deps.operationCoordinator.run(sessionKey, 'reconcile', async () => {
        const latestState = this.deps.stateStore.getSessionState(sessionKey);
        if (!latestState.runtime.sending) {
          return;
        }
        if (latestState.activeTransportEpoch == null || latestState.activeTransportEpoch >= transportEpoch) {
          return;
        }
        this.deps.stateStore.blockRuns(sessionKey, [
          latestState.runtime.activeRunId,
          ...latestState.timelineEntries.map((entry) => entry.runId),
        ]);
        const committed = this.deps.timelineRuntime.commitSessionTransition(sessionKey, {
          runtimePatch: this.deps.timelineRuntime.buildTerminalRuntimePatch(
            'error',
            'The active run disconnected before a terminal event was received.',
            null,
          ),
          activeTransportEpoch: null,
          advanceRunEpoch: true,
        });
        const snapshot = {
          ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, committed.state, {
            replayComplete: committed.state.hydrated,
          }),
          runtime: committed.runtime,
        };
        await this.deps.stateStore.flushPersistedStore();
        return snapshot;
      }).catch(() => undefined);
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

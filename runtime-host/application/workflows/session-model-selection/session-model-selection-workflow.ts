import { isRunActive } from '../../../shared/session-adapter-types';
import { readPatchedSessionResolvedModel } from '../../sessions/session-state-model';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';
import type { SessionOperationCoordinator } from '../../sessions/session-operation-coordinator';
import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import {
  badRequest,
  conflict,
  ok,
  type ApplicationResponseOf,
} from '../../common/application-response';

export interface SessionModelSelectionWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  operationCoordinator: SessionOperationCoordinator;
}

export class SessionModelSelectionWorkflow {
  constructor(private readonly deps: SessionModelSelectionWorkflowDeps) {}

  async patch(input: {
    sessionKey: string;
    sessionIdentity: SessionIdentity;
    runtimeModelRef: string;
  }): Promise<ApplicationResponseOf> {
    return await this.deps.operationCoordinator.run(input.sessionIdentity, 'patch-model', async () => {
      const context = this.deps.agentRuntimeRegistry.rememberSessionIdentity(input.sessionIdentity);
      const current = this.deps.stateStore.getSessionState(input.sessionKey, context).runtime;
      if (isRunActive(current) || current.activeRunId) {
        const state = await this.deps.timelineRuntime.activateSession(input.sessionKey, {
          resetWindowToLatest: false,
          context,
        });
        const snapshot = await this.deps.snapshotService.buildLatestSnapshotAsync(input.sessionKey, state, {
          replayComplete: state.hydrated,
        });
        return conflict({
          success: false,
          code: 'ACTIVE_RUN',
          error: 'Cannot switch model while a session run is active',
          snapshot,
        });
      }

      const transport = this.deps.agentRuntimeRegistry.resolveTransport(context);
      if (!transport.patchSessionModel) {
        return badRequest(`Runtime endpoint does not support model patch: ${context.endpoint.scopeKey}`);
      }
      const patchResult = await transport.patchSessionModel({
        context,
        runtimeModelRef: input.runtimeModelRef,
      });
      this.deps.stateStore.setResolvedSessionModel(
        input.sessionKey,
        readPatchedSessionResolvedModel(input.runtimeModelRef, patchResult.payload),
        context,
      );

      const state = await this.deps.timelineRuntime.activateSession(input.sessionKey, {
        resetWindowToLatest: false,
        context,
      });
      const snapshot = await this.deps.snapshotService.buildLatestSnapshotAsync(input.sessionKey, state, {
        replayComplete: state.hydrated,
      });
      await this.deps.stateStore.flushPersistedStore();

      return ok({
        success: true,
        snapshot,
      });
    });
  }
}

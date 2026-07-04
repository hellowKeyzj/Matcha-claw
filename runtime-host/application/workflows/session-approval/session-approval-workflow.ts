import type {
  SessionApprovalDecision,
  SessionInfoUpdateEvent,
  SessionLoadResult,
} from '../../../shared/session-adapter-types';
import { createLatestWindowState } from '../../sessions/session-window-model';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';
import type { SessionOperationCoordinator } from '../../sessions/session-operation-coordinator';
import type { CanonicalSessionEvent } from '../../sessions/canonical/canonical-events';
import type { RuntimeClockPort } from '../../common/runtime-ports';
import { buildSessionIdentityKey, type SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import {
  ok,
  serverError,
  type ApplicationResponseOf,
} from '../../common/application-response';

export interface SessionApprovalWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  operationCoordinator: SessionOperationCoordinator;
  clock: RuntimeClockPort;
  emitSessionUpdate?: (event: SessionInfoUpdateEvent) => void;
}

export class SessionApprovalWorkflow {
  constructor(private readonly deps: SessionApprovalWorkflowDeps) {}

  async abort(input: {
    sessionKey: string;
    approvalIds: string[];
    sessionIdentity: SessionIdentity;
  }): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const context = this.deps.agentRuntimeRegistry.rememberSessionIdentity(input.sessionIdentity);
    const currentRunId = this.deps.stateStore.getSessionState(input.sessionKey, context).runtime.activeRunId ?? undefined;
    try {
      await this.deps.agentRuntimeRegistry.resolveTransport(context).abortSession({
        context,
        approvalIds: input.approvalIds,
        ...(currentRunId ? { runId: currentRunId } : {}),
      });
    } catch (error) {
      return serverError(error instanceof Error ? error.message : String(error));
    }
    return await this.commitAbortSession(input.sessionIdentity, context, currentRunId);
  }

  async resolve(input: {
    id: string;
    decision: SessionApprovalDecision;
    sessionKey: string;
    sessionIdentity: SessionIdentity;
  }): Promise<ApplicationResponseOf> {
    const context = this.deps.agentRuntimeRegistry.rememberSessionIdentity(input.sessionIdentity);
    const pendingApproval = this.findPendingApproval(input.sessionIdentity, input.id);
    const result = await this.deps.agentRuntimeRegistry.resolveTransport(context).resolveApproval({
      context,
      id: input.id,
      decision: input.decision,
    });
    if (pendingApproval) {
      this.appendResolvedApprovalEvent({
        id: input.id,
        decision: input.decision,
        sessionKey: input.sessionKey,
        ...(pendingApproval.runId ? { runId: pendingApproval.runId } : {}),
        context,
      });
    }
    return ok(result);
  }

  private async commitAbortSession(sessionIdentity: SessionIdentity, context: RuntimeSessionContext, runId: string | undefined): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const sessionKey = sessionIdentity.sessionKey;
    return await this.deps.operationCoordinator.run(sessionIdentity, 'abort', async () => {
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(sessionKey, [{
        eventId: `local:lifecycle:${sessionKey}:${runId ?? 'active'}:aborted`,
        type: 'lifecycle',
        protocolId: context.protocolId,
        runtimeEndpointId: context.runtimeEndpointId,
        source: 'live',
        sessionId: sessionKey,
        ...(runId ? { runId } : {}),
        timestamp: this.deps.clock.nowMs(),
        laneKey: 'main',
        origin: {
          runtimeEventType: 'local.abort',
          runtimeIds: {
            sessionKey,
            ...(runId ? { runId } : {}),
          },
        },
        phase: 'aborted',
        runPhase: 'aborted',
        error: null,
      }], context);
      committed.state.window = createLatestWindowState(committed.state.renderItems.length);
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, committed.state, {
          replayComplete: committed.state.hydrated,
        }),
        runtime: committed.runtime,
      };
      const result: SessionLoadResult & { success: boolean } = {
        success: true,
        snapshot,
      };
      await this.deps.stateStore.flushPersistedStore();
      this.deps.emitSessionUpdate?.({
        sessionUpdate: 'session_info_update',
        sessionKey,
        runId: runId ?? null,
        phase: 'aborted',
        snapshot,
        error: null,
      });
      return ok(result);
    });
  }

  private findPendingApproval(sessionIdentity: SessionIdentity, approvalId: string): { runId?: string } | null {
    const entry = this.deps.stateStore.findApproval(sessionIdentity, approvalId);
    if (!entry || entry.sessionKey !== sessionIdentity.sessionKey) {
      return null;
    }
    if (buildSessionIdentityKey(entry.approval.sessionIdentity) !== buildSessionIdentityKey(sessionIdentity)) {
      return null;
    }
    return {
      ...(entry.approval.runId ? { runId: entry.approval.runId } : {}),
    };
  }

  private appendResolvedApprovalEvent(input: { id: string; decision: SessionApprovalDecision; sessionKey: string; runId?: string; context: RuntimeSessionContext }): void {
    const now = this.deps.clock.nowMs();
    const event: CanonicalSessionEvent = {
      eventId: `local:approval:resolved:${input.sessionKey}:${input.id}:${input.decision}`,
      type: 'approval',
      protocolId: input.context.protocolId,
      runtimeEndpointId: input.context.runtimeEndpointId,
      source: 'live',
      sessionId: input.sessionKey,
      ...(input.runId ? { runId: input.runId } : {}),
      timestamp: now,
      laneKey: 'main',
      origin: {
        runtimeEventType: 'local.approval.resolved',
        runtimeIds: {
          sessionKey: input.sessionKey,
          ...(input.runId ? { runId: input.runId } : {}),
          approvalId: input.id,
        },
      },
      approvalId: input.id,
      status: 'resolved',
      decision: input.decision,
      title: 'approval',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      createdAtMs: now,
    };
    this.deps.timelineRuntime.appendCanonicalEvents(input.sessionKey, [event], input.context);
  }
}

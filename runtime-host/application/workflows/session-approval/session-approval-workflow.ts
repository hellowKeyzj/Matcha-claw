import type {
  SessionApprovalDecision,
  SessionLoadResult,
} from '../../../shared/session-adapter-types';
import { createLatestWindowState } from '../../sessions/session-window-model';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';
import type { SessionOperationCoordinator } from '../../sessions/session-operation-coordinator';
import type { CanonicalSessionEvent } from '../../sessions/canonical/canonical-events';
import type { RuntimeClockPort } from '../../common/runtime-ports';
import type { RuntimeAddress } from '../../agent-runtime/contracts/runtime-address';
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
}

export class SessionApprovalWorkflow {
  constructor(private readonly deps: SessionApprovalWorkflowDeps) {}

  async abort(input: {
    sessionKey: string;
    approvalIds: string[];
    runtimeAddress: RuntimeAddress;
  }): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    const context = this.deps.agentRuntimeRegistry.rememberSessionAddress(input.sessionKey, input.runtimeAddress);
    try {
      await this.deps.agentRuntimeRegistry.resolveTransport(context).abortSession({
        context,
        approvalIds: input.approvalIds,
      });
    } catch (error) {
      return serverError(error instanceof Error ? error.message : String(error));
    }
    return await this.commitAbortSession(input.sessionKey, context);
  }

  async resolve(input: {
    id: string;
    decision: SessionApprovalDecision;
    sessionKey: string;
    runtimeAddress: RuntimeAddress;
  }): Promise<ApplicationResponseOf> {
    const context = this.deps.agentRuntimeRegistry.rememberSessionAddress(input.sessionKey, input.runtimeAddress);
    const pendingApproval = this.findPendingApproval(input.sessionKey, input.id);
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

  private async commitAbortSession(sessionKey: string, context: RuntimeSessionContext): Promise<ApplicationResponseOf<SessionLoadResult & { success: boolean } | { success: false; error: string }>> {
    return await this.deps.operationCoordinator.run(sessionKey, 'abort', async () => {
      const currentRunId = this.deps.stateStore.getSessionState(sessionKey, context).runtime.activeRunId ?? undefined;
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(sessionKey, [{
        eventId: `local:lifecycle:${sessionKey}:${currentRunId ?? 'active'}:aborted`,
        type: 'lifecycle',
        protocolId: context.protocolId,
        runtimeEndpointId: context.runtimeEndpointId,
        source: 'live',
        sessionId: sessionKey,
        ...(currentRunId ? { runId: currentRunId } : {}),
        timestamp: this.deps.clock.nowMs(),
        laneKey: 'main',
        origin: {
          runtimeEventType: 'local.abort',
          runtimeIds: {
            sessionKey,
            ...(currentRunId ? { runId: currentRunId } : {}),
          },
        },
        phase: 'aborted',
        runPhase: 'aborted',
        error: null,
      }], context);
      committed.state.window = createLatestWindowState(committed.state.renderItems.length);
      const result: SessionLoadResult & { success: boolean } = {
        success: true,
        snapshot: {
          ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, committed.state, {
            replayComplete: committed.state.hydrated,
          }),
          runtime: committed.runtime,
        },
      };
      await this.deps.stateStore.flushPersistedStore();
      return ok(result);
    });
  }

  private findPendingApproval(sessionKey: string, approvalId: string): { runId?: string } | null {
    const entry = this.deps.stateStore.findApproval(approvalId);
    if (!entry || entry.sessionKey !== sessionKey) {
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

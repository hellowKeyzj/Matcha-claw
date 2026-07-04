import type {
  SessionInfoUpdateEvent,
  SessionPromptResult,
} from '../../../shared/session-adapter-types';
import {
  buildSendWithMediaGatewayParams,
} from '../../chat/send-media';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import type { SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import type {
  RuntimeClockPort,
  RuntimeFileSystemPort,
} from '../../common/runtime-ports';
import type { CanonicalSessionEvent } from '../../sessions/canonical/canonical-events';
import type { SessionOperationCoordinator } from '../../sessions/session-operation-coordinator';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type {
  SessionPromptMediaPayload,
  SessionPromptPayload,
} from '../../sessions/session-runtime-types';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';

export interface SessionRunWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  fileSystem: RuntimeFileSystemPort;
  clock: RuntimeClockPort;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  operationCoordinator: SessionOperationCoordinator;
  emitSessionUpdate?: (event: SessionInfoUpdateEvent) => void;
}

export interface SessionRunWorkflowInput {
  directBody: SessionPromptPayload;
  mediaBody: {
    sessionKey?: string;
    message?: string;
    idempotencyKey?: string;
    media?: unknown;
  } | null;
  sessionId: string;
  message: string;
  displayMessage: string;
  runId: string;
  sessionIdentity: SessionIdentity;
}

interface SubmittedPromptSnapshot {
  entryKey: string;
  snapshot: SessionPromptResult['snapshot'];
}

export class SessionRunWorkflow {
  constructor(private readonly deps: SessionRunWorkflowDeps) {}

  async execute(input: SessionRunWorkflowInput): Promise<SessionPromptResult> {
    const context = this.rememberSessionIdentity(input);
    const submitted = await this.commitSubmittedPrompt(input, context);
    this.startRuntimeSendInBackground({ ...input, context });
    return this.buildPromptResult(input, submitted);
  }

  private rememberSessionIdentity(input: SessionRunWorkflowInput): RuntimeSessionContext {
    return this.deps.agentRuntimeRegistry.rememberSessionIdentity(input.sessionIdentity);
  }

  private async commitSubmittedPrompt(
    input: SessionRunWorkflowInput,
    context: RuntimeSessionContext,
  ): Promise<SubmittedPromptSnapshot> {
    return await this.deps.operationCoordinator.run(input.sessionIdentity, 'prompt', async () => {
      await this.deps.timelineRuntime.activateSession(input.sessionId, {
        resetWindowToLatest: true,
        context,
      });
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(
        input.sessionId,
        this.buildSubmittedPromptEvents(input, context),
        context,
      );
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(input.sessionId, committed.state),
        runtime: committed.runtime,
      };
      await this.deps.stateStore.flushPersistedStore();
      return {
        entryKey: snapshot.items.find((item) => item.kind === 'user-message' && item.runId === input.runId)?.key ?? '',
        snapshot,
      };
    });
  }

  private buildSubmittedPromptEvents(
    input: SessionRunWorkflowInput,
    context: RuntimeSessionContext,
  ): CanonicalSessionEvent[] {
    const now = this.deps.clock.nowMs();
    return [{
      eventId: `local:user:${input.sessionId}:${input.runId}`,
      type: 'message_part',
      partId: input.runId,
      protocolId: context.protocolId,
      runtimeEndpointId: context.runtimeEndpointId,
      source: 'live',
      sessionId: input.sessionId,
      runId: input.runId,
      timestamp: now,
      laneKey: 'main',
      origin: {
        runtimeEventType: 'local.prompt.user',
        runtimeIds: {
          sessionKey: input.sessionId,
          runId: input.runId,
        },
      },
      role: 'user',
      kind: 'text',
      mode: 'final',
      messageId: input.runId,
      content: input.displayMessage,
      text: input.displayMessage,
      status: 'final',
      attachedFiles: this.buildAttachedFiles(input),
    }, {
      eventId: `local:lifecycle:${input.sessionId}:${input.runId}:started`,
      type: 'lifecycle',
      protocolId: context.protocolId,
      runtimeEndpointId: context.runtimeEndpointId,
      source: 'live',
      sessionId: input.sessionId,
      runId: input.runId,
      timestamp: now,
      laneKey: 'main',
      origin: {
        runtimeEventType: 'local.prompt.started',
        runtimeIds: {
          sessionKey: input.sessionId,
          runId: input.runId,
        },
      },
      phase: 'started',
      runPhase: 'submitted',
      error: null,
    }];
  }

  private buildAttachedFiles(input: SessionRunWorkflowInput) {
    const media = Array.isArray(input.mediaBody?.media)
      ? input.mediaBody.media as SessionPromptMediaPayload[]
      : [];
    return media.map((file) => ({
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.fileSize ?? 0,
      preview: file.preview ?? null,
      filePath: file.filePath,
      source: 'user-upload' as const,
    }));
  }

  private buildPromptResult(
    input: SessionRunWorkflowInput,
    submitted: SubmittedPromptSnapshot,
  ): SessionPromptResult {
    return {
      success: true,
      sessionKey: input.sessionId,
      runId: input.runId,
      item: submitted.snapshot.items.find((candidate) => candidate.key === submitted.entryKey) ?? null,
      snapshot: submitted.snapshot,
    };
  }

  private startRuntimeSendInBackground(input: SessionRunWorkflowInput & { context: RuntimeSessionContext }): void {
    void this.sendRuntimePrompt(input).catch(() => undefined);
  }

  private async sendRuntimePrompt(input: SessionRunWorkflowInput & { context: RuntimeSessionContext }): Promise<void> {
    const transport = this.deps.agentRuntimeRegistry.resolveTransport(input.context);
    const sendResult = await transport.sendPrompt({
      context: input.context,
      message: input.message,
      runId: input.runId,
      payload: await this.buildRuntimePromptPayload(input),
    });

    if (!sendResult.success) {
      await this.failSubmittedPrompt({
        sessionId: input.sessionId,
        runId: input.runId,
        error: sendResult.error ?? 'Failed to prompt session',
        context: input.context,
      });
    }
  }

  private async buildRuntimePromptPayload(input: SessionRunWorkflowInput): Promise<unknown> {
    return await buildSendWithMediaGatewayParams(this.deps.fileSystem, input.mediaBody
      ? {
          ...input.mediaBody,
          sessionKey: input.sessionId,
          message: input.message,
          idempotencyKey: input.runId,
        }
      : {
          sessionKey: input.sessionId,
          message: input.message,
          idempotencyKey: input.runId,
          ...(typeof input.directBody.deliver === 'boolean' ? { deliver: input.directBody.deliver } : {}),
        });
  }

  private async failSubmittedPrompt(input: {
    sessionId: string;
    runId: string;
    error: string;
    context?: RuntimeSessionContext;
  }): Promise<void> {
    const context = input.context ?? this.deps.agentRuntimeRegistry.resolveSessionContext(input.sessionId);
    await this.deps.operationCoordinator.run(context.identity, 'prompt', async () => {
      const state = this.deps.stateStore.getSessionState(input.sessionId, context);
      if (state.runtime.activeRunId !== input.runId) {
        return;
      }
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(input.sessionId, [this.buildPromptFailureEvent(input, context)], context);
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(input.sessionId, committed.state),
        runtime: committed.runtime,
      };
      await this.deps.stateStore.flushPersistedStore();
      this.deps.emitSessionUpdate?.({
        sessionUpdate: 'session_info_update',
        sessionKey: input.sessionId,
        runId: input.runId,
        phase: 'error',
        snapshot,
        error: input.error,
      });
      return snapshot;
    });
  }

  private buildPromptFailureEvent(
    input: { sessionId: string; runId: string; error: string },
    context: RuntimeSessionContext,
  ): CanonicalSessionEvent {
    return {
      eventId: `local:lifecycle:${input.sessionId}:${input.runId}:error`,
      type: 'lifecycle',
      protocolId: context.protocolId,
      runtimeEndpointId: context.runtimeEndpointId,
      source: 'live',
      sessionId: input.sessionId,
      runId: input.runId,
      timestamp: this.deps.clock.nowMs(),
      laneKey: 'main',
      origin: {
        runtimeEventType: 'local.prompt.failed',
        runtimeIds: {
          sessionKey: input.sessionId,
          runId: input.runId,
        },
      },
      phase: 'error',
      runPhase: 'error',
      error: input.error,
    };
  }
}

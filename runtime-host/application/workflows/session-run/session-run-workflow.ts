import type {
  SessionPromptResult,
  SessionUpdateEvent,
} from '../../../shared/session-adapter-types';
import {
  buildSendWithMediaGatewayParams,
} from '../../chat/send-media';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import { buildSessionIdentityKey, type SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
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
import type { RuntimeHostLogger } from '../../../shared/logger';
import {
  readMatchaTerminalDeliveryTraceContext,
  type MatchaTerminalDeliveryTrace,
  type MatchaTerminalDeliveryTraceContext,
} from '../../../shared/matcha-terminal-delivery-trace';

export interface SessionRunWorkspaceResolverPort {
  getWorkspaceDirForSession(sessionKey: string): Promise<string>;
}

export interface SessionRunWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  fileSystem: RuntimeFileSystemPort;
  clock: RuntimeClockPort;
  agentRuntimeRegistry: AgentRuntimeRegistry;
  operationCoordinator: SessionOperationCoordinator;
  workspaceResolver?: SessionRunWorkspaceResolverPort;
  ingestEndpointConversationEvent: (endpoint: RuntimeSessionContext['endpointRef'], payload: unknown) => Promise<SessionUpdateEvent[]>;
  emitSessionUpdate?: (event: SessionUpdateEvent) => void;
  logger?: Pick<RuntimeHostLogger, 'warn' | 'traceDebug'>;
  terminalDeliveryTrace?: MatchaTerminalDeliveryTrace;
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
  endpointSessionId?: string;
}

interface SubmittedPromptSnapshot {
  entryKey: string;
  snapshot: SessionPromptResult['snapshot'];
  shouldSendRuntimePrompt: boolean;
}

class RuntimePromptSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePromptSendError';
  }
}

export class SessionRunWorkflow {
  private readonly startedSessionEventIdentityKeys = new Set<string>();

  constructor(private readonly deps: SessionRunWorkflowDeps) {}

  async execute(input: SessionRunWorkflowInput): Promise<SessionPromptResult> {
    const context = this.rememberSessionIdentity(input);
    const submitted = await this.commitSubmittedPrompt(input, context);
    if (submitted.shouldSendRuntimePrompt) {
      this.startRuntimeSendInBackground({ ...input, context });
    }
    return this.buildPromptResult(input, submitted);
  }

  private rememberSessionIdentity(input: SessionRunWorkflowInput): RuntimeSessionContext {
    return this.deps.agentRuntimeRegistry.rememberSessionIdentity(input.sessionIdentity, input.endpointSessionId);
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
        shouldSendRuntimePrompt: committed.committedEventCount > 0,
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
    void this.deps.operationCoordinator.run(input.context.identity, 'prompt', async () => {
      await this.sendRuntimePrompt(input);
    }).catch((error) => this.failSubmittedPrompt({
      sessionId: input.sessionId,
      runId: input.runId,
      error: error instanceof Error ? error.message : String(error),
      context: input.context,
    }).catch((compensationError) => {
      this.deps.logger?.warn('Prompt failure compensation failed', {
        sessionKey: input.sessionId,
        endpointSessionId: input.context.endpointSessionId,
        runId: input.runId,
        error: compensationError instanceof Error ? compensationError.message : String(compensationError),
      });
    }));
  }

  private async sendRuntimePrompt(input: SessionRunWorkflowInput & { context: RuntimeSessionContext }): Promise<void> {
    const transport = this.deps.agentRuntimeRegistry.resolveTransport(input.context);
    if (transport.ensureSession) {
      const ensureResult = await transport.ensureSession({
        context: input.context,
        cwd: await this.resolveWorkspaceDir(input.sessionId),
      });
      if (!ensureResult.success) {
        throw new RuntimePromptSendError(ensureResult.error ?? 'Failed to prepare runtime session');
      }
    }
    if (transport.startSessionEvents) {
      const identityKey = buildSessionIdentityKey(input.context.identity);
      if (!this.startedSessionEventIdentityKeys.has(identityKey)) {
        await transport.startSessionEvents({
          context: input.context,
          consume: async (eventEnvelope) => {
            const terminalTrace = this.readMatchaTerminalTrace(eventEnvelope);
            try {
              await this.deps.ingestEndpointConversationEvent(input.context.endpointRef, eventEnvelope);
              if (terminalTrace) {
                this.emitTerminalDeliveryTrace('ingress_resolved', terminalTrace);
              }
            } catch (error) {
              const errorCategory = error instanceof Error ? 'error' : 'non_error';
              if (terminalTrace) {
                this.emitTerminalDeliveryTrace('ingress_rejected', terminalTrace, { errorCategory });
                return;
              }
              this.deps.logger?.warn('Session event ingestion failed', {
                source: 'runtime-session-event',
                errorCategory,
              });
            }
          },
        });
        this.startedSessionEventIdentityKeys.add(identityKey);
      }
    }
    const sendResult = await transport.sendPrompt({
      context: input.context,
      message: input.message,
      runId: input.runId,
      payload: await this.buildRuntimePromptPayload(input),
    });

    if (!sendResult.success) {
      throw new RuntimePromptSendError(sendResult.error ?? 'Failed to prompt session');
    }
  }

  private readMatchaTerminalTrace(eventEnvelope: unknown): MatchaTerminalDeliveryTraceContext | null {
    return readMatchaTerminalDeliveryTraceContext(eventEnvelope);
  }

  private emitTerminalDeliveryTrace(
    stage: 'ingress_resolved' | 'ingress_rejected',
    trace: MatchaTerminalDeliveryTraceContext | null,
    details: { errorCategory?: 'error' | 'non_error' } = {},
  ): void {
    if (!trace) {
      return;
    }
    this.deps.terminalDeliveryTrace?.({
      stage,
      ...trace,
      ...details,
    });
  }

  private async resolveWorkspaceDir(sessionId: string): Promise<string> {
    return this.deps.workspaceResolver
      ? await this.deps.workspaceResolver.getWorkspaceDirForSession(sessionId)
      : process.cwd();
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

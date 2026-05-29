import type {
  SessionInfoUpdateEvent,
  SessionPromptResult,
} from '../../shared/session-adapter-types';
import {
  buildSendWithMediaGatewayParams,
} from '../chat/send-media';
import type {
  RuntimeClockPort,
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
} from '../common/runtime-ports';
import type {
  SessionPromptMediaPayload,
} from './session-runtime-types';
import {
  readPromptSessionRequest,
} from './session-runtime-requests';
import { SessionRuntimeStateStore } from './session-runtime-state';
import { SessionSnapshotService } from './session-snapshot-service';
import { SessionTimelineRuntime } from './session-timeline-runtime';
import {
  badRequest,
  ok,
  type ApplicationResponseOf,
} from '../common/application-response';
import { SessionOperationCoordinator } from './session-operation-coordinator';
import type { CanonicalSessionEvent } from './canonical/canonical-events';
import { OPENCLAW_RUNTIME_PROVIDER_ID, type RuntimeSessionContext } from './runtime-providers/runtime-provider-types';
import { RuntimeProviderRegistry } from './runtime-providers/runtime-provider-registry';


export interface SessionPromptServiceDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  fileSystem: RuntimeFileSystemPort;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  runtimeProviderRegistry: RuntimeProviderRegistry;
  operationCoordinator: SessionOperationCoordinator;
  emitSessionUpdate?: (event: SessionInfoUpdateEvent) => void;
}

/**
 * Prompt 服务的“单一事实源”策略：
 * - runId 由 runtime-host 在收到请求时立即生成，并同步落到 runtime
 *   （activeRunId、pendingTurnKey 都用这个 id），同时作为 chat.send 的
 *   idempotencyKey 透给 Gateway。
 * - 不再保留“已 submit 但 activeRunId 还没绑”的中间态。lifecycle 终态事件
 *   靠 activeRunId 直接匹配，不会被守卫吞掉。
 */
export class SessionPromptService {
  constructor(private readonly deps: SessionPromptServiceDeps) {}

  private emitSessionInfoUpdate(event: SessionInfoUpdateEvent): void {
    this.deps.emitSessionUpdate?.(event);
  }

  private resolveContext(sessionId: string, runtimeProviderId?: string): RuntimeSessionContext {
    if (runtimeProviderId) {
      const profile = this.deps.runtimeProviderRegistry.getProfile(runtimeProviderId);
      return this.deps.runtimeProviderRegistry.resolveSessionContext(sessionId, {
        runtimeProviderId: profile.id,
        protocolId: profile.protocolId,
      });
    }
    return this.deps.runtimeProviderRegistry.resolveSessionContext(sessionId);
  }

  private async failSubmittedPrompt(input: {
    sessionId: string;
    runId: string;
    error: string;
    context?: RuntimeSessionContext;
  }): Promise<void> {
    await this.deps.operationCoordinator.run(input.sessionId, 'prompt', async () => {
      const context = input.context ?? this.resolveContext(input.sessionId);
      const state = this.deps.stateStore.getSessionState(input.sessionId, context);
      if (state.runtime.activeRunId !== input.runId) {
        // 已被 abort/新 prompt/lifecycle 终态覆盖，跳过失败收尾。
        return;
      }
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(input.sessionId, [{
        eventId: `local:lifecycle:${input.sessionId}:${input.runId}:error`,
        type: 'lifecycle',
        protocolId: context.protocolId,
        runtimeProviderId: context.runtimeProviderId,
        source: 'live',
        sessionId: input.sessionId,
        runId: input.runId,
        timestamp: this.deps.clock.nowMs(),
        laneKey: 'main',
        origin: {
          providerEventType: 'local.prompt.failed',
          providerIds: {
            sessionKey: input.sessionId,
            runId: input.runId,
          },
        },
        phase: 'error',
        runPhase: 'error',
        error: input.error,
      }]);
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(input.sessionId, committed.state),
        runtime: committed.runtime,
      };
      await this.deps.stateStore.flushPersistedStore();
      this.emitSessionInfoUpdate({
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

  private startRuntimeSendInBackground(input: {
    directBody: ReturnType<typeof readPromptSessionRequest>['directBody'];
    mediaBody: ReturnType<typeof readPromptSessionRequest>['mediaBody'];
    sessionId: string;
    message: string;
    runId: string;
    runtimeProviderId: string;
  }): void {
    void (async () => {
      const context = this.resolveContext(input.sessionId, input.runtimeProviderId);
      const profile = this.deps.runtimeProviderRegistry.getProfile(context.runtimeProviderId);
      const protocol = this.deps.runtimeProviderRegistry.getProtocol(profile.protocolId);
      const payload = await buildSendWithMediaGatewayParams(this.deps.fileSystem, input.mediaBody
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
      const sendResult = await protocol.createTransport(profile).sendPrompt({
        context,
        message: input.message,
        runId: input.runId,
        payload,
      });

      if (!sendResult.success) {
        await this.failSubmittedPrompt({
          sessionId: input.sessionId,
          runId: input.runId,
          error: sendResult.error ?? 'Failed to prompt session',
          context,
        });
        return;
      }
    })().catch(() => undefined);
  }

  async promptSession(payload: unknown): Promise<ApplicationResponseOf<SessionPromptResult | { success: false; error: string }>> {
    const {
      directBody,
      mediaBody,
      sessionKey,
      message,
      requestedRunId,
      runtimeProviderId,
    } = readPromptSessionRequest(payload);
    const sessionId = sessionKey;
    if (!sessionId) {
      return badRequest('sessionKey is required');
    }
    if (!message.trim() && !(Array.isArray(mediaBody?.media) && mediaBody.media.length > 0)) {
      return badRequest('message is required');
    }

    const runId = requestedRunId || this.deps.idGenerator.randomId();
    const context = this.resolveContext(sessionId, runtimeProviderId || OPENCLAW_RUNTIME_PROVIDER_ID);

    const media = Array.isArray(mediaBody?.media)
      ? mediaBody.media as SessionPromptMediaPayload[]
      : undefined;
    const submitted = await this.deps.operationCoordinator.run(sessionId, 'prompt', async () => {
      await this.deps.timelineRuntime.activateSession(sessionId, {
        resetWindowToLatest: true,
        context,
      });
      const now = this.deps.clock.nowMs();
      const attachedFiles = (media ?? []).map((file) => ({
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize ?? 0,
        preview: file.preview ?? null,
        filePath: file.filePath,
        source: 'user-upload' as const,
      }));
      const events: CanonicalSessionEvent[] = [{
        eventId: `local:user:${sessionId}:${runId}`,
        type: 'message_snapshot',
        protocolId: context.protocolId,
        runtimeProviderId: context.runtimeProviderId,
        source: 'live',
        sessionId,
        runId,
        timestamp: now,
        laneKey: 'main',
        origin: {
          providerEventType: 'local.prompt.user',
          providerIds: {
            sessionKey: sessionId,
            runId,
          },
        },
        role: 'user',
        messageId: runId,
        content: message,
        text: message,
        status: 'final',
        attachedFiles,
      }, {
        eventId: `local:lifecycle:${sessionId}:${runId}:started`,
        type: 'lifecycle',
        protocolId: context.protocolId,
        runtimeProviderId: context.runtimeProviderId,
        source: 'live',
        sessionId,
        runId,
        timestamp: now,
        laneKey: 'main',
        origin: {
          providerEventType: 'local.prompt.started',
          providerIds: {
            sessionKey: sessionId,
            runId,
          },
        },
        phase: 'started',
        runPhase: 'submitted',
        error: null,
      }];
      const committed = this.deps.timelineRuntime.appendCanonicalEvents(sessionId, events);
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionId, committed.state),
        runtime: committed.runtime,
      };
      await this.deps.stateStore.flushPersistedStore();
      return {
        entryKey: snapshot.items.find((item) => item.kind === 'user-message' && item.runId === runId)?.key ?? '',
        snapshot,
      };
    });

    this.startRuntimeSendInBackground({
      directBody,
      mediaBody,
      sessionId,
      message,
      runId,
      runtimeProviderId: context.runtimeProviderId,
    });

    return ok({
      success: true,
      sessionKey: sessionId,
      runId,
      item: submitted.snapshot.items.find((candidate) => candidate.key === submitted.entryKey) ?? null,
      snapshot: submitted.snapshot,
    });
  }
}

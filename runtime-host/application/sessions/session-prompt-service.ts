import type {
  SessionInfoUpdateEvent,
  SessionPromptResult,
} from '../../shared/session-adapter-types';
import {
  sendWithMediaViaGateway,
} from '../chat/send-media';
import type {
  RuntimeClockPort,
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
} from '../common/runtime-ports';
import type { GatewayChatPort, GatewayRpcPort } from '../gateway/gateway-runtime-port';
import type {
  SessionPromptMediaPayload,
} from './session-runtime-types';
import {
  readPromptSessionRequest,
} from './session-runtime-requests';
import { SessionRuntimeStateStore } from './session-runtime-state';
import { SessionSnapshotService } from './session-snapshot-service';
import { SessionTimelineRuntime } from './session-timeline-runtime';
import { ensureSessionVerboseFull } from './session-verbose-config';
import {
  badRequest,
  ok,
  type ApplicationResponseOf,
} from '../common/application-response';
import { SessionOperationCoordinator } from './session-operation-coordinator';

export interface SessionPromptServiceDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  fileSystem: RuntimeFileSystemPort;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>;
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

  private async failSubmittedPrompt(input: {
    sessionKey: string;
    runId: string;
    error: string;
  }): Promise<void> {
    await this.deps.operationCoordinator.run(input.sessionKey, 'prompt', async () => {
      const state = this.deps.stateStore.getSessionState(input.sessionKey);
      if (state.runtime.activeRunId !== input.runId) {
        // 已被 abort/新 prompt/lifecycle 终态覆盖，跳过失败收尾。
        return;
      }
      const committed = this.deps.timelineRuntime.commitSessionTransition(input.sessionKey, {
        runtimePatch: {
          activeRunId: null,
          runPhase: 'error',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          lastError: input.error,
          lastIssue: null,
        },
        activeTransportEpoch: null,
        advanceRunEpoch: true,
      });
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(input.sessionKey, committed.state),
        runtime: committed.runtime,
      };
      await this.deps.stateStore.flushPersistedStore();
      this.emitSessionInfoUpdate({
        sessionUpdate: 'session_info_update',
        sessionKey: input.sessionKey,
        runId: input.runId,
        phase: 'error',
        snapshot,
        error: input.error,
      });
      return snapshot;
    });
  }

  private startGatewaySendInBackground(input: {
    directBody: ReturnType<typeof readPromptSessionRequest>['directBody'];
    mediaBody: ReturnType<typeof readPromptSessionRequest>['mediaBody'];
    sessionKey: string;
    message: string;
    runId: string;
  }): void {
    void (async () => {
      const sendResult = input.mediaBody
        ? await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, {
            ...input.mediaBody,
            sessionKey: input.sessionKey,
            message: input.message,
            idempotencyKey: input.runId,
          })
        : await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, {
            sessionKey: input.sessionKey,
            message: input.message,
            idempotencyKey: input.runId,
            ...(typeof input.directBody.deliver === 'boolean' ? { deliver: input.directBody.deliver } : {}),
          });

      if (!sendResult.success) {
        await this.failSubmittedPrompt({
          sessionKey: input.sessionKey,
          runId: input.runId,
          error: sendResult.error ?? 'Failed to prompt session',
        });
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
    } = readPromptSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!message.trim() && !(Array.isArray(mediaBody?.media) && mediaBody.media.length > 0)) {
      return badRequest('message is required');
    }

    const runId = requestedRunId || this.deps.idGenerator.randomId();

    await ensureSessionVerboseFull(sessionKey, this.deps.gateway, this.deps.stateStore);

    const media = Array.isArray(mediaBody?.media)
      ? mediaBody.media as SessionPromptMediaPayload[]
      : undefined;
    const submitted = await this.deps.operationCoordinator.run(sessionKey, 'prompt', async () => {
      const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
        resetWindowToLatest: true,
      });
      this.deps.stateStore.blockRuns(sessionKey, [
        state.runtime.activeRunId,
        ...state.timelineEntries.map((entry) => entry.runId),
      ]);
      const promptEntry = this.deps.timelineRuntime.buildPromptUserEntry({
        sessionKey,
        runId,
        message,
        media,
      });
      const committed = this.deps.timelineRuntime.commitSessionTransition(sessionKey, {
        timelineEntries: [promptEntry],
        runtimePatch: {
          activeRunId: runId,
          runPhase: 'submitted',
          activeTurnItemKey: null,
          pendingTurnKey: runId,
          pendingTurnLaneKey: 'main',
          lastUserMessageAt: promptEntry.createdAt ?? this.deps.clock.nowMs(),
          lastError: null,
          lastIssue: null,
        },
        activeTransportEpoch: this.deps.stateStore.getLatestConnectedTransportEpoch() || 1,
        resetWindowToLatest: true,
        advanceRunEpoch: true,
      });
      const snapshot = {
        ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, committed.state),
        runtime: committed.runtime,
      };
      await this.deps.stateStore.flushPersistedStore();
      return {
        entryKey: committed.mergedEntries[0]?.key ?? promptEntry.key,
        snapshot,
      };
    });

    this.startGatewaySendInBackground({
      directBody,
      mediaBody,
      sessionKey,
      message,
      runId,
    });

    return ok({
      success: true,
      sessionKey,
      runId,
      item: submitted.snapshot.items.find((candidate) => candidate.key === submitted.entryKey) ?? null,
      snapshot: submitted.snapshot,
    });
  }
}

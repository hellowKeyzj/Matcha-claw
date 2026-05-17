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
import {
  isRecord,
  normalizeString,
} from './session-value-normalization';
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

export class SessionPromptService {
  constructor(private readonly deps: SessionPromptServiceDeps) {}

  private emitSessionInfoUpdate(event: SessionInfoUpdateEvent): void {
    this.deps.emitSessionUpdate?.(event);
  }

  private async bindSubmittedPromptRun(input: {
    sessionKey: string;
    promptId: string;
    runEpoch: number;
    runId: string | null;
  }): Promise<void> {
    await this.deps.operationCoordinator.run(input.sessionKey, 'prompt', async () => {
      const state = this.deps.stateStore.getSessionState(input.sessionKey);
      if (state.runEpoch !== input.runEpoch || !state.runtime.sending) {
        return;
      }
      const committed = this.deps.timelineRuntime.commitSessionTransition(input.sessionKey, {
        runtimePatch: {
          sending: true,
          activeRunId: input.runId,
          runPhase: 'submitted',
          pendingTurnKey: input.runId ? `main:${input.runId}` : `main:prompt:${input.promptId}`,
          pendingTurnLaneKey: 'main',
          lastError: null,
          lastIssue: null,
        },
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
        phase: 'started',
        snapshot,
        error: null,
      });
      return snapshot;
    });
  }

  private async failSubmittedPrompt(input: {
    sessionKey: string;
    runEpoch: number;
    error: string;
  }): Promise<void> {
    await this.deps.operationCoordinator.run(input.sessionKey, 'prompt', async () => {
      const state = this.deps.stateStore.getSessionState(input.sessionKey);
      if (state.runEpoch !== input.runEpoch || !state.runtime.sending) {
        return;
      }
      const committed = this.deps.timelineRuntime.commitSessionTransition(input.sessionKey, {
        runtimePatch: {
          sending: false,
          activeRunId: null,
          runPhase: 'error',
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          pendingFinal: false,
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
        runId: null,
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
    promptId: string;
    runEpoch: number;
  }): void {
    void (async () => {
      const sendResult = input.mediaBody
        ? await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, {
            ...input.mediaBody,
            sessionKey: input.sessionKey,
            message: input.message,
            idempotencyKey: input.promptId,
          })
        : await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, {
            sessionKey: input.sessionKey,
            message: input.message,
            idempotencyKey: input.promptId,
            ...(typeof input.directBody.deliver === 'boolean' ? { deliver: input.directBody.deliver } : {}),
          });

      if (!sendResult.success) {
        await this.failSubmittedPrompt({
          sessionKey: input.sessionKey,
          runEpoch: input.runEpoch,
          error: sendResult.error ?? 'Failed to prompt session',
        });
        return;
      }

      const resultRecord = isRecord(sendResult.result) ? sendResult.result : {};
      const runId = normalizeString(resultRecord.runId) || null;
      await this.bindSubmittedPromptRun({
        sessionKey: input.sessionKey,
        promptId: input.promptId,
        runEpoch: input.runEpoch,
        runId,
      });
    })().catch(() => undefined);
  }

  async promptSession(payload: unknown): Promise<ApplicationResponseOf<SessionPromptResult | { success: false; error: string }>> {
    const {
      directBody,
      mediaBody,
      sessionKey,
      message,
      requestedPromptId,
    } = readPromptSessionRequest(payload);
    if (!sessionKey) {
      return badRequest('sessionKey is required');
    }
    if (!message.trim() && !(Array.isArray(mediaBody?.media) && mediaBody.media.length > 0)) {
      return badRequest('message is required');
    }

    const promptId = requestedPromptId || this.deps.idGenerator.randomId();

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
        promptId,
        message,
        media,
      });
      const committed = this.deps.timelineRuntime.commitSessionTransition(sessionKey, {
        timelineEntries: [promptEntry],
        runtimePatch: {
          sending: true,
          activeRunId: null,
          runPhase: 'submitted',
          activeTurnItemKey: null,
          pendingTurnKey: `main:prompt:${promptId}`,
          pendingTurnLaneKey: 'main',
          pendingFinal: false,
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
        runEpoch: committed.state.runEpoch,
        entryKey: committed.mergedEntries[0]?.key ?? promptEntry.key,
        snapshot,
      };
    });

    this.startGatewaySendInBackground({
      directBody,
      mediaBody,
      sessionKey,
      message,
      promptId,
      runEpoch: submitted.runEpoch,
    });

    return ok({
      success: true,
      sessionKey,
      runId: null,
      promptId,
      item: submitted.snapshot.items.find((candidate) => candidate.key === submitted.entryKey) ?? null,
      snapshot: submitted.snapshot,
    });
  }
}

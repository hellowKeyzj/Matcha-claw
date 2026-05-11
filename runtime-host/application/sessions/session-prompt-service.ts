import type {
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
import type { GatewayChatPort } from '../gateway/gateway-runtime-port';
import {
  createLatestWindowState,
} from './session-window-model';
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
import {
  badRequest,
  ok,
  serverError,
  type ApplicationResponseOf,
} from '../common/application-response';

export interface SessionPromptServiceDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  fileSystem: RuntimeFileSystemPort;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  gateway: GatewayChatPort;
}

export class SessionPromptService {
  constructor(private readonly deps: SessionPromptServiceDeps) {}

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

    const sendResult = mediaBody
      ? await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, {
          ...mediaBody,
          sessionKey,
          message,
          idempotencyKey: promptId,
        })
      : await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, {
          sessionKey,
          message,
          idempotencyKey: promptId,
          ...(typeof directBody.deliver === 'boolean' ? { deliver: directBody.deliver } : {}),
        });

    if (!sendResult.success) {
      return serverError(sendResult.error ?? 'Failed to prompt session');
    }

    const resultRecord = isRecord(sendResult.result) ? sendResult.result : {};
    const runId = normalizeString(resultRecord.runId);
    const media = Array.isArray(mediaBody?.media)
      ? mediaBody.media as SessionPromptMediaPayload[]
      : undefined;
    const state = await this.deps.timelineRuntime.activateSession(sessionKey, {
      resetWindowToLatest: true,
    });
    const [entry] = this.deps.timelineRuntime.upsertTimelineEntries(sessionKey, [this.deps.timelineRuntime.buildPromptUserEntry({
      sessionKey,
      promptId,
      message,
      media,
    })]);
    const runtime = this.deps.timelineRuntime.setSessionRuntime(sessionKey, {
      sending: true,
      activeRunId: runId || null,
      runPhase: 'submitted',
      activeTurnItemKey: null,
      pendingTurnKey: runId ? `main:${runId}` : `main:prompt:${promptId}`,
      pendingTurnLaneKey: 'main',
      pendingFinal: false,
      lastUserMessageAt: entry?.createdAt ?? this.deps.clock.nowMs(),
      lastError: null,
      lastIssue: null,
    });
    state.activeTransportEpoch = this.deps.stateStore.getLatestConnectedTransportEpoch() || 1;
    state.window = createLatestWindowState(state.renderItems.length);
    const snapshot = {
      ...await this.deps.snapshotService.buildLatestSnapshotAsync(sessionKey, state),
      runtime,
    };
    const result: SessionPromptResult = {
      success: true,
      sessionKey,
      runId: runId || null,
      promptId,
      item: snapshot.items.find((candidate) => candidate.key === entry?.key) ?? null,
      snapshot,
    };
    await this.deps.stateStore.flushPersistedStore();
    return ok(result);
  }
}

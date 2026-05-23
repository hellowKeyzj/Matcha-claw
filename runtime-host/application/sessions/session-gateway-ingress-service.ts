import type {
  SessionItemChunkUpdateEvent,
  SessionRenderItem,
  SessionTimelineAssistantTurnEntry,
  SessionUpdateEvent,
} from '../../shared/session-adapter-types';
import { buildSessionUpdateEventsFromGatewayConversationEvent } from './gateway-ingress';
import type {
  GatewaySessionIngressEvent,
  SessionRuntimeActivityIngressEvent,
  SessionToolStatusUpdateIngressEvent,
} from './gateway-ingress-types';
import { SessionRuntimeStateStore } from './session-runtime-state';
import { SessionSnapshotService } from './session-snapshot-service';
import { SessionTimelineRuntime } from './session-timeline-runtime';
import {
  createLatestWindowState,
} from './session-window-model';
import {
  isRecord,
  normalizeString,
} from './session-value-normalization';
import {
  canonicalizeToolName,
  resolveToolRecordCallId,
  resolveToolRecordName,
  isStateOnlyToolName,
} from './state-only-tools';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
  summarizeSessionUpdateForTodoToolDebug,
} from './todo-tool-debug';
import type { RuntimeClockPort } from '../common/runtime-ports';
import type { RuntimeHostLogger } from '../../shared/logger';

export interface SessionGatewayIngressServiceDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  clock: RuntimeClockPort;
  logger?: Pick<RuntimeHostLogger, 'traceDebug'>;
  emitSessionUpdate?: (event: SessionUpdateEvent) => void;
}

export class SessionGatewayIngressService {
  private readonly stateOnlyToolNamesByCallKey = new Map<string, string>();

  constructor(private readonly deps: SessionGatewayIngressServiceDeps) {}

  private buildToolCallKey(sessionKey: string, toolCallId: string): string {
    return `${sessionKey}\n${toolCallId}`;
  }

  private buildRunScopedToolCallKey(sessionKey: string, runId: string, toolCallId: string): string {
    return `${sessionKey}\n${runId}\n${toolCallId}`;
  }

  private rememberStateOnlyToolCall(input: {
    sessionKey: string;
    runId: string;
    toolCallId: string;
    toolName: string;
  }): void {
    if (!input.sessionKey || !input.toolCallId || !isStateOnlyToolName(input.toolName)) {
      return;
    }
    const toolName = canonicalizeToolName(input.toolName);
    this.stateOnlyToolNamesByCallKey.set(this.buildToolCallKey(input.sessionKey, input.toolCallId), toolName);
    if (input.runId) {
      this.stateOnlyToolNamesByCallKey.set(
        this.buildRunScopedToolCallKey(input.sessionKey, input.runId, input.toolCallId),
        toolName,
      );
    }
  }

  private forgetStateOnlyToolCall(input: {
    sessionKey: string;
    runId: string;
    toolCallId: string;
  }): void {
    if (!input.sessionKey || !input.toolCallId) {
      return;
    }
    this.stateOnlyToolNamesByCallKey.delete(this.buildToolCallKey(input.sessionKey, input.toolCallId));
    if (input.runId) {
      this.stateOnlyToolNamesByCallKey.delete(
        this.buildRunScopedToolCallKey(input.sessionKey, input.runId, input.toolCallId),
      );
    }
  }

  private forgetStateOnlyToolCallsForRun(sessionKey: string, runId: string): void {
    if (!sessionKey || !runId) {
      return;
    }
    const prefix = `${sessionKey}\n${runId}\n`;
    for (const key of Array.from(this.stateOnlyToolNamesByCallKey.keys())) {
      if (key.startsWith(prefix)) {
        const [, , toolCallId] = key.split('\n');
        this.stateOnlyToolNamesByCallKey.delete(key);
        if (toolCallId) {
          this.stateOnlyToolNamesByCallKey.delete(this.buildToolCallKey(sessionKey, toolCallId));
        }
      }
    }
  }

  private resolveRememberedStateOnlyToolName(input: {
    sessionKey: string;
    runId: string;
    toolCallId: string;
  }): string {
    if (!input.sessionKey || !input.toolCallId) {
      return '';
    }
    if (input.runId) {
      const scopedName = this.stateOnlyToolNamesByCallKey.get(
        this.buildRunScopedToolCallKey(input.sessionKey, input.runId, input.toolCallId),
      );
      if (scopedName) {
        return scopedName;
      }
    }
    return this.stateOnlyToolNamesByCallKey.get(this.buildToolCallKey(input.sessionKey, input.toolCallId)) ?? '';
  }

  private rememberStateOnlyToolCallsFromChatMessage(payload: Record<string, unknown>): void {
    const event = isRecord(payload.event) ? payload.event : null;
    const message = isRecord(event?.message) ? event.message : null;
    if (!event || !message) {
      return;
    }
    const sessionKey = normalizeString(event.sessionKey);
    const runId = normalizeString(event.runId);
    if (!sessionKey) {
      return;
    }

    const rememberBlock = (block: unknown) => {
      if (!isRecord(block)) {
        return;
      }
      const toolName = resolveToolRecordName(block);
      if (!isStateOnlyToolName(toolName)) {
        return;
      }
      const toolCallId = resolveToolRecordCallId(block);
      this.rememberStateOnlyToolCall({
        sessionKey,
        runId,
        toolCallId,
        toolName,
      });
    };

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        rememberBlock(block);
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const block of message.tool_calls) {
        rememberBlock(block);
      }
    }
    if (Array.isArray(message.toolCalls)) {
      for (const block of message.toolCalls) {
        rememberBlock(block);
      }
    }
  }

  private normalizeGatewayConversationPayload(payload: unknown): unknown {
    if (!isRecord(payload)) {
      return payload;
    }

    if (payload.type === 'run.phase') {
      const sessionKey = normalizeString(payload.sessionKey);
      const runId = normalizeString(payload.runId);
      const phase = normalizeString(payload.phase);
      if (phase === 'completed' || phase === 'error' || phase === 'aborted') {
        this.forgetStateOnlyToolCallsForRun(sessionKey, runId);
      }
      return payload;
    }

    if (payload.type === 'chat.message') {
      this.rememberStateOnlyToolCallsFromChatMessage(payload);
      return payload;
    }

    if (payload.type === 'session.message') {
      return payload;
    }

    if (payload.type !== 'tool.lifecycle' || !isRecord(payload.event)) {
      return payload;
    }

    const sessionKey = normalizeString(payload.event.sessionKey);
    const runId = normalizeString(payload.event.runId);
    const toolCallId = normalizeString(payload.event.toolCallId);
    if (!sessionKey || !toolCallId) {
      return payload;
    }

    const phase = normalizeString(payload.event.phase);
    const rawExplicitName = normalizeString(payload.event.name);
    const explicitName = canonicalizeToolName(rawExplicitName);
    const rememberedName = this.resolveRememberedStateOnlyToolName({
      sessionKey,
      runId,
      toolCallId,
    });
    const resolvedName = explicitName || rememberedName;

    if (phase === 'start' && isStateOnlyToolName(explicitName)) {
      this.rememberStateOnlyToolCall({
        sessionKey,
        runId,
        toolCallId,
        toolName: explicitName,
      });
    }

    if (phase === 'result') {
      this.forgetStateOnlyToolCall({
        sessionKey,
        runId,
        toolCallId,
      });
    }

    if (!resolvedName || rawExplicitName === resolvedName) {
      return payload;
    }

    return {
      ...payload,
      event: {
        ...payload.event,
        name: resolvedName,
      },
    };
  }

  /**
   * 只拦截明确作废的 run。sessionKey 已经决定状态桶，activeRunId 不能再作为
   * Gateway 事件的硬过滤条件，否则本地运行态一旦漂移就会吞掉真实 live 事件。
   */
  private shouldIgnoreNonMessageUpdate(input: {
    sessionKey: string;
    runId: string;
  }): boolean {
    if (!input.runId) {
      return false;
    }
    return this.deps.stateStore.isRunBlocked(input.sessionKey, input.runId);
  }

  /**
   * chat.message 同样只拦截明确作废的 run。消息是否属于当前 session 由
   * sessionKey 隔离，不能再用 activeRunId 做二次否决。
   */
  private shouldIgnoreMessageUpdate(input: {
    sessionKey: string;
    runId: string;
  }): boolean {
    if (!input.runId) {
      return false;
    }
    return this.deps.stateStore.isRunBlocked(input.sessionKey, input.runId);
  }

  private isUnboundTerminalLifecycle(input: {
    runId: string;
    phase?: string;
  }): boolean {
    return !input.runId
      && (
        input.phase === 'final'
        || input.phase === 'error'
        || input.phase === 'aborted'
      );
  }

  private buildCurrentSnapshot(sessionKey: string): ReturnType<SessionSnapshotService['buildSnapshot']> {
    const state = this.deps.stateStore.getSessionState(sessionKey);
    return this.deps.snapshotService.buildSnapshot(sessionKey, state, {
      window: state.window.totalItemCount > 0
        ? state.window
        : createLatestWindowState(state.renderItems.length),
      replayComplete: true,
    });
  }

  private hasTimelineEntryForRun(sessionKey: string, runId: string | null): boolean {
    if (!runId) {
      return false;
    }
    return this.deps.stateStore.getSessionState(sessionKey).timelineEntries.some((entry) => entry.runId === runId);
  }

  private buildItemChunkForTimelineEntry(input: {
    sessionKey: string;
    runId: string | null;
    entry: SessionTimelineAssistantTurnEntry;
  }): SessionItemChunkUpdateEvent {
    const state = this.deps.stateStore.getSessionState(input.sessionKey);
    const snapshot = this.deps.snapshotService.buildSnapshot(input.sessionKey, state, {
      window: state.window.totalItemCount > 0
        ? state.window
        : createLatestWindowState(state.renderItems.length),
      replayComplete: true,
    });
    return {
      sessionUpdate: 'session_item_chunk',
      sessionKey: input.sessionKey,
      runId: input.runId,
      item: this.deps.snapshotService.resolvePrimaryItemFromSnapshot(snapshot, input.entry, [input.entry]) as SessionRenderItem | null,
      snapshot,
    };
  }

  private async reconcileTranscriptToolResults(input: {
    sessionKey: string;
    runId: string | null;
  }): Promise<SessionItemChunkUpdateEvent[]> {
    const updatedEntries = await this.deps.timelineRuntime.reconcileTranscriptToolResults(input.sessionKey);
    return updatedEntries.map((entry) => this.buildItemChunkForTimelineEntry({
      sessionKey: input.sessionKey,
      runId: input.runId,
      entry,
    }));
  }

  private scheduleTranscriptToolResultCatchup(input: {
    sessionKey: string;
    runId: string | null;
  }): void {
    void this.reconcileTranscriptToolResults(input).then((events) => {
      for (const update of events) {
        this.deps.emitSessionUpdate?.(update);
      }
    }).catch(() => undefined);
  }

  private async reconcileSessionTranscriptContent(input: {
    sessionKey: string;
    runId: string | null;
  }): Promise<SessionItemUpdateEvent> {
    const committed = await this.deps.timelineRuntime.reconcileSessionTranscriptContent(input.sessionKey);
    const snapshot = this.deps.snapshotService.buildSnapshot(input.sessionKey, committed.state, {
      window: committed.state.window.totalItemCount > 0
        ? committed.state.window
        : createLatestWindowState(committed.state.renderItems.length),
      replayComplete: true,
    });
    const item = this.deps.snapshotService.resolvePrimaryItemFromSnapshot(
      snapshot,
      committed.mergedEntries[committed.mergedEntries.length - 1] ?? null,
      committed.mergedEntries,
    );
    return {
      sessionUpdate: 'session_item',
      sessionKey: input.sessionKey,
      runId: input.runId,
      item,
      snapshot,
    };
  }

  async consumeGatewayConversationEvent(payload: unknown): Promise<SessionUpdateEvent[]> {
    const normalizedPayload = this.normalizeGatewayConversationPayload(payload);
    logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.normalized-payload', normalizedPayload);
    if (isRecord(normalizedPayload) && normalizedPayload.type === 'session.message' && isRecord(normalizedPayload.event)) {
      const sessionKey = normalizeString(normalizedPayload.event.sessionKey);
      if (!sessionKey) {
        return [];
      }
      this.deps.stateStore.setActiveSessionKey(sessionKey);
      return [await this.reconcileSessionTranscriptContent({
        sessionKey,
        runId: normalizeString(normalizedPayload.event.runId) || null,
      })];
    }
    const currentSessionKey = isRecord(normalizedPayload) && isRecord(normalizedPayload.event) && typeof normalizedPayload.event.sessionKey === 'string'
      ? normalizedPayload.event.sessionKey
      : '';
    const currentState = currentSessionKey ? this.deps.stateStore.getSessionState(currentSessionKey) : null;
    const translated = buildSessionUpdateEventsFromGatewayConversationEvent(normalizedPayload, {
      clock: this.deps.clock,
      existingEntries: currentState?.timelineEntries,
    });
    if (containsTodoToolDebugSignal(normalizedPayload) || containsTodoToolDebugSignal(translated)) {
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.translated-events', translated);
    }
    const outputs: SessionUpdateEvent[] = [];
    for (const event of translated) {
      const translatedOutput = await this.translateIngressEvent(event);
      if (translatedOutput) {
        outputs.push(translatedOutput);
      }
    }
    return outputs;
  }

  private translateRuntimeActivity(event: SessionRuntimeActivityIngressEvent): SessionUpdateEvent | null {
    const sessionKey = normalizeString(event.sessionKey);
    if (!sessionKey) {
      return null;
    }
    if (this.shouldIgnoreNonMessageUpdate({
      sessionKey,
      runId: normalizeString(event.runId),
    })) {
      return null;
    }
    this.deps.stateStore.setActiveSessionKey(sessionKey);
    const committed = this.deps.timelineRuntime.applyRuntimeActivity(sessionKey, {
      activity: event.activity,
      phase: event.phase,
      runId: event.runId,
    });
    const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, committed.state, {
      window: committed.state.window.totalItemCount > 0
        ? committed.state.window
        : createLatestWindowState(committed.state.renderItems.length),
      replayComplete: true,
    });
    return {
      sessionUpdate: 'session_info_update',
      sessionKey: event.sessionKey,
      runId: event.runId,
      phase: 'unknown',
      snapshot,
      error: null,
      ...(event._meta ? { _meta: event._meta } : {}),
    };
  }

  private async translateIngressEvent(event: GatewaySessionIngressEvent): Promise<SessionUpdateEvent | null> {
    if (event.sessionUpdate === 'runtime_activity') {
      return this.translateRuntimeActivity(event);
    }
    if (event.sessionUpdate === 'tool_status_update') {
      return this.translateToolStatusUpdate(event);
    }
    return await this.translateSessionUpdateEvent(event);
  }

  private translateToolStatusUpdate(event: SessionToolStatusUpdateIngressEvent): SessionItemChunkUpdateEvent | null {
    const sessionKey = normalizeString(event.sessionKey);
    if (!sessionKey) {
      return null;
    }
    if (this.shouldIgnoreNonMessageUpdate({
      sessionKey,
      runId: normalizeString(event.runId),
    })) {
      return null;
    }
    const updatedTurn = this.deps.timelineRuntime.applyToolStatus(sessionKey, event);
    if (!updatedTurn) {
      return null;
    }
    const state = this.deps.stateStore.getSessionState(sessionKey);
    const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, state, {
      replayComplete: true,
    });
    const item = this.deps.snapshotService.resolvePrimaryItemFromSnapshot(snapshot, updatedTurn, [updatedTurn]) as SessionRenderItem | null;
    return {
      sessionUpdate: 'session_item_chunk',
      sessionKey: event.sessionKey,
      runId: event.runId,
      item,
      snapshot,
      ...(event._meta ? { _meta: event._meta } : {}),
    };
  }

  private async translateSessionUpdateEvent(
    event: Exclude<GatewaySessionIngressEvent, SessionRuntimeActivityIngressEvent | SessionToolStatusUpdateIngressEvent>,
  ): Promise<SessionUpdateEvent> {
    const sessionKey = normalizeString(event.sessionKey);
    if (!sessionKey) {
      const emptySnapshot = this.deps.snapshotService.buildEmptySnapshot();
      if (event.sessionUpdate === 'session_info_update') {
        const output = {
          sessionUpdate: 'session_info_update' as const,
          sessionKey: event.sessionKey,
          runId: event.runId,
          phase: event.phase,
          snapshot: emptySnapshot,
          error: event.error,
          ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
          ...(event._meta ? { _meta: event._meta } : {}),
        };
        logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
        return output;
      }
      if (event.sessionUpdate === 'plan') {
        return {
          sessionUpdate: 'plan' as const,
          sessionKey: event.sessionKey,
          runId: event.runId,
          taskSnapshot: event.taskSnapshot,
          snapshot: emptySnapshot,
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }
      const output = {
        sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' as const : 'session_item' as const,
        sessionKey: event.sessionKey,
        runId: event.runId,
        item: null,
        snapshot: emptySnapshot,
        ...(event._meta ? { _meta: event._meta } : {}),
      };
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
      return output;
    }
    if (event.sessionUpdate === 'session_info_update') {
      if (this.isUnboundTerminalLifecycle({
        runId: normalizeString(event.runId),
        phase: event.phase,
      })) {
        const output = {
          sessionUpdate: 'session_info_update' as const,
          sessionKey: event.sessionKey,
          runId: event.runId,
          phase: event.phase,
          snapshot: this.buildCurrentSnapshot(sessionKey),
          error: event.error,
          ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
          ...(event._meta ? { _meta: event._meta } : {}),
        };
        logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
        return output;
      }
      if (this.shouldIgnoreNonMessageUpdate({
        sessionKey,
        runId: normalizeString(event.runId),
        phase: event.phase,
      })) {
        if (
          (event.phase === 'final' || event.phase === 'error' || event.phase === 'aborted')
          && this.hasTimelineEntryForRun(sessionKey, normalizeString(event.runId))
        ) {
          this.scheduleTranscriptToolResultCatchup({
            sessionKey,
            runId: event.runId,
          });
        }
        return {
          sessionUpdate: 'session_info_update' as const,
          sessionKey: event.sessionKey,
          runId: event.runId,
          phase: event.phase,
          snapshot: this.buildCurrentSnapshot(sessionKey),
          error: event.error,
          ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }
      this.deps.stateStore.setActiveSessionKey(sessionKey);
      await this.deps.timelineRuntime.resolveLifecycleRuntime(sessionKey, {
        phase: event.phase,
        runId: event.runId,
        error: event.error,
        transportIssue: event.transportIssue,
      });
      const state = this.deps.stateStore.getSessionState(sessionKey);
      const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: true,
      });
      const output = {
        sessionUpdate: 'session_info_update' as const,
        sessionKey: event.sessionKey,
        runId: event.runId,
        phase: event.phase,
        snapshot,
        error: event.error,
        ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
        ...(event._meta ? { _meta: event._meta } : {}),
      };
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
      if (event.phase === 'final' || event.phase === 'error' || event.phase === 'aborted') {
        this.scheduleTranscriptToolResultCatchup({
          sessionKey,
          runId: event.runId,
        });
      }
      return output;
    }

    if (event.sessionUpdate === 'plan') {
      if (this.shouldIgnoreNonMessageUpdate({
        sessionKey,
        runId: normalizeString(event.runId),
      })) {
        const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, this.deps.stateStore.getSessionState(sessionKey), {
          replayComplete: true,
        });
        return {
          sessionUpdate: 'plan' as const,
          sessionKey: event.sessionKey,
          runId: event.runId,
          taskSnapshot: event.taskSnapshot,
          snapshot,
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }
      this.deps.timelineRuntime.updateTaskSnapshot(sessionKey, event.taskSnapshot);
      const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, this.deps.stateStore.getSessionState(sessionKey), {
        replayComplete: true,
      });
      const output = {
        sessionUpdate: 'plan' as const,
        sessionKey: event.sessionKey,
        runId: event.runId,
        taskSnapshot: event.taskSnapshot,
        snapshot: {
          ...snapshot,
          taskSnapshot: event.taskSnapshot,
        },
        ...(event._meta ? { _meta: event._meta } : {}),
      };
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
      return output;
    }

    const state = this.deps.stateStore.getSessionState(sessionKey);
    if (this.shouldIgnoreMessageUpdate({
      sessionKey,
      runId: normalizeString(event.runId),
    })) {
      const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: true,
      });
      return {
        sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' as const : 'session_item' as const,
        sessionKey: event.sessionKey,
        runId: event.runId,
        item: null,
        snapshot,
        ...(event._meta ? { _meta: event._meta } : {}),
      };
    }
    this.deps.stateStore.setActiveSessionKey(sessionKey);
    const previewEntries = event.entries;
    const runtimeSourceEntry = previewEntries[previewEntries.length - 1] ?? null;
    const runtimePatch = runtimeSourceEntry
      ? this.deps.timelineRuntime.resolveMessageRuntimePatch(state, {
          runId: event.runId,
          entry: runtimeSourceEntry,
          sessionUpdate: event.sessionUpdate,
        })
      : null;
    if (
      runtimeSourceEntry
      && event.sessionUpdate === 'agent_message'
      && (runtimeSourceEntry.status === 'final' || runtimeSourceEntry.status === 'error' || runtimeSourceEntry.status === 'aborted')
    ) {
      this.deps.timelineRuntime.closeMissingToolResultsForRun(sessionKey, event.runId);
    }
    const committed = this.deps.timelineRuntime.commitSessionTransition(sessionKey, {
      timelineEntries: event.entries,
      runtimePatch: runtimePatch?.runtimePatch,
      advanceRunEpoch: runtimePatch?.advanceRunEpoch,
      resetWindowToLatest: true,
    });
    const mergedEntries = committed.mergedEntries;
    const committedRuntimeSourceEntry = mergedEntries[mergedEntries.length - 1] ?? runtimeSourceEntry;
    const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, committed.state, {
      window: state.window.totalItemCount > 0
        ? state.window
        : createLatestWindowState(state.renderItems.length),
      replayComplete: true,
    });
    const item = this.deps.snapshotService.resolvePrimaryItemFromSnapshot(snapshot, committedRuntimeSourceEntry, event.entries);
    const output = {
      sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' as const : 'session_item' as const,
      sessionKey: event.sessionKey,
      runId: event.runId,
      item,
      snapshot,
      ...(event._meta ? { _meta: event._meta } : {}),
    };
    logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
    return output;
  }
}

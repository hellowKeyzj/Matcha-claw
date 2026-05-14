import type { SessionUpdateEvent } from '../../shared/session-adapter-types';
import { buildSessionUpdateEventsFromGatewayConversationEvent } from './gateway-ingress';
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

  private shouldIgnoreNonMessageUpdate(input: {
    sessionKey: string;
    runId: string;
    phase?: string;
  }): boolean {
    if (!input.runId) {
      return false;
    }
    if (this.deps.stateStore.isRunBlocked(input.sessionKey, input.runId)) {
      return true;
    }
    const runtime = this.deps.stateStore.getSessionState(input.sessionKey).runtime;
    if (runtime.activeRunId === input.runId) {
      return false;
    }
    if (runtime.sending) {
      return true;
    }
    if (!runtime.activeRunId && (runtime.runPhase === 'aborted' || runtime.runPhase === 'error' || runtime.runPhase === 'done')) {
      return input.phase !== 'aborted';
    }
    return runtime.activeRunId != null;
  }

  private shouldIgnoreMessageUpdate(input: {
    sessionKey: string;
    runId: string;
  }): boolean {
    if (!input.runId) {
      return false;
    }
    if (this.deps.stateStore.isRunBlocked(input.sessionKey, input.runId)) {
      return true;
    }
    const runtime = this.deps.stateStore.getSessionState(input.sessionKey).runtime;
    if (runtime.activeRunId) {
      return runtime.activeRunId !== input.runId;
    }
    if (runtime.sending) {
      return true;
    }
    return runtime.runPhase === 'aborted';
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

  consumeGatewayConversationEvent(payload: unknown): SessionUpdateEvent[] {
    const normalizedPayload = this.normalizeGatewayConversationPayload(payload);
    logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.normalized-payload', normalizedPayload);
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
    return translated.map((event) => {
      const sessionKey = normalizeString(event.sessionKey);
      if (!sessionKey) {
        const emptySnapshot = this.deps.snapshotService.buildEmptySnapshot();
        if (event.sessionUpdate === 'session_info_update') {
          const output = {
            sessionUpdate: 'session_info_update',
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
        const output = {
          sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
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
            sessionUpdate: 'session_info_update',
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
          return {
            sessionUpdate: 'session_info_update',
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
        this.deps.timelineRuntime.resolveLifecycleRuntime(sessionKey, {
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
          sessionUpdate: 'session_info_update',
          sessionKey: event.sessionKey,
          runId: event.runId,
          phase: event.phase,
          snapshot,
          error: event.error,
          ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
          ...(event._meta ? { _meta: event._meta } : {}),
        };
        logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
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
            sessionUpdate: 'plan',
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
          sessionUpdate: 'plan',
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
          sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
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
        sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
        sessionKey: event.sessionKey,
        runId: event.runId,
        item,
        snapshot,
        ...(event._meta ? { _meta: event._meta } : {}),
      };
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.output-event', summarizeSessionUpdateForTodoToolDebug(output));
      return output;
    });
  }
}

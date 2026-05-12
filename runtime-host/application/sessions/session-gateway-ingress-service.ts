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
import type { RuntimeClockPort } from '../common/runtime-ports';

export interface SessionGatewayIngressServiceDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  clock: RuntimeClockPort;
}

export class SessionGatewayIngressService {
  constructor(private readonly deps: SessionGatewayIngressServiceDeps) {}

  consumeGatewayConversationEvent(payload: unknown): SessionUpdateEvent[] {
    const currentSessionKey = isRecord(payload) && isRecord(payload.event) && typeof payload.event.sessionKey === 'string'
      ? payload.event.sessionKey
      : '';
    const currentState = currentSessionKey ? this.deps.stateStore.getSessionState(currentSessionKey) : null;
    const translated = buildSessionUpdateEventsFromGatewayConversationEvent(payload, {
      clock: this.deps.clock,
      existingEntries: currentState?.timelineEntries,
    });
    return translated.map((event) => {
      const sessionKey = normalizeString(event.sessionKey);
      if (!sessionKey) {
        const emptySnapshot = this.deps.snapshotService.buildEmptySnapshot();
        if (event.sessionUpdate === 'session_info_update') {
          return {
            sessionUpdate: 'session_info_update',
            sessionKey: event.sessionKey,
            runId: event.runId,
            phase: event.phase,
            snapshot: emptySnapshot,
            error: event.error,
            ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
            ...(event._meta ? { _meta: event._meta } : {}),
          };
        }
        return {
          sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
          sessionKey: event.sessionKey,
          runId: event.runId,
          item: null,
          snapshot: emptySnapshot,
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }
      if (event.sessionUpdate === 'session_info_update') {
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
        return {
          sessionUpdate: 'session_info_update',
          sessionKey: event.sessionKey,
          runId: event.runId,
          phase: event.phase,
          snapshot,
          error: event.error,
          ...(event.transportIssue !== undefined ? { transportIssue: event.transportIssue } : {}),
          ...(event._meta ? { _meta: event._meta } : {}),
        };
      }

      if (event.sessionUpdate === 'plan') {
        const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, this.deps.stateStore.getSessionState(sessionKey), {
          replayComplete: true,
        });
        return {
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
      }

      const state = this.deps.stateStore.getSessionState(sessionKey);
      this.deps.stateStore.setActiveSessionKey(sessionKey);
      const mergedEntries = this.deps.timelineRuntime.upsertTimelineEntries(sessionKey, event.entries);
      const runtimeSourceEntry = mergedEntries[mergedEntries.length - 1] ?? event.entries[event.entries.length - 1] ?? null;
      if (runtimeSourceEntry) {
        this.deps.timelineRuntime.resolveMessageRuntime(sessionKey, {
          runId: event.runId,
          entry: runtimeSourceEntry,
          sessionUpdate: event.sessionUpdate,
        });
      }
      state.window = createLatestWindowState(state.renderItems.length);
      const snapshot = this.deps.snapshotService.buildSnapshot(sessionKey, state, {
        window: state.window.totalItemCount > 0
          ? state.window
          : createLatestWindowState(state.renderItems.length),
        replayComplete: true,
      });
      const item = this.deps.snapshotService.resolvePrimaryItemFromSnapshot(snapshot, runtimeSourceEntry, event.entries);
      return {
        sessionUpdate: event.sessionUpdate === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
        sessionKey: event.sessionKey,
        runId: event.runId,
        item,
        snapshot,
        ...(event._meta ? { _meta: event._meta } : {}),
      };
    });
  }
}

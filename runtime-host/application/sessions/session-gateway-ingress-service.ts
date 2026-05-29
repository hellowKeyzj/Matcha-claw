import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../gateway/gateway-runtime-port';
import type {
  SessionRenderItem,
  SessionUpdateEvent,
} from '../../shared/session-adapter-types';
import { buildCanonicalApprovalEventsFromGatewayNotification, type CanonicalApprovalNotification } from './canonical/canonical-approval-events';
import { OpenClawV4Adapter, type OpenClawV4ConversationEvent } from './canonical/providers/openclaw-v4-adapter';
import type { CanonicalSessionEvent } from './canonical/canonical-events';
import { buildCanonicalMessageStateKey, buildCanonicalToolStateKey } from './canonical/canonical-reducer';
import { SessionRuntimeStateStore } from './session-runtime-state';
import { SessionSnapshotService } from './session-snapshot-service';
import { SessionTimelineRuntime } from './session-timeline-runtime';
import {
  createLatestWindowState,
} from './session-window-model';
import type { SessionRuntimeTimelineState } from './session-runtime-types';
import {
  isRecord,
} from './session-value-normalization';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
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
  private readonly openClawV4Adapter = new OpenClawV4Adapter();

  constructor(private readonly deps: SessionGatewayIngressServiceDeps) {}

  private controlBase(input: {
    eventId: string;
    sessionId: string;
    providerEventType: string;
    timestamp: number;
    raw?: unknown;
  }): Pick<CanonicalSessionEvent, 'eventId' | 'provider' | 'source' | 'sessionId' | 'timestamp' | 'origin'> {
    return {
      eventId: input.eventId,
      provider: 'openclaw-v4',
      source: 'control',
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      origin: {
        providerEventType: input.providerEventType,
        providerIds: {
          sessionKey: input.sessionId,
        },
        ...(input.raw !== undefined ? { raw: structuredClone(input.raw) } : {}),
      },
    };
  }

  private buildCapabilitiesControlEvent(sessionId: string, capabilities: GatewayCapabilitiesSnapshot): CanonicalSessionEvent {
    return {
      ...this.controlBase({
        eventId: `openclaw-v4:control:capabilities:${sessionId}:${capabilities.updatedAt}`,
        sessionId,
        providerEventType: 'gateway.capabilities.updated',
        timestamp: capabilities.updatedAt,
        raw: capabilities,
      }),
      type: 'control',
      controlType: 'capabilities_updated',
      capabilities: structuredClone(capabilities),
    };
  }

  private buildReadinessControlEvents(sessionId: string, readiness: GatewayControlReadiness, timestamp: number): CanonicalSessionEvent[] {
    const events: CanonicalSessionEvent[] = [];
    if (readiness.capabilities) {
      events.push(this.buildCapabilitiesControlEvent(sessionId, readiness.capabilities));
    }
    events.push({
      ...this.controlBase({
        eventId: `openclaw-v4:control:readiness:${sessionId}:${readiness.phase}:${timestamp}`,
        sessionId,
        providerEventType: 'gateway.control.readiness',
        timestamp,
        raw: readiness,
      }),
      type: 'control',
      controlType: readiness.ready ? 'control_ready' : 'transport_issue',
      ready: readiness.ready,
      phase: readiness.phase,
      ...(readiness.ready ? {} : {
        issue: {
          source: 'runtime',
          message: readiness.error ?? readiness.code ?? 'Gateway control plane unavailable',
          at: timestamp,
          retryable: readiness.retryable,
          ...(readiness.code ? { code: readiness.code } : {}),
          ...(readiness.details !== undefined ? { details: readiness.details } : {}),
          ...(readiness.retryAfterMs !== undefined ? { retryAfterMs: readiness.retryAfterMs } : {}),
        },
      }),
    });
    return events;
  }

  private buildConnectionControlEvents(sessionId: string, payload: GatewayConnectionStatePayload): CanonicalSessionEvent[] {
    const timestamp = payload.updatedAt;
    const baseInput = {
      sessionId,
      timestamp,
      raw: payload,
    };
    const events: CanonicalSessionEvent[] = [];
    if (payload.lastIssue) {
      events.push({
        ...this.controlBase({
          ...baseInput,
          eventId: `openclaw-v4:control:transport-issue:${sessionId}:${payload.transportEpoch}:${payload.lastIssue.at}`,
          providerEventType: 'gateway.transport.issue',
        }),
        type: 'control',
        controlType: 'transport_issue',
        transportEpoch: payload.transportEpoch,
        ready: false,
        phase: payload.state,
        issue: structuredClone(payload.lastIssue),
      });
      return events;
    }
    if (payload.state === 'connected') {
      events.push({
        ...this.controlBase({
          ...baseInput,
          eventId: `openclaw-v4:control:transport-connected:${sessionId}:${payload.transportEpoch}`,
          providerEventType: 'gateway.transport.connected',
        }),
        type: 'control',
        controlType: 'transport_connected',
        transportEpoch: payload.transportEpoch,
        ready: payload.gatewayReady,
        phase: payload.gatewayReady ? 'ready' : 'starting',
      });
      if (payload.gatewayReady) {
        events.push({
          ...this.controlBase({
            ...baseInput,
            eventId: `openclaw-v4:control:ready:${sessionId}:${payload.transportEpoch}`,
            providerEventType: 'gateway.control.ready',
          }),
          type: 'control',
          controlType: 'control_ready',
          transportEpoch: payload.transportEpoch,
          ready: true,
          phase: 'ready',
        });
      }
      return events;
    }
    events.push({
      ...this.controlBase({
        ...baseInput,
        eventId: `openclaw-v4:control:transport-state:${sessionId}:${payload.transportEpoch}:${payload.state}:${timestamp}`,
        providerEventType: 'gateway.transport.state',
      }),
      type: 'control',
      controlType: 'transport_issue',
      transportEpoch: payload.transportEpoch,
      ready: false,
      phase: payload.state,
      issue: {
        source: 'runtime',
        message: payload.lastError || `Gateway ${payload.state}`,
        at: timestamp,
        retryable: payload.state === 'reconnecting',
      },
    });
    return events;
  }

  private resolvePrimaryCanonicalItem(state: SessionRuntimeTimelineState, events: ReadonlyArray<CanonicalSessionEvent>): SessionRenderItem | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      const itemKey = event.type === 'message_snapshot'
        ? state.renderItemKeyIndex.messageItemKeyByCanonicalKey.get(buildCanonicalMessageStateKey(event))
        : (event.type === 'tool_call' || event.type === 'tool_progress' || event.type === 'tool_result')
          ? state.renderItemKeyIndex.toolItemKeyByCanonicalKey.get(buildCanonicalToolStateKey(event))
          : undefined;
      if (!itemKey) {
        continue;
      }
      const itemIndex = state.renderItemIndexByKey.get(itemKey);
      if (itemIndex != null) {
        return state.renderItems[itemIndex] ?? null;
      }
    }
    return state.renderItems[state.renderItems.length - 1] ?? null;
  }

  private commitCanonicalEvents(canonicalEvents: CanonicalSessionEvent[]): SessionUpdateEvent[] {
    if (canonicalEvents.length === 0) {
      return [];
    }
    const sessionId = canonicalEvents[0]?.sessionId ?? '';
    if (!sessionId) {
      return [];
    }
    this.deps.stateStore.setActiveSessionKey(sessionId);
    const committed = this.deps.timelineRuntime.appendCanonicalEvents(sessionId, canonicalEvents);
    void committed;
    const state = this.deps.stateStore.getSessionState(sessionId);
    const snapshot = this.deps.snapshotService.buildSnapshot(sessionId, state, {
      window: state.window.totalItemCount > 0
        ? state.window
        : createLatestWindowState(state.renderItems.length),
      replayComplete: state.canonical.hydrated || canonicalEvents.every((event) => event.source === 'live'),
    });
    const primaryItem = this.resolvePrimaryCanonicalItem(state, canonicalEvents);
    const lastEvent = canonicalEvents[canonicalEvents.length - 1]!;
    if (
      lastEvent.type === 'lifecycle'
      || lastEvent.type === 'runtime_activity'
      || lastEvent.type === 'approval'
      || lastEvent.type === 'team'
      || lastEvent.type === 'usage'
      || lastEvent.type === 'artifact'
      || lastEvent.type === 'control'
    ) {
      return [{
        sessionUpdate: 'session_info_update',
        sessionKey: sessionId,
        runId: lastEvent.runId ?? null,
        phase: lastEvent.type === 'lifecycle' ? lastEvent.phase : 'unknown',
        snapshot,
        error: lastEvent.type === 'lifecycle' ? lastEvent.error : null,
        ...(lastEvent.type === 'lifecycle' && lastEvent.transportIssue !== undefined ? { transportIssue: lastEvent.transportIssue } : {}),
      }];
    }
    if (lastEvent.type === 'plan') {
      return [{
        sessionUpdate: 'plan',
        sessionKey: sessionId,
        runId: lastEvent.runId ?? null,
        taskSnapshot: lastEvent.taskSnapshot,
        snapshot,
      }];
    }
    const isChunk = canonicalEvents.some((event) => (
      (event.type === 'message_snapshot' || event.type === 'thought_snapshot') && event.status === 'streaming'
    )) || canonicalEvents.some((event) => event.type === 'tool_call' || event.type === 'tool_progress');
    return [{
      sessionUpdate: isChunk ? 'session_item_chunk' : 'session_item',
      sessionKey: sessionId,
      runId: lastEvent.runId ?? null,
      item: primaryItem,
      snapshot,
    }];
  }

  consumeGatewayConnectionState(payload: GatewayConnectionStatePayload): SessionUpdateEvent[] {
    const sessionId = this.deps.stateStore.getActiveSessionKey();
    if (!sessionId) {
      return [];
    }
    return this.commitCanonicalEvents(this.buildConnectionControlEvents(sessionId, payload));
  }

  consumeGatewayControlReadiness(readiness: GatewayControlReadiness): SessionUpdateEvent[] {
    const sessionId = this.deps.stateStore.getActiveSessionKey();
    if (!sessionId) {
      return [];
    }
    return this.commitCanonicalEvents(this.buildReadinessControlEvents(sessionId, readiness, this.deps.clock.nowMs()));
  }

  consumeGatewayCapabilities(capabilities: GatewayCapabilitiesSnapshot | null): SessionUpdateEvent[] {
    const sessionId = this.deps.stateStore.getActiveSessionKey();
    if (!sessionId || !capabilities) {
      return [];
    }
    return this.commitCanonicalEvents([this.buildCapabilitiesControlEvent(sessionId, capabilities)]);
  }

  consumeGatewayNotification(notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    const canonicalEvents = buildCanonicalApprovalEventsFromGatewayNotification(notification, this.deps.clock.nowMs());
    return this.commitCanonicalEvents(canonicalEvents);
  }

  async consumeGatewayConversationEvent(payload: unknown): Promise<SessionUpdateEvent[]> {
    if (!isRecord(payload)) {
      return [];
    }
    const canonicalEvents = this.openClawV4Adapter.translate(payload as OpenClawV4ConversationEvent);
    if (containsTodoToolDebugSignal(payload) || containsTodoToolDebugSignal(canonicalEvents)) {
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.canonical-events', canonicalEvents);
    }
    return this.commitCanonicalEvents(canonicalEvents);
  }

}

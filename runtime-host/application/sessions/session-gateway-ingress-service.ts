import type { GatewayCapabilitiesSnapshot, GatewayConnectionStatePayload, GatewayControlReadiness } from '../gateway/gateway-runtime-port';
import type {
  SessionRenderItem,
  SessionUpdateEvent,
} from '../../shared/session-adapter-types';
import type { CanonicalApprovalNotification } from './canonical/canonical-approval-events';
import { OpenClawApprovalAdapter } from './runtime-providers/openclaw/openclaw-approval-adapter';
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
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_PROVIDER_ID, type RuntimeProviderId } from './runtime-providers/runtime-provider-types';
import { RuntimeProviderRegistry } from './runtime-providers/runtime-provider-registry';

export interface SessionGatewayIngressServiceDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  clock: RuntimeClockPort;
  logger?: Pick<RuntimeHostLogger, 'traceDebug'>;
  runtimeProviderRegistry: RuntimeProviderRegistry;
  emitSessionUpdate?: (event: SessionUpdateEvent) => void;
}

export class SessionGatewayIngressService {
  private readonly openClawApprovalAdapter = new OpenClawApprovalAdapter();

  constructor(private readonly deps: SessionGatewayIngressServiceDeps) {}

  private controlBase(input: {
    eventId: string;
    sessionId: string;
    providerEventType: string;
    timestamp: number;
    raw?: unknown;
  }): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeProviderId' | 'source' | 'sessionId' | 'timestamp' | 'origin'> {
    return {
      eventId: input.eventId,
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeProviderId: OPENCLAW_RUNTIME_PROVIDER_ID,
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

  private readProviderEventSessionKey(payload: Record<string, unknown>): string {
    const event = isRecord(payload.event) ? payload.event : null;
    const params = isRecord(payload.params) ? payload.params : null;
    const candidates = [payload.sessionKey, event?.sessionKey, params?.sessionKey];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return this.deps.stateStore.getActiveSessionKey() ?? '';
  }

  consumeProviderNotification(runtimeProviderId: RuntimeProviderId, notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    const profile = this.deps.runtimeProviderRegistry.getProfile(runtimeProviderId);
    if (profile.protocolId !== OPENCLAW_RUNTIME_PROTOCOL_ID) {
      return [];
    }
    const canonicalEvents = this.openClawApprovalAdapter.translateNotification(notification, this.deps.clock.nowMs());
    return this.commitCanonicalEvents(canonicalEvents);
  }

  consumeGatewayNotification(notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    return this.consumeProviderNotification(OPENCLAW_RUNTIME_PROVIDER_ID, notification);
  }

  async consumeProviderConversationEvent(runtimeProviderId: RuntimeProviderId, payload: unknown): Promise<SessionUpdateEvent[]> {
    if (!isRecord(payload)) {
      return [];
    }
    const registry = this.deps.runtimeProviderRegistry;
    const profile = registry.getProfile(runtimeProviderId);
    const protocol = registry.getProtocol(profile.protocolId);
    const sessionKey = this.readProviderEventSessionKey(payload);
    if (!sessionKey) {
      return [];
    }
    const context = registry.resolveSessionContext(sessionKey, {
      protocolId: profile.protocolId,
      runtimeProviderId: profile.id,
    });
    if (!protocol.eventAdapter.canTranslate(payload, context)) {
      return [];
    }
    const canonicalEvents = protocol.eventAdapter.translate(payload, context);
    if (containsTodoToolDebugSignal(payload) || containsTodoToolDebugSignal(canonicalEvents)) {
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.canonical-events', canonicalEvents);
    }
    return this.commitCanonicalEvents(canonicalEvents);
  }

  async consumeGatewayConversationEvent(payload: unknown): Promise<SessionUpdateEvent[]> {
    return await this.consumeProviderConversationEvent(OPENCLAW_RUNTIME_PROVIDER_ID, payload);
  }

}

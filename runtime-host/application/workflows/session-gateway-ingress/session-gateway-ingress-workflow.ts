import {
  buildSessionIdentityKey,
  validateSessionIdentity,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import { MATCHA_AGENT_RUNTIME_PROTOCOL_ID } from '../../adapters/matcha-agent/runtime/matcha-agent-runtime-identity';
import type { RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import type {
  SessionRenderItem,
  SessionUpdateEvent,
} from '../../../shared/session-adapter-types';
import type { CanonicalApprovalNotification } from '../../sessions/canonical/canonical-approval-events';
import type {
  CanonicalLifecycleEvent,
  CanonicalSessionEvent,
} from '../../sessions/canonical/canonical-events';
import { buildCanonicalMessageStateKey, buildCanonicalToolStateKey } from '../../sessions/canonical/canonical-reducer';
import type { RuntimeClockPort } from '../../common/runtime-ports';
import type { RuntimeHostLogger } from '../../../shared/logger';
import type { SessionRuntimeStateStore } from '../../sessions/session-runtime-state';
import type { SessionSnapshotService } from '../../sessions/session-snapshot-service';
import type { SessionTimelineRuntime } from '../../sessions/session-timeline-runtime';
import type { SessionRuntimeTimelineState } from '../../sessions/session-runtime-types';
import { createLatestWindowState } from '../../sessions/session-window-model';
import { isRecord } from '../../sessions/session-value-normalization';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
} from '../../sessions/todo-tool-debug';
import {
  attachMatchaTerminalDeliveryTrace,
  readMatchaTerminalDeliveryTraceContext,
  type MatchaTerminalDeliveryTrace,
} from '../../../shared/matcha-terminal-delivery-trace';

export interface SessionGatewayIngressWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  clock: RuntimeClockPort;
  logger?: Pick<RuntimeHostLogger, 'traceDebug'>;
  terminalDeliveryTrace?: MatchaTerminalDeliveryTrace;
  agentRuntimeRegistry: AgentRuntimeRegistry;
}

export class SessionGatewayIngressWorkflow {
  constructor(private readonly deps: SessionGatewayIngressWorkflowDeps) {}

  consumeEndpointNotification(endpoint: RuntimeEndpointRef, notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    return this.consumeEndpointNotificationByEndpoint(endpoint, notification);
  }

  async consumeEndpointConversationEvent(endpointRef: RuntimeEndpointRef, payload: unknown): Promise<SessionUpdateEvent[]> {
    if (!isRecord(payload)) {
      return [];
    }
    const registry = this.deps.agentRuntimeRegistry;
    const endpoint = registry.resolveEndpointForRef(endpointRef);
    const protocol = registry.getProtocol(endpoint.protocolId);
    const endpointSessionId = this.readEndpointEventSessionKey(payload);
    if (!endpointSessionId) {
      return [];
    }
    const { context, payload: canonicalPayload } = this.resolveEndpointEventContext(endpointRef, endpointSessionId, payload);
    if (!protocol.eventAdapter.canTranslate(canonicalPayload, context)) {
      return [];
    }
    const canonicalEvents = protocol.eventAdapter.translate(canonicalPayload, context);
    if (containsTodoToolDebugSignal(canonicalPayload) || containsTodoToolDebugSignal(canonicalEvents)) {
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.canonical-events', canonicalEvents);
    }
    return this.commitCanonicalEvents(
      canonicalEvents,
      context,
      protocol.protocolId === MATCHA_AGENT_RUNTIME_PROTOCOL_ID
        ? readMatchaTerminalDeliveryTraceContext(payload)
        : null,
    );
  }

  private consumeEndpointNotificationByEndpoint(endpoint: RuntimeEndpointRef, notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    const adapter = this.deps.agentRuntimeRegistry.resolveApprovalNotificationsForEndpoint(endpoint);
    if (!adapter) {
      return [];
    }
    const endpointSessionId = this.readEndpointNotificationSessionKey(notification);
    const aliasedContext = endpointSessionId
      ? this.deps.agentRuntimeRegistry.resolveSessionContextByEndpointSessionId(endpoint, endpointSessionId)
      : null;
    const canonicalEvents = adapter.translateNotification(
      aliasedContext ? this.withEndpointNotificationSessionIdentity(notification, aliasedContext.identity) : notification,
      this.deps.clock.nowMs(),
    );
    const sessionKey = canonicalEvents[0]?.sessionId;
    if (aliasedContext) {
      return this.commitCanonicalEvents(canonicalEvents, aliasedContext);
    }
    const agentId = sessionKey ? this.readAgentIdFromSessionKey(sessionKey) : '';
    if (sessionKey && !agentId) {
      throw new Error('Session approval notification requires agentId metadata');
    }
    const context = sessionKey
      ? this.deps.agentRuntimeRegistry.rememberSessionIdentity(
        this.buildSessionIdentity(endpoint, sessionKey, agentId),
        endpointSessionId,
      )
      : undefined;
    return this.commitCanonicalEvents(canonicalEvents, context);
  }

  private commitCanonicalEvents(
    canonicalEvents: CanonicalSessionEvent[],
    context?: RuntimeSessionContext,
    terminalTrace = null,
  ): SessionUpdateEvent[] {
    if (canonicalEvents.length === 0) {
      return [];
    }
    const sessionId = canonicalEvents[0]?.sessionId ?? '';
    if (!sessionId) {
      return [];
    }
    this.deps.stateStore.setActiveSessionKey(sessionId);
    const committed = this.deps.timelineRuntime.appendCanonicalEvents(sessionId, canonicalEvents, context);
    void committed;
    const state = this.deps.stateStore.getSessionState(sessionId, context);
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
      const lifecycleEvent = this.resolveSessionInfoLifecycleEvent(canonicalEvents);
      const update = {
        sessionUpdate: 'session_info_update' as const,
        sessionKey: sessionId,
        runId: lastEvent.runId ?? null,
        phase: lifecycleEvent?.phase ?? 'unknown',
        snapshot,
        error: lifecycleEvent?.error ?? null,
        ...(lifecycleEvent?.transportIssue !== undefined ? { transportIssue: lifecycleEvent.transportIssue } : {}),
      };
      if (terminalTrace && lifecycleEvent?.phase === terminalTrace.terminalPhase) {
        this.deps.terminalDeliveryTrace?.({
          stage: 'canonical_terminal_applied',
          ...terminalTrace,
        });
        return [attachMatchaTerminalDeliveryTrace(update, terminalTrace)];
      }
      return [update];
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
      (event.type === 'message_part' || event.type === 'thought') && event.status === 'streaming'
    )) || canonicalEvents.some((event) => event.type === 'tool' && (event.phase === 'started' || event.phase === 'updated'));
    return [{
      sessionUpdate: isChunk ? 'session_item_chunk' : 'session_item',
      sessionKey: sessionId,
      runId: lastEvent.runId ?? null,
      item: primaryItem,
      snapshot,
    }];
  }

  private resolveSessionInfoLifecycleEvent(events: ReadonlyArray<CanonicalSessionEvent>): CanonicalLifecycleEvent | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type === 'lifecycle') {
        return event;
      }
    }
    return null;
  }

  private resolvePrimaryCanonicalItem(state: SessionRuntimeTimelineState, events: ReadonlyArray<CanonicalSessionEvent>): SessionRenderItem | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      const itemKey = event.type === 'message_part'
        ? state.renderItemKeyIndex.messageItemKeyByCanonicalKey.get(buildCanonicalMessageStateKey(event))
        : event.type === 'tool'
          ? state.renderItemKeyIndex.toolItemKeyByCanonicalKey.get(buildCanonicalToolStateKey(event))
          : undefined;
      if (itemKey) {
        const itemIndex = state.renderItemIndexByKey.get(itemKey);
        if (itemIndex != null) {
          return state.renderItems[itemIndex] ?? null;
        }
      }
      if (event.type === 'thought') {
        const laneKey = event.laneKey || 'main';
        for (let itemIndex = state.renderItems.length - 1; itemIndex >= 0; itemIndex -= 1) {
          const item = state.renderItems[itemIndex];
          if (item?.kind === 'assistant-turn' && item.runId === event.runId && item.laneKey === laneKey) {
            return item;
          }
        }
      }
    }
    return state.renderItems[state.renderItems.length - 1] ?? null;
  }

  private resolveEndpointEventContext(
    endpointRef: RuntimeEndpointRef,
    endpointSessionId: string,
    payload: Record<string, unknown>,
  ): { context: RuntimeSessionContext; payload: Record<string, unknown> } {
    const aliasedContext = this.deps.agentRuntimeRegistry.resolveSessionContextByEndpointSessionId(endpointRef, endpointSessionId);
    if (aliasedContext) {
      return {
        context: aliasedContext,
        payload: this.withEndpointEventSessionIdentity(payload, aliasedContext.identity),
      };
    }
    const identity = this.resolveEventSessionIdentity(endpointRef, endpointSessionId, payload);
    const payloadSessionIdentity = this.readEndpointEventSessionIdentity(payload);
    if (payloadSessionIdentity && buildSessionIdentityKey(payloadSessionIdentity) !== buildSessionIdentityKey(identity)) {
      throw new Error('SessionIdentity payload does not match endpoint ingress identity');
    }
    return {
      context: this.deps.agentRuntimeRegistry.rememberSessionIdentity(identity, endpointSessionId),
      payload: this.withEndpointEventSessionIdentity(payload, identity),
    };
  }

  private withEndpointEventSessionIdentity(payload: Record<string, unknown>, identity: SessionIdentity): Record<string, unknown> {
    const event = isRecord(payload.event) ? payload.event : null;
    const params = isRecord(payload.params) ? payload.params : null;
    return {
      ...payload,
      sessionKey: identity.sessionKey,
      sessionIdentity: identity,
      ...(event ? { event: { ...event, sessionKey: identity.sessionKey, sessionIdentity: identity } } : {}),
      ...(params ? { params: { ...params, sessionKey: identity.sessionKey, sessionIdentity: identity } } : {}),
    };
  }

  private withEndpointNotificationSessionIdentity(notification: CanonicalApprovalNotification, identity: SessionIdentity): CanonicalApprovalNotification {
    const params = isRecord(notification.params) ? notification.params : null;
    const data = isRecord(params?.data) ? params.data : null;
    const request = isRecord(params?.request) ? params.request : (isRecord(data?.request) ? data.request : null);
    return {
      ...notification,
      ...(params
        ? {
            params: {
              ...params,
              sessionKey: identity.sessionKey,
              sessionIdentity: identity,
              ...(data ? { data: { ...data, sessionKey: identity.sessionKey, sessionIdentity: identity } } : {}),
              ...(request ? { request: { ...request, sessionKey: identity.sessionKey, sessionIdentity: identity } } : {}),
            },
          }
        : {}),
    };
  }

  private readEndpointNotificationSessionKey(notification: CanonicalApprovalNotification): string {
    const params = isRecord(notification.params) ? notification.params : null;
    const data = isRecord(params?.data) ? params.data : null;
    const request = isRecord(params?.request) ? params.request : (isRecord(data?.request) ? data.request : null);
    const candidates = [
      params?.sessionKey,
      data?.sessionKey,
      request?.sessionKey,
      this.readSessionIdentityKey(params?.sessionIdentity),
      this.readSessionIdentityKey(data?.sessionIdentity),
      this.readSessionIdentityKey(request?.sessionIdentity),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return '';
  }

  private readSessionIdentityKey(value: unknown): string {
    return isRecord(value) && typeof value.sessionKey === 'string' && value.sessionKey.trim()
      ? value.sessionKey.trim()
      : '';
  }

  private readEndpointEventSessionKey(payload: Record<string, unknown>): string {
    const event = isRecord(payload.event) ? payload.event : null;
    const params = isRecord(payload.params) ? payload.params : null;
    const candidates = [payload.sessionKey, event?.sessionKey, params?.sessionKey];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return '';
  }

  private resolveEventSessionIdentity(endpoint: RuntimeEndpointRef, sessionKey: string, payload: Record<string, unknown>): SessionIdentity {
    const payloadIdentity = this.readEndpointEventSessionIdentity(payload);
    if (payloadIdentity) {
      return payloadIdentity;
    }
    const agentId = this.readAgentIdFromSessionKey(sessionKey);
    if (!agentId) {
      throw new Error('Session event requires agentId metadata');
    }
    return this.buildSessionIdentity(endpoint, sessionKey, agentId);
  }

  private buildSessionIdentity(endpoint: RuntimeEndpointRef, sessionKey: string, agentId: string): SessionIdentity {
    return {
      endpoint,
      agentId,
      sessionKey,
    };
  }

  private readAgentIdFromSessionKey(sessionKey: string): string {
    const parts = sessionKey.trim().split(':');
    return parts[0] === 'agent' && parts[1]?.trim() ? parts[1].trim() : '';
  }

  private readEndpointEventSessionIdentity(payload: Record<string, unknown>): SessionIdentity | null {
    const event = isRecord(payload.event) ? payload.event : null;
    const params = isRecord(payload.params) ? payload.params : null;
    const candidates = [payload.sessionIdentity, event?.sessionIdentity, params?.sessionIdentity];
    for (const candidate of candidates) {
      if (candidate === undefined) {
        continue;
      }
      const error = validateSessionIdentity(candidate);
      if (error) {
        throw new Error(error);
      }
      return candidate as SessionIdentity;
    }
    return null;
  }
}

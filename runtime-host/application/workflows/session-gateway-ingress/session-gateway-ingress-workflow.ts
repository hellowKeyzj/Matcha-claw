import {
  buildSessionIdentityKey,
  validateSessionIdentity,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../../agent-runtime/contracts/runtime-address';
import type { AgentRuntimeRegistry } from '../../agent-runtime/contracts/agent-runtime-registry';
import type { RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import type {
  SessionRenderItem,
  SessionUpdateEvent,
} from '../../../shared/session-adapter-types';
import type { CanonicalApprovalNotification } from '../../sessions/canonical/canonical-approval-events';
import type { CanonicalSessionEvent } from '../../sessions/canonical/canonical-events';
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

export interface SessionGatewayIngressWorkflowDeps {
  stateStore: SessionRuntimeStateStore;
  timelineRuntime: SessionTimelineRuntime;
  snapshotService: SessionSnapshotService;
  clock: RuntimeClockPort;
  logger?: Pick<RuntimeHostLogger, 'traceDebug'>;
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
    const sessionKey = this.readEndpointEventSessionKey(payload);
    if (!sessionKey) {
      return [];
    }
    const identity = this.resolveEventSessionIdentity(endpointRef, sessionKey, payload);
    const payloadSessionIdentity = this.readEndpointEventSessionIdentity(payload);
    if (payloadSessionIdentity && buildSessionIdentityKey(payloadSessionIdentity) !== buildSessionIdentityKey(identity)) {
      throw new Error('SessionIdentity payload does not match endpoint ingress identity');
    }
    const context = registry.rememberSessionIdentity(identity);
    if (!protocol.eventAdapter.canTranslate(payload, context)) {
      return [];
    }
    const canonicalEvents = protocol.eventAdapter.translate(payload, context);
    if (containsTodoToolDebugSignal(payload) || containsTodoToolDebugSignal(canonicalEvents)) {
      logTodoToolDebug(this.deps.logger, 'runtime-host.ingress.canonical-events', canonicalEvents);
    }
    return this.commitCanonicalEvents(canonicalEvents, context);
  }

  private consumeEndpointNotificationByEndpoint(endpoint: RuntimeEndpointRef, notification: CanonicalApprovalNotification): SessionUpdateEvent[] {
    const adapter = this.deps.agentRuntimeRegistry.resolveApprovalNotificationsForEndpoint(endpoint);
    if (!adapter) {
      return [];
    }
    const canonicalEvents = adapter.translateNotification(notification, this.deps.clock.nowMs());
    const sessionKey = canonicalEvents[0]?.sessionId;
    const agentId = sessionKey ? this.readAgentIdFromSessionKey(sessionKey) : '';
    if (sessionKey && !agentId) {
      throw new Error('Session approval notification requires agentId metadata');
    }
    const context = sessionKey
      ? this.deps.agentRuntimeRegistry.rememberSessionIdentity(this.buildSessionIdentity(endpoint, sessionKey, agentId))
      : undefined;
    return this.commitCanonicalEvents(canonicalEvents, context);
  }

  private commitCanonicalEvents(canonicalEvents: CanonicalSessionEvent[], context?: RuntimeSessionContext): SessionUpdateEvent[] {
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

  private readEndpointEventSessionKey(payload: Record<string, unknown>): string {
    const event = isRecord(payload.event) ? payload.event : null;
    const params = isRecord(payload.params) ? payload.params : null;
    const payloadIdentity = this.readEndpointEventSessionIdentity(payload);
    const candidates = [payload.sessionKey, event?.sessionKey, params?.sessionKey, payloadIdentity?.sessionKey];
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

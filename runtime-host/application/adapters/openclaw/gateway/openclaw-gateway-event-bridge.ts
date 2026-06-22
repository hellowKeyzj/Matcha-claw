import {
  createGatewayClient,
  type GatewayConnectionStatePayload,
} from '../../../../openclaw-bridge';
import {
  DEFAULT_GATEWAY_BASE_METHODS,
  type GatewayCapabilitiesSnapshot,
  type GatewayControlReadiness,
} from '../../../gateway/gateway-runtime-port';
import type { RuntimeEndpointControlStateSummary } from '../../../../shared/runtime-topology';
import type { GatewayConversationEvent } from '../../../../openclaw-bridge/events';
import type { ParentTransportClient } from '../../../../composition/parent-transport-client';
import type { RuntimeRouteResponse } from '../../../../api/dispatch/runtime-route-dispatcher';
import type {
  RuntimeClockPort,
  RuntimeIdGeneratorPort,
  RuntimePlatform,
  RuntimeSchedulerPort,
  RuntimeTcpProbePort,
} from '../../../common/runtime-ports';
import type {
  GatewayDeviceCryptoPort,
  GatewayDeviceIdentityRepositoryPort,
} from '../../../../openclaw-bridge/client-auth-ports';
import type { RuntimeHostLogger } from '../../../../shared/logger';
import type { SessionUpdateEvent } from '../../../../shared/session-adapter-types';
import type { RuntimeEndpointRef, SessionIdentity } from '../../../agent-runtime/contracts/runtime-address';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
  summarizeSessionUpdateForTodoToolDebug,
} from '../../../sessions/todo-tool-debug';
import { GatewayAutoRecovery } from '../../../../composition/gateway-auto-recovery';

function createRuntimeHostCapabilityPayload(endpoint: RuntimeEndpointRef, operationId: string, input: Record<string, unknown> = {}) {
  return {
    id: 'runtime.host',
    operationId,
    scope: { kind: 'runtime-instance' as const, endpoint },
    target: { kind: 'runtime-endpoint' as const },
    input,
  };
}

export interface GatewaySessionRuntimePort {
  consumeEndpointConversationEvent(endpoint: RuntimeEndpointRef, payload: GatewayConversationEvent & { sessionIdentity: SessionIdentity }): Promise<unknown[]>;
  consumeEndpointNotification(endpoint: RuntimeEndpointRef, payload: unknown): unknown[];
}

export interface RuntimeEndpointControlStatePatch {
  readonly endpoint: RuntimeEndpointRef;
  readonly connection?: GatewayConnectionStatePayload | null;
  readonly readiness?: GatewayControlReadiness | null;
  readonly capabilities?: GatewayCapabilitiesSnapshot | null;
  readonly updatedAt: number;
}

export interface RuntimeEndpointControlStatePort {
  updateRuntimeEndpointControlState(input: RuntimeEndpointControlStatePatch): RuntimeEndpointControlStateSummary;
}

export interface RuntimeHostGatewayBridgeDeps {
  readonly parentTransport: Pick<ParentTransportClient, 'requestParentShellAction' | 'emitParentGatewayEvent'>;
  readonly dispatchRoute: (method: string, route: string, payload: unknown) => Promise<RuntimeRouteResponse | null>;
  readonly getSessionRuntime: () => GatewaySessionRuntimePort | null;
  readonly endpointControlState: RuntimeEndpointControlStatePort;
  readonly runtimeHostEndpoint: RuntimeEndpointRef;
  readonly runtimeHostDataDir: string;
  readonly gatewayPort: number;
  readonly readGatewayToken: () => Promise<string>;
  readonly platform: RuntimePlatform;
  readonly clock: RuntimeClockPort;
  readonly idGenerator: RuntimeIdGeneratorPort;
  readonly identityRepository: GatewayDeviceIdentityRepositoryPort;
  readonly deviceCrypto: GatewayDeviceCryptoPort;
  readonly scheduler: RuntimeSchedulerPort;
  readonly tcpProbe: RuntimeTcpProbePort;
  readonly logger?: RuntimeHostLogger;
}

function readConversationEventSessionKey(payload: GatewayConversationEvent): string {
  const event = 'event' in payload ? payload.event : payload;
  const sessionKey = event.sessionKey;
  return typeof sessionKey === 'string' && sessionKey.trim()
    ? sessionKey.trim()
    : '__unknown_session__';
}

function readOpenClawAgentIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.trim().split(':');
  return parts[0] === 'agent' && parts[1]?.trim() ? parts[1].trim() : '';
}

function toSessionIdentity(endpoint: RuntimeEndpointRef, sessionKey: string): SessionIdentity {
  return {
    endpoint,
    agentId: readOpenClawAgentIdFromSessionKey(sessionKey),
    sessionKey,
  };
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const MAX_PENDING_RUNTIME_EVENTS = 1000;
const MAX_RUN_SESSION_INDEX_ENTRIES = 1000;

export function createRuntimeHostGatewayClient(deps: RuntimeHostGatewayBridgeDeps) {
  let latestObservedTransportEpoch = 0;
  const conversationEventChains = new Map<string, Promise<void>>();
  const pendingConversationEventsBySessionKey = new Map<string, GatewayConversationEvent[]>();
  const runSessionKeyByRunId = new Map<string, string>();
  const pendingNotifications: unknown[] = [];
  const runtimeHostEndpoint = deps.runtimeHostEndpoint;
  let pendingConversationEventCount = 0;
  let pendingNotificationHead = 0;

  const emitSessionUpdates = (sessionUpdates: unknown[]): void => {
    for (const sessionUpdate of sessionUpdates) {
      autoRecovery.observe(sessionUpdate as SessionUpdateEvent);
      void deps.parentTransport.emitParentGatewayEvent('session:update', sessionUpdate).catch(() => undefined);
    }
  };

  const readPendingRuntimeEventCount = (): number => {
    return pendingConversationEventCount + pendingNotifications.length - pendingNotificationHead;
  };

  const hasPendingRuntimeEvents = (): boolean => {
    return readPendingRuntimeEventCount() > 0;
  };

  const canEnqueuePendingRuntimeEvent = (eventKind: string, sessionKey?: string): boolean => {
    if (readPendingRuntimeEventCount() < MAX_PENDING_RUNTIME_EVENTS) {
      return true;
    }
    deps.logger?.warn('[gateway-event-bridge] pending runtime event queue full', {
      eventKind,
      ...(sessionKey ? { sessionKey } : {}),
      maxPendingRuntimeEvents: MAX_PENDING_RUNTIME_EVENTS,
    });
    return false;
  };

  const enqueuePendingNotification = (notification: unknown): void => {
    if (!canEnqueuePendingRuntimeEvent('notification')) {
      return;
    }
    pendingNotifications.push(notification);
  };

  const enqueuePendingConversationEvent = (sessionKey: string, payload: GatewayConversationEvent): void => {
    if (!canEnqueuePendingRuntimeEvent('conversation', sessionKey)) {
      return;
    }
    const pendingSessionEvents = pendingConversationEventsBySessionKey.get(sessionKey) ?? [];
    pendingSessionEvents.push(payload);
    pendingConversationEventsBySessionKey.set(sessionKey, pendingSessionEvents);
    pendingConversationEventCount += 1;
  };

  const rememberRunSessionKey = (payload: GatewayConversationEvent, sessionKey: string): void => {
    const event = 'event' in payload ? payload.event : payload;
    const runId = readTrimmedString(event.runId);
    if (!runId || !sessionKey || sessionKey === '__unknown_session__') {
      return;
    }
    if (!runSessionKeyByRunId.has(runId) && runSessionKeyByRunId.size >= MAX_RUN_SESSION_INDEX_ENTRIES) {
      const oldestRunId = runSessionKeyByRunId.keys().next().value;
      if (typeof oldestRunId === 'string') {
        runSessionKeyByRunId.delete(oldestRunId);
      }
    }
    runSessionKeyByRunId.set(runId, sessionKey);
  };

  const resolveConversationEventSessionKey = (payload: GatewayConversationEvent): string => {
    const explicitSessionKey = readConversationEventSessionKey(payload);
    if (explicitSessionKey !== '__unknown_session__') {
      rememberRunSessionKey(payload, explicitSessionKey);
      return explicitSessionKey;
    }
    const event = 'event' in payload ? payload.event : payload;
    const runId = readTrimmedString(event.runId);
    return (runId ? runSessionKeyByRunId.get(runId) : undefined) ?? explicitSessionKey;
  };

  const consumeConversationEvent = async (runtime: GatewaySessionRuntimePort, sessionKey: string, payload: GatewayConversationEvent): Promise<void> => {
    const sessionUpdates = await runtime.consumeEndpointConversationEvent(runtimeHostEndpoint, {
      ...payload,
      sessionIdentity: toSessionIdentity(runtimeHostEndpoint, sessionKey),
    });
    for (const sessionUpdate of sessionUpdates) {
      if (containsTodoToolDebugSignal(sessionUpdate)) {
        logTodoToolDebug(
          deps.logger,
          'runtime-host.emit-session-update',
          summarizeSessionUpdateForTodoToolDebug(sessionUpdate as SessionUpdateEvent),
        );
      }
    }
    emitSessionUpdates(sessionUpdates);
  };

  const flushPendingRuntimeEvents = async (runtime: GatewaySessionRuntimePort | null): Promise<void> => {
    if (!runtime) {
      return;
    }
    while (pendingNotificationHead < pendingNotifications.length) {
      const notification = pendingNotifications[pendingNotificationHead];
      pendingNotificationHead += 1;
      emitSessionUpdates(runtime.consumeEndpointNotification(runtimeHostEndpoint, notification));
    }
    pendingNotifications.length = 0;
    pendingNotificationHead = 0;

    for (const sessionKey of Array.from(pendingConversationEventsBySessionKey.keys())) {
      const pendingSessionEvents = pendingConversationEventsBySessionKey.get(sessionKey) ?? [];
      pendingConversationEventsBySessionKey.delete(sessionKey);
      pendingConversationEventCount -= pendingSessionEvents.length;
      for (const payload of pendingSessionEvents) {
        try {
          await consumeConversationEvent(runtime, sessionKey, payload);
        } catch (error) {
          deps.logger?.warn('[gateway-event-bridge] conversation event ingress failed', {
            sessionKey,
            error: String(error),
          });
        }
      }
    }
  };

  const enqueueConversationEvent = (payload: GatewayConversationEvent): void => {
    const sessionKey = resolveConversationEventSessionKey(payload);
    const runtimeAtEnqueue = deps.getSessionRuntime();
    if (!runtimeAtEnqueue) {
      enqueuePendingConversationEvent(sessionKey, payload);
      return;
    }
    const previous = conversationEventChains.get(sessionKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      const runtime = deps.getSessionRuntime();
      if (!runtime) {
        enqueuePendingConversationEvent(sessionKey, payload);
        return;
      }
      if (hasPendingRuntimeEvents()) {
        await flushPendingRuntimeEvents(runtime);
      }
      await consumeConversationEvent(runtime, sessionKey, payload);
    }).catch((error) => {
      deps.logger?.warn('[gateway-event-bridge] conversation event ingress failed', {
        sessionKey,
        error: String(error),
      });
    });
    conversationEventChains.set(sessionKey, next);
    void next.finally(() => {
      if (conversationEventChains.get(sessionKey) === next) {
        conversationEventChains.delete(sessionKey);
      }
    });
  };

  const requestGatewayRestart = async (reason: string): Promise<void> => {
    const result = await deps.parentTransport.requestParentShellAction('gateway_restart', { reason });
    if (!result.success) {
      throw new Error(result.error.message);
    }
    if (result.status >= 400) {
      throw new Error(`Gateway restart request failed: HTTP ${String(result.status)}`);
    }
  };

  const autoRecovery = new GatewayAutoRecovery({
    requestRestart: requestGatewayRestart,
    logger: deps.logger,
  });

  const gatewayClient = createGatewayClient({
    runtimeHostDataDir: deps.runtimeHostDataDir,
    gatewayPort: deps.gatewayPort,
    readGatewayToken: deps.readGatewayToken,
    platform: deps.platform,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
    identityRepository: deps.identityRepository,
    deviceCrypto: deps.deviceCrypto,
    scheduler: deps.scheduler,
    tcpProbe: deps.tcpProbe,
    logger: deps.logger,
    onGatewayNotification: (notification) => {
      const runtime = deps.getSessionRuntime();
      if (!runtime) {
        enqueuePendingNotification(notification);
        return;
      }
      void flushPendingRuntimeEvents(runtime).then(() => {
        emitSessionUpdates(runtime.consumeEndpointNotification(runtimeHostEndpoint, notification));
      }).catch((error) => {
        deps.logger?.warn('[gateway-event-bridge] notification ingress failed', {
          error: String(error),
        });
      });
    },
    onGatewayConversationEvent: (payload) => {
      logTodoToolDebug(deps.logger, 'gateway.raw-conversation-event', payload);
      enqueueConversationEvent(payload);
    },
    onGatewayChannelStatus: (payload) => {
      void deps.parentTransport.emitParentGatewayEvent('gateway:channel-status', payload).catch(() => undefined);
    },
    onGatewayError: (error) => {
      void gatewayClient.readGatewayConnectionState().then((snapshot) => {
        return deps.parentTransport.emitParentGatewayEvent('gateway:error', {
          message: error.message,
          ...(snapshot.lastIssue ? { issue: snapshot.lastIssue } : {}),
        });
      }).catch(() => {
        return deps.parentTransport.emitParentGatewayEvent('gateway:error', { message: error.message });
      }).catch(() => undefined);
    },
    onGatewayConnectionState: (payload: GatewayConnectionStatePayload) => {
      // 任何状态变化都向 main push，让 host-event-bridge 重新组装完整 PublicGatewayStatus 推到 renderer，
      // 替代 renderer 30s 轮询 /api/gateway/status 的盲区兜底。
      void deps.parentTransport.emitParentGatewayEvent('gateway:lifecycle', payload).catch(() => undefined);

      deps.endpointControlState.updateRuntimeEndpointControlState({
        endpoint: deps.runtimeHostEndpoint,
        connection: payload,
        updatedAt: payload.updatedAt,
      });

      if (payload.state !== 'connected') {
        return;
      }
      if (payload.transportEpoch <= latestObservedTransportEpoch) {
        return;
      }
      latestObservedTransportEpoch = payload.transportEpoch;
      autoRecovery.reset();
      void deps.dispatchRoute(
        'POST',
        '/api/capabilities/execute',
        createRuntimeHostCapabilityPayload(deps.runtimeHostEndpoint, 'runtimeHost.gatewayLifecycle', {
          state: 'running',
          transportEpoch: payload.transportEpoch,
          updatedAt: deps.clock.nowMs(),
        }),
      ).catch(() => undefined);
      const observedTransportEpoch = payload.transportEpoch;
      void gatewayClient.inspectGatewayControlReadiness(DEFAULT_GATEWAY_BASE_METHODS).then((readiness) => {
        if (observedTransportEpoch !== latestObservedTransportEpoch) {
          return;
        }
        deps.endpointControlState.updateRuntimeEndpointControlState({
          endpoint: deps.runtimeHostEndpoint,
          readiness,
          capabilities: readiness.capabilities ?? null,
          updatedAt: deps.clock.nowMs(),
        });
      }).catch(() => undefined);
    },
    requestGatewayRestart: requestGatewayRestart,
  });

  return gatewayClient;
}

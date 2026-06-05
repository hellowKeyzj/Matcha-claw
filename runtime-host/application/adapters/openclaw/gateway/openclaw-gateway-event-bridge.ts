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
import type { RuntimeAddress } from '../../../agent-runtime/contracts/runtime-address';
import { SESSION_PROMPT_CAPABILITY_ID } from '../../../capabilities/session/session-prompt-capability';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
  summarizeSessionUpdateForTodoToolDebug,
} from '../../../sessions/todo-tool-debug';
import { GatewayAutoRecovery } from '../../../../composition/gateway-auto-recovery';

function createRuntimeHostCapabilityPayload(runtimeAddress: RuntimeAddress, operationId: string, input: Record<string, unknown> = {}) {
  return {
    id: runtimeAddress.capabilityId,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  };
}

export interface GatewaySessionRuntimePort {
  consumeEndpointConversationEvent(runtimeAddress: RuntimeAddress, payload: GatewayConversationEvent): Promise<unknown[]>;
  consumeEndpointNotification(runtimeAddress: RuntimeAddress, payload: unknown): unknown[];
}

export interface RuntimeEndpointControlStatePatch {
  readonly address: RuntimeAddress;
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
  readonly runtimeHostCapabilityAddress: RuntimeAddress;
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

function toSessionRuntimeAddress(address: RuntimeAddress, sessionKey?: string): RuntimeAddress {
  const agentId = sessionKey ? readOpenClawAgentIdFromSessionKey(sessionKey) : '';
  return {
    ...address,
    capabilityId: SESSION_PROMPT_CAPABILITY_ID,
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

export function createRuntimeHostGatewayClient(deps: RuntimeHostGatewayBridgeDeps) {
  let latestObservedTransportEpoch = 0;
  const conversationEventChains = new Map<string, Promise<void>>();
  const pendingNotifications: unknown[] = [];
  const sessionRuntimeAddress = toSessionRuntimeAddress(deps.runtimeHostCapabilityAddress);
  let pendingNotificationHead = 0;

  const emitSessionUpdates = (sessionUpdates: unknown[]): void => {
    for (const sessionUpdate of sessionUpdates) {
      autoRecovery.observe(sessionUpdate as SessionUpdateEvent);
      void deps.parentTransport.emitParentGatewayEvent('session:update', sessionUpdate).catch(() => undefined);
    }
  };

  const flushPendingRuntimeEvents = (runtime: GatewaySessionRuntimePort | null): void => {
    if (!runtime) {
      return;
    }
    while (pendingNotificationHead < pendingNotifications.length) {
      const notification = pendingNotifications[pendingNotificationHead];
      pendingNotificationHead += 1;
      emitSessionUpdates(runtime.consumeEndpointNotification(sessionRuntimeAddress, notification));
    }
    pendingNotifications.length = 0;
    pendingNotificationHead = 0;
  };

  const enqueueConversationEvent = (payload: GatewayConversationEvent): void => {
    const sessionKey = readConversationEventSessionKey(payload);
    const previous = conversationEventChains.get(sessionKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      const runtime = deps.getSessionRuntime();
      if (!runtime) {
        return;
      }
      flushPendingRuntimeEvents(runtime);
      const sessionUpdates = await runtime.consumeEndpointConversationEvent(toSessionRuntimeAddress(deps.runtimeHostCapabilityAddress, sessionKey), payload);
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
        pendingNotifications.push(notification);
        return;
      }
      flushPendingRuntimeEvents(runtime);
      emitSessionUpdates(runtime.consumeEndpointNotification(sessionRuntimeAddress, notification));
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
        address: deps.runtimeHostCapabilityAddress,
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
        createRuntimeHostCapabilityPayload(deps.runtimeHostCapabilityAddress, 'runtimeHost.gatewayLifecycle', {
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
          address: deps.runtimeHostCapabilityAddress,
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

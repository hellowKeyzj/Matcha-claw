import {
  createGatewayClient,
  type GatewayConnectionStatePayload,
} from '../openclaw-bridge';
import {
  DEFAULT_GATEWAY_BASE_METHODS,
  type GatewayCapabilitiesSnapshot,
  type GatewayControlReadiness,
} from '../application/gateway/gateway-runtime-port';
import type { GatewayConversationEvent } from '../openclaw-bridge/events';
import type { ParentTransportClient } from './parent-transport-client';
import type { RuntimeRouteResponse } from '../api/dispatch/runtime-route-dispatcher';
import type {
  RuntimeClockPort,
  RuntimeIdGeneratorPort,
  RuntimePlatform,
  RuntimeSchedulerPort,
  RuntimeTcpProbePort,
} from '../application/common/runtime-ports';
import type {
  GatewayDeviceCryptoPort,
  GatewayDeviceIdentityRepositoryPort,
} from '../openclaw-bridge/client-auth-ports';
import type { RuntimeHostLogger } from '../shared/logger';
import type { SessionUpdateEvent } from '../shared/session-adapter-types';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
  summarizeSessionUpdateForTodoToolDebug,
} from '../application/sessions/todo-tool-debug';
import { GatewayAutoRecovery } from './gateway-auto-recovery';

export interface GatewaySessionRuntimePort {
  consumeGatewayConversationEvent(payload: GatewayConversationEvent): Promise<unknown[]>;
  consumeGatewayNotification(payload: unknown): unknown[];
  consumeGatewayConnectionState(payload: GatewayConnectionStatePayload): unknown[];
  consumeGatewayControlReadiness(payload: GatewayControlReadiness): unknown[];
  consumeGatewayCapabilities(payload: GatewayCapabilitiesSnapshot | null): unknown[];
}

export interface RuntimeHostGatewayBridgeDeps {
  readonly parentTransport: Pick<ParentTransportClient, 'requestParentShellAction' | 'emitParentGatewayEvent'>;
  readonly dispatchRoute: (method: string, route: string, payload: unknown) => Promise<RuntimeRouteResponse | null>;
  readonly getSessionRuntime: () => GatewaySessionRuntimePort | null;
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

export function createRuntimeHostGatewayClient(deps: RuntimeHostGatewayBridgeDeps) {
  let latestObservedTransportEpoch = 0;
  let conversationEventChain: Promise<void> = Promise.resolve();
  const pendingNotifications: unknown[] = [];
  let pendingConnectionState: GatewayConnectionStatePayload | null = null;

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
    if (pendingConnectionState) {
      const payload = pendingConnectionState;
      pendingConnectionState = null;
      emitSessionUpdates(runtime.consumeGatewayConnectionState(payload));
    }
    while (pendingNotifications.length > 0) {
      const notification = pendingNotifications.shift()!;
      emitSessionUpdates(runtime.consumeGatewayNotification(notification));
    }
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
      emitSessionUpdates(runtime.consumeGatewayNotification(notification));
    },
    onGatewayConversationEvent: (payload) => {
      logTodoToolDebug(deps.logger, 'gateway.raw-conversation-event', payload);
      conversationEventChain = conversationEventChain.then(async () => {
        const runtime = deps.getSessionRuntime();
        if (!runtime) {
          return;
        }
        flushPendingRuntimeEvents(runtime);
        const sessionUpdates = await runtime.consumeGatewayConversationEvent(payload);
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
      }).catch(() => undefined);
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

      const runtime = deps.getSessionRuntime();
      if (runtime) {
        flushPendingRuntimeEvents(runtime);
        emitSessionUpdates(runtime.consumeGatewayConnectionState(payload));
      } else {
        pendingConnectionState = payload;
      }

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
        '/api/runtime-host/gateway-lifecycle',
        {
          state: 'running',
          transportEpoch: payload.transportEpoch,
          updatedAt: deps.clock.nowMs(),
        },
      ).catch(() => undefined);
      const observedTransportEpoch = payload.transportEpoch;
      void gatewayClient.inspectGatewayControlReadiness(DEFAULT_GATEWAY_BASE_METHODS).then((readiness) => {
        if (observedTransportEpoch !== latestObservedTransportEpoch) {
          return;
        }
        const currentRuntime = deps.getSessionRuntime();
        if (!currentRuntime) {
          return;
        }
        flushPendingRuntimeEvents(currentRuntime);
        emitSessionUpdates([
          ...currentRuntime.consumeGatewayControlReadiness(readiness),
          ...currentRuntime.consumeGatewayCapabilities(readiness.capabilities ?? null),
        ]);
      }).catch(() => undefined);
    },
    requestGatewayRestart: requestGatewayRestart,
  });

  return gatewayClient;
}

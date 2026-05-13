import {
  createGatewayClient,
  type GatewayConnectionStatePayload,
} from '../openclaw-bridge';
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
import type { PendingApprovalStore } from '../application/sessions/pending-approval-store';
import {
  containsTodoToolDebugSignal,
  logTodoToolDebug,
  summarizeSessionUpdateForTodoToolDebug,
} from '../application/sessions/todo-tool-debug';

export interface GatewaySessionRuntimePort {
  consumeGatewayConversationEvent(payload: GatewayConversationEvent): unknown[];
  notifyTransportConnected(transportEpoch: number): void;
}

export interface RuntimeHostGatewayBridgeDeps {
  readonly parentTransport: Pick<ParentTransportClient, 'requestParentShellAction' | 'emitParentGatewayEvent'>;
  readonly dispatchRoute: (method: string, route: string, payload: unknown) => Promise<RuntimeRouteResponse | null>;
  readonly getSessionRuntime: () => GatewaySessionRuntimePort | null;
  readonly pendingApprovals: Pick<PendingApprovalStore, 'consumeGatewayNotification'>;
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
      deps.pendingApprovals.consumeGatewayNotification(notification);
      void deps.parentTransport.emitParentGatewayEvent('gateway:notification', notification).catch(() => undefined);
    },
    onGatewayConversationEvent: (payload) => {
      logTodoToolDebug(deps.logger, 'gateway.raw-conversation-event', payload);
      const sessionUpdates = deps.getSessionRuntime()?.consumeGatewayConversationEvent(payload) ?? [];
      for (const sessionUpdate of sessionUpdates) {
        if (containsTodoToolDebugSignal(sessionUpdate)) {
          logTodoToolDebug(
            deps.logger,
            'runtime-host.emit-session-update',
            summarizeSessionUpdateForTodoToolDebug(sessionUpdate as SessionUpdateEvent),
          );
        }
        void deps.parentTransport.emitParentGatewayEvent('session:update', sessionUpdate).catch(() => undefined);
      }
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
      if (payload.state !== 'connected') {
        return;
      }
      if (payload.transportEpoch <= latestObservedTransportEpoch) {
        return;
      }
      latestObservedTransportEpoch = payload.transportEpoch;
      void deps.dispatchRoute(
        'POST',
        '/api/runtime-host/gateway-lifecycle',
        {
          state: 'running',
          transportEpoch: payload.transportEpoch,
          updatedAt: deps.clock.nowMs(),
        },
      ).catch(() => undefined);
      deps.getSessionRuntime()?.notifyTransportConnected(payload.transportEpoch);
    },
    requestGatewayRestart: async (reason) => {
      const result = await deps.parentTransport.requestParentShellAction('gateway_restart', { reason });
      if (!result.success) {
        throw new Error(result.error.message);
      }
      if (result.status >= 400) {
        throw new Error(`Gateway restart request failed: HTTP ${String(result.status)}`);
      }
    },
  });

  return gatewayClient;
}

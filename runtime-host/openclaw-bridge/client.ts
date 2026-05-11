import WebSocket from 'ws';
import {
  GATEWAY_CONNECT_TIMEOUT_MS,
} from '../shared/runtime-host-constants';
import {
  type GatewayNotification,
} from './protocol';
import type { GatewayConversationEvent } from './events';
import {
  DEFAULT_GATEWAY_OPERATOR_SCOPES,
  GatewayAuthService,
  parseGatewayPort,
} from './client-auth';
import {
  ensureError,
} from './client-errors';
import { probeGatewayPortReachable } from './client-port-probe';
import {
  GATEWAY_RECONNECT_MAX_ATTEMPTS,
  nextReconnectDelayMs,
} from './client-reconnect-policy';
import { GatewayHeartbeatScheduler, getGatewayHeartbeatOptions } from './client-heartbeat';
import { GatewayPendingRpcRequests } from './client-pending-rpc';
import {
  createGatewayTransportIssue,
  type GatewayConnectionState,
  type GatewayConnectionStatePayload,
  type GatewayDiagnosticsSnapshot,
  type GatewayHealthSummary,
} from './client-state';
import { GatewayConnectionTracker } from './client-connection-tracker';
import type { GatewayTransportIssue } from '../shared/gateway-error';
import { GatewayRpcSender } from './client-rpc-sender';
import { connectGatewaySocketSession } from './client-socket-session';
import type {
  RuntimeClockPort,
  RuntimeIdGeneratorPort,
  RuntimePlatform,
  RuntimeScheduledTask,
  RuntimeSchedulerPort,
  RuntimeTcpProbePort,
} from '../application/common/runtime-ports';
import type {
  GatewayDeviceCryptoPort,
  GatewayDeviceIdentityRepositoryPort,
} from './client-auth-ports';
import {
  DEFAULT_GATEWAY_BASE_METHODS,
  inspectGatewayMethods,
  type GatewayCapabilitiesSnapshot,
  type GatewayMethodReadiness,
} from './capabilities';
import type { RuntimeHostLogger } from '../shared/logger';

export type {
  GatewayConnectionState,
  GatewayConnectionStatePayload,
  GatewayDiagnosticsSnapshot,
  GatewayHealthSummary,
};

export interface GatewayClientOptions {
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
  readonly onGatewayNotification?: (notification: GatewayNotification) => void;
  readonly onGatewayConversationEvent?: (payload: GatewayConversationEvent) => void;
  readonly onGatewayChannelStatus?: (payload: { channelId: string; status: string }) => void;
  readonly onGatewayError?: (error: Error) => void;
  readonly onGatewayConnectionState?: (payload: GatewayConnectionStatePayload) => void;
  readonly requestGatewayRestart?: (reason: string) => Promise<void>;
  readonly logger?: RuntimeHostLogger;
}

export { DEFAULT_GATEWAY_OPERATOR_SCOPES };

export function createGatewayClient(options: GatewayClientOptions) {
  let socket: WebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let isConnected = false;
  let gatewayReady = false;
  let isClosingSocket = false;
  let connectedAt = 0;
  let lifecycleEpoch = 0;
  let transportEpoch = 0;
  let gatewayCapabilities: GatewayCapabilitiesSnapshot | null = null;
  let reconnectTimer: RuntimeScheduledTask | null = null;
  let reconnectAttempts = 0;
  const connectionTracker = new GatewayConnectionTracker(options.clock, options.onGatewayConnectionState);
  const pendingRpcRequests = new GatewayPendingRpcRequests(options.scheduler);
  const authService = new GatewayAuthService({
    runtimeHostDataDir: options.runtimeHostDataDir,
    readGatewayToken: options.readGatewayToken,
    platform: options.platform,
    identityRepository: options.identityRepository,
    crypto: options.deviceCrypto,
    clock: options.clock,
  });
  const rpcSender = new GatewayRpcSender({
    ensureConnected: async (timeoutMs) => {
      await ensureConnected(timeoutMs);
    },
    isSocketOpen: () => Boolean(socket && socket.readyState === WebSocket.OPEN && isConnected),
    sendRaw: (payload) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Gateway socket unavailable');
      }
      socket.send(payload);
    },
    pendingRpcRequests,
    idGenerator: options.idGenerator,
    clock: options.clock,
    logger: options.logger,
    recordRpcFailure,
  });
  const heartbeat = new GatewayHeartbeatScheduler({
    isActive: (epoch) => epoch === lifecycleEpoch,
    isSocketOpen: () => Boolean(socket && socket.readyState === WebSocket.OPEN),
    isConnected: () => isConnected,
    isGatewayReady: () => gatewayReady,
    getConnectedAt: () => connectedAt,
    getConsecutiveHeartbeatMisses: () => connectionTracker.diagnostics.consecutiveHeartbeatMisses,
    ping: () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        reportGatewayError(error, createGatewayTransportIssue({
          message: ensureError(error, 'Gateway ping failed').message,
          source: 'runtime',
          clock: options.clock,
        }));
      }
    },
    probeReady: async () => {
      await gatewayRpc('system-presence', {}, 5_000);
    },
    recordHeartbeatTimeout: (nextMisses) => {
      updateDiagnostics({
        consecutiveHeartbeatMisses: nextMisses,
        lastHeartbeatTimeoutAt: options.clock.nowMs(),
      });
      updateConnectionSnapshot({
        diagnostics: connectionTracker.diagnostics,
        lastIssue: createGatewayTransportIssue({
          message: 'Gateway heartbeat timeout',
          source: 'heartbeat-timeout',
          clock: options.clock,
        }),
        lastError: 'Gateway heartbeat timeout',
      });
    },
    requestRestart: () => {
      void requestGatewayRestart();
    },
    scheduleReconnect: (reason) => {
      scheduleReconnect(reason);
    },
  }, getGatewayHeartbeatOptions(options.platform), options.scheduler, options.clock);

  function updateDiagnostics(
    patch: Partial<GatewayDiagnosticsSnapshot>,
  ): GatewayDiagnosticsSnapshot {
    return connectionTracker.updateDiagnostics(patch);
  }

  function updateConnectionSnapshot(
    patch: Partial<Omit<GatewayConnectionStatePayload, 'updatedAt'>>,
  ): GatewayConnectionStatePayload {
    return connectionTracker.updateSnapshot(patch);
  }

  function clearConnectionState(): void {
    connectPromise = null;
    isConnected = false;
    gatewayReady = false;
    connectedAt = 0;
    socket = null;
    gatewayCapabilities = null;
  }

  function resetConnectionHandshakeState(): void {
    isConnected = false;
    gatewayReady = false;
  }

  function markConnected(): void {
    isConnected = true;
  }

  function rejectAllPending(error: Error): void {
    pendingRpcRequests.rejectAll(error);
  }

  function reportGatewayError(error: unknown, issue?: GatewayTransportIssue): void {
    const normalized = ensureError(error);
    if (issue) {
      updateConnectionSnapshot({
        diagnostics: connectionTracker.diagnostics,
        lastError: issue.message,
        lastIssue: issue,
      });
    }
    options.onGatewayError?.(normalized);
  }

  function bumpLifecycleEpoch(): number {
    lifecycleEpoch += 1;
    return lifecycleEpoch;
  }

  function markAlive(source: 'message' | 'pong' | 'rpc') {
    const now = options.clock.nowMs();
    updateDiagnostics({
      lastAliveAt: now,
      consecutiveHeartbeatMisses: 0,
    });
    updateConnectionSnapshot({
      lastError: '',
      diagnostics: connectionTracker.diagnostics,
    });
    if (source === 'rpc' && !gatewayReady) {
      gatewayReady = true;
      updateConnectionSnapshot({
        gatewayReady: true,
        diagnostics: connectionTracker.diagnostics,
      });
    }
  }

  function markGatewayReady(): void {
    if (gatewayReady) {
      return;
    }
    gatewayReady = true;
    updateConnectionSnapshot({
      gatewayReady: true,
      diagnostics: connectionTracker.diagnostics,
    });
  }

  function updateCapabilities(capabilities: GatewayCapabilitiesSnapshot): void {
    gatewayCapabilities = capabilities;
  }

  function recordRpcSuccess() {
    updateDiagnostics({
      lastRpcSuccessAt: options.clock.nowMs(),
      consecutiveRpcFailures: 0,
      lastRpcFailureAt: undefined,
      lastRpcFailureMethod: undefined,
    });
    updateConnectionSnapshot({
      lastError: '',
      diagnostics: connectionTracker.diagnostics,
    });
  }

  function recordRpcFailure(method: string, issue?: GatewayTransportIssue) {
    updateDiagnostics({
      lastRpcFailureAt: options.clock.nowMs(),
      lastRpcFailureMethod: method,
      consecutiveRpcFailures: connectionTracker.diagnostics.consecutiveRpcFailures + 1,
    });
    updateConnectionSnapshot({
      ...(issue ? { lastIssue: issue, lastError: issue.message } : {}),
      diagnostics: connectionTracker.diagnostics,
    });
  }

  function recordSocketClose(code: number) {
    updateDiagnostics({
      lastSocketCloseAt: options.clock.nowMs(),
      lastSocketCloseCode: code,
      consecutiveHeartbeatMisses: 0,
    });
  }

  function recordConnectSuccess(expectedEpoch: number): void {
    reconnectAttempts = 0;
    connectedAt = options.clock.nowMs();
    transportEpoch += 1;
    gatewayReady = false;
    updateDiagnostics({
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    });
    updateConnectionSnapshot({
      state: 'connected',
      portReachable: true,
      gatewayReady: false,
      transportEpoch,
      diagnostics: connectionTracker.diagnostics,
      lastError: '',
    });
    heartbeat.scheduleHeartbeat(expectedEpoch);
  }

  function clearSocketTimers(): void {
    heartbeat.clearHeartbeatTimers();
    heartbeat.clearRecoveryTimers();
  }

  function consumeClosingSocketFlag(): boolean {
    const closedByClient = isClosingSocket;
    isClosingSocket = false;
    return closedByClient;
  }

  async function requestGatewayRestart(): Promise<void> {
    if (typeof options.requestGatewayRestart !== 'function') {
      return;
    }
    try {
      await options.requestGatewayRestart('transport-unresponsive');
    } catch (error) {
      reportGatewayError(error, createGatewayTransportIssue({
        message: ensureError(error, 'Gateway restart request failed').message,
        source: 'runtime',
        clock: options.clock,
      }));
    }
  }

  function scheduleReconnect(reason: string): void {
    if (reconnectTimer || reconnectAttempts >= GATEWAY_RECONNECT_MAX_ATTEMPTS) {
      return;
    }
    const scheduledEpoch = bumpLifecycleEpoch();
    const delayMs = nextReconnectDelayMs(reconnectAttempts);
    reconnectAttempts += 1;
    updateConnectionSnapshot({
      state: 'reconnecting',
      diagnostics: connectionTracker.diagnostics,
    });
    reconnectTimer = options.scheduler.schedule(delayMs, () => {
      reconnectTimer = null;
      if (scheduledEpoch !== lifecycleEpoch) {
        return;
      }
      void ensureConnected().catch((error) => {
        const failure = ensureError(error, `Gateway reconnect failed: ${reason}`);
        updateConnectionSnapshot({
          state: 'disconnected',
          lastError: failure.message,
          lastIssue: createGatewayTransportIssue({
            message: failure.message,
            source: 'connect',
            clock: options.clock,
          }),
          diagnostics: connectionTracker.diagnostics,
        });
        scheduleReconnect(reason);
      });
    });
  }

  async function ensureConnected(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS): Promise<void> {
    if (socket && socket.readyState === WebSocket.OPEN && isConnected) {
      return;
    }
    if (connectPromise) {
      return await connectPromise;
    }

    const gatewayPort = options.gatewayPort;
    const wsUrl = `ws://127.0.0.1:${gatewayPort}/ws`;
    const expectedEpoch = bumpLifecycleEpoch();
    resetConnectionHandshakeState();
    const connectStartedAt = options.clock.nowMs();
    options.logger?.traceDebug?.(1, '[gateway-ws] connect-start', {
      gatewayPort,
      timeoutMs,
      expectedEpoch,
    });

    connectPromise = connectGatewaySocketSession({
      wsUrl,
      timeoutMs,
      expectedEpoch,
      scheduler: options.scheduler,
      idGenerator: options.idGenerator,
      clock: options.clock,
      getSocket: () => socket,
      setSocket: (nextSocket) => {
        socket = nextSocket;
      },
      getTransportEpoch: () => transportEpoch,
      updateConnectionSnapshot,
      getDiagnostics: () => connectionTracker.diagnostics,
      isConnected: () => isConnected,
      markConnected,
      markAlive,
      markGatewayReady,
      updateCapabilities,
      recordRpcSuccess,
      recordRpcFailure,
      recordConnectSuccess,
      recordSocketClose,
      clearSocketTimers,
      clearConnectionState,
      rejectAllPending,
      consumeClosingSocketFlag,
      reportGatewayError,
      scheduleReconnect,
      pendingRpcRequests,
      authService,
      onGatewayNotification: options.onGatewayNotification,
      onGatewayConversationEvent: options.onGatewayConversationEvent,
      onGatewayChannelStatus: options.onGatewayChannelStatus,
    });

    updateConnectionSnapshot({
      state: 'reconnecting',
      transportEpoch,
      lastError: '',
      diagnostics: connectionTracker.diagnostics,
    });

    try {
      await connectPromise;
      options.logger?.traceDebug?.(1, '[gateway-ws] connect-success', {
        gatewayPort,
        expectedEpoch,
        elapsedMs: options.clock.nowMs() - connectStartedAt,
      });
    } catch (error) {
      options.logger?.warn('[gateway-ws] connect-failed', {
        gatewayPort,
        expectedEpoch,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: options.clock.nowMs() - connectStartedAt,
      });
      clearConnectionState();
      throw error;
    } finally {
      connectPromise = null;
    }
  }

  async function readGatewayConnectionState(
    timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS,
  ): Promise<GatewayConnectionStatePayload> {
    if (socket && socket.readyState === WebSocket.OPEN && isConnected) {
      return updateConnectionSnapshot({
        state: 'connected',
        portReachable: true,
        lastError: '',
        transportEpoch,
        gatewayReady,
        diagnostics: connectionTracker.diagnostics,
      });
    }
    const gatewayPort = options.gatewayPort;
    const portReachable = await probeGatewayPortReachable(options.tcpProbe, gatewayPort, timeoutMs);
    return updateConnectionSnapshot({
      state: portReachable ? connectionTracker.snapshot.state : 'disconnected',
      portReachable,
      gatewayReady: portReachable ? connectionTracker.snapshot.gatewayReady : false,
      transportEpoch,
      diagnostics: connectionTracker.diagnostics,
    });
  }

  async function isGatewayRunning(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS) {
    const snapshot = await readGatewayConnectionState(timeoutMs);
    return snapshot.portReachable;
  }

  async function ensureGatewayReady(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS): Promise<void> {
    await ensureGatewayMethods(DEFAULT_GATEWAY_BASE_METHODS, timeoutMs);
    await gatewayRpc('status', {}, Math.max(1000, timeoutMs));
  }

  async function readGatewayCapabilities(
    timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS,
  ): Promise<GatewayCapabilitiesSnapshot | null> {
    await ensureConnected(Math.max(1000, timeoutMs));
    return gatewayCapabilities;
  }

  async function inspectGatewayMethodReadiness(
    methods: readonly string[],
    timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS,
  ): Promise<GatewayMethodReadiness> {
    const capabilities = await readGatewayCapabilities(timeoutMs);
    return inspectGatewayMethods(capabilities, methods);
  }

  async function ensureGatewayMethods(
    methods: readonly string[],
    timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS,
  ): Promise<GatewayMethodReadiness> {
    const readiness = await inspectGatewayMethodReadiness(methods, timeoutMs);
    if (!readiness.ready) {
      throw new Error(`Gateway methods unavailable: ${readiness.missingMethods.join(', ')}`);
    }
    return readiness;
  }

  async function gatewayRpc(method: string, params: unknown, timeoutMs?: number) {
    return await rpcSender.call(method, params, timeoutMs);
  }

  function close() {
    heartbeat.clearHeartbeatTimers();
    heartbeat.clearRecoveryTimers();
    if (reconnectTimer) {
      reconnectTimer.cancel();
      reconnectTimer = null;
    }
    bumpLifecycleEpoch();
    if (socket) {
      const current = socket;
      clearConnectionState();
      rejectAllPending(new Error('Gateway client closed'));
      isClosingSocket = true;
      try {
        current.close(1000, 'runtime-host shutdown');
      } catch {
        isClosingSocket = false;
      }
    }
    updateConnectionSnapshot({
      state: 'disconnected',
      gatewayReady: false,
      transportEpoch,
      lastError: '',
      diagnostics: connectionTracker.diagnostics,
    });
  }

  function buildSecurityAuditQueryParams(url: URL) {
    const output: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (!value) {
        continue;
      }
      output[key] = value;
    }
    return output;
  }

  connectionTracker.emitInitial();

  return {
    ensureGatewayReady,
    ensureGatewayMethods,
    gatewayRpc,
    isGatewayRunning,
    readGatewayCapabilities,
    inspectGatewayMethodReadiness,
    readGatewayConnectionState,
    buildSecurityAuditQueryParams,
    close,
  };
}

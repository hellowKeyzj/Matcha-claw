import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  DEFAULT_GATEWAY_RPC_TIMEOUT_MS,
  GATEWAY_CONNECT_TIMEOUT_MS,
} from '../api/common/constants';
import { getRuntimeHostDataDir } from '../api/storage/paths';
import { dispatchGatewayProtocolEvent } from './events';
import {
  isGatewayEventFrame,
  isGatewayResponseFrame,
  type GatewayNotification,
  type GatewayResponseFrame,
} from './protocol';
import type { GatewayConversationEvent } from './events';
import {
  buildDeviceAuthPayloadV3,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from '../shared/device-identity';
import type { GatewayTransportIssue } from '../shared/gateway-error';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export type GatewayConnectionState = 'connected' | 'reconnecting' | 'disconnected';
export type GatewayHealthSummary = 'healthy' | 'degraded' | 'unresponsive';

export interface GatewayDiagnosticsSnapshot {
  readonly lastAliveAt?: number;
  readonly lastRpcSuccessAt?: number;
  readonly lastRpcFailureAt?: number;
  readonly lastRpcFailureMethod?: string;
  readonly lastHeartbeatTimeoutAt?: number;
  readonly consecutiveHeartbeatMisses: number;
  readonly lastSocketCloseAt?: number;
  readonly lastSocketCloseCode?: number;
  readonly consecutiveRpcFailures: number;
}

export interface GatewayConnectionStatePayload {
  readonly state: GatewayConnectionState;
  readonly portReachable: boolean;
  readonly gatewayReady: boolean;
  readonly healthSummary: GatewayHealthSummary;
  readonly transportEpoch: number;
  readonly lastError?: string;
  readonly lastIssue?: GatewayTransportIssue;
  readonly diagnostics: GatewayDiagnosticsSnapshot;
  readonly updatedAt: number;
}

export interface GatewayClientOptions {
  readonly onGatewayNotification?: (notification: GatewayNotification) => void;
  readonly onGatewayConversationEvent?: (payload: GatewayConversationEvent) => void;
  readonly onGatewayChannelStatus?: (payload: { channelId: string; status: string }) => void;
  readonly onGatewayError?: (error: Error) => void;
  readonly onGatewayConnectionState?: (payload: GatewayConnectionStatePayload) => void;
  readonly requestGatewayRestart?: (reason: string) => Promise<void>;
}

export const DEFAULT_GATEWAY_OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
] as const;
const GATEWAY_CLIENT_ID = 'gateway-client';
const GATEWAY_CLIENT_VERSION = '0.1.0';
const GATEWAY_CLIENT_MODE = 'backend';
const GATEWAY_CLIENT_DEVICE_FAMILY = 'desktop';
const GATEWAY_CLIENT_DISPLAY_NAME = 'MatchaClaw Runtime Host';
const GATEWAY_CLIENT_CAPS = ['tool-events'] as const;
const GATEWAY_DEVICE_IDENTITY_PATH = join(getRuntimeHostDataDir(), 'identity', 'device.json');
let gatewayDeviceIdentityCache: DeviceIdentity | null = null;
const GATEWAY_HEARTBEAT_INTERVAL_MS = process.platform === 'win32' ? 45_000 : 30_000;
const GATEWAY_HEARTBEAT_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 10_000;
const GATEWAY_HEARTBEAT_MAX_MISSES = process.platform === 'win32' ? 4 : 3;
const GATEWAY_READY_FALLBACK_MS = 30_000;
const GATEWAY_INITIAL_READY_HEARTBEAT_GRACE_MS = 300_000;
const GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
const GATEWAY_RECONNECT_BASE_DELAY_MS = 1_000;
const GATEWAY_RECONNECT_MAX_DELAY_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureError(value: unknown, fallback = 'Gateway request failed'): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(value ? String(value) : fallback);
}

function extractGatewayErrorMessage(payload: unknown) {
  if (!isRecord(payload)) {
    return String(payload);
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return String(payload.error || 'Unknown Gateway error');
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof error.code === 'string' && error.code.trim()) {
    return error.code;
  }
  return JSON.stringify(error);
}

function extractGatewayErrorMessageFromResponse(message: GatewayResponseFrame): string {
  if (message.error !== undefined && message.error !== null) {
    return extractGatewayErrorMessage({ error: message.error });
  }
  return 'Unknown Gateway error';
}

function extractGatewayErrorCode(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return '';
  }
  return typeof error.code === 'string' ? error.code.trim() : '';
}

function extractGatewayErrorDetails(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload.error;
  if (!isRecord(error)) {
    return undefined;
  }
  return error.details;
}

function getGatewayPort(): number {
  const rawPort = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT;
  if (typeof rawPort !== 'string' || !rawPort.trim()) {
    throw new Error('Missing required runtime-host env: MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT');
  }
  const fromEnv = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) {
    throw new Error(`Invalid runtime-host gateway port: ${rawPort}`);
  }
  return fromEnv;
}

function getGatewayToken(): string {
  const token = process.env.MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN;
  return typeof token === 'string' ? token.trim() : '';
}

async function probeGatewayPortReachable(port: number, timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const resolveOnce = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(Math.max(250, timeoutMs));
    socket.once('connect', () => resolveOnce(true));
    socket.once('timeout', () => resolveOnce(false));
    socket.once('error', () => resolveOnce(false));
    socket.once('close', () => resolveOnce(false));
    socket.connect(port, '127.0.0.1');
  });
}

function loadGatewayDeviceIdentity(): DeviceIdentity {
  if (gatewayDeviceIdentityCache) {
    return gatewayDeviceIdentityCache;
  }
  gatewayDeviceIdentityCache = loadOrCreateDeviceIdentity(GATEWAY_DEVICE_IDENTITY_PATH);
  return gatewayDeviceIdentityCache;
}

function buildInitialDiagnostics(): GatewayDiagnosticsSnapshot {
  return {
    consecutiveHeartbeatMisses: 0,
    consecutiveRpcFailures: 0,
  };
}

function sameDiagnosticsSnapshot(
  left: GatewayDiagnosticsSnapshot,
  right: GatewayDiagnosticsSnapshot,
): boolean {
  return left.lastAliveAt === right.lastAliveAt
    && left.lastRpcSuccessAt === right.lastRpcSuccessAt
    && left.lastRpcFailureAt === right.lastRpcFailureAt
    && left.lastRpcFailureMethod === right.lastRpcFailureMethod
    && left.lastHeartbeatTimeoutAt === right.lastHeartbeatTimeoutAt
    && left.consecutiveHeartbeatMisses === right.consecutiveHeartbeatMisses
    && left.lastSocketCloseAt === right.lastSocketCloseAt
    && left.lastSocketCloseCode === right.lastSocketCloseCode
    && left.consecutiveRpcFailures === right.consecutiveRpcFailures;
}

function nextReconnectDelayMs(attempt: number): number {
  return Math.min(
    GATEWAY_RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt)),
    GATEWAY_RECONNECT_MAX_DELAY_MS,
  );
}

function buildGatewayHealthSummary(params: {
  state: GatewayConnectionState;
  portReachable: boolean;
  gatewayReady: boolean;
  diagnostics: GatewayDiagnosticsSnapshot;
}): GatewayHealthSummary {
  if (!params.portReachable || params.state === 'disconnected') {
    return 'unresponsive';
  }
  if (!params.gatewayReady) {
    return 'degraded';
  }
  if (params.diagnostics.consecutiveHeartbeatMisses > 0 || params.diagnostics.consecutiveRpcFailures > 0) {
    return 'degraded';
  }
  return 'healthy';
}

function buildGatewayConnectRequest(connectId: string, challengeNonce: string) {
  const gatewayToken = getGatewayToken();
  const signedAtMs = Date.now();
  const deviceIdentity = loadGatewayDeviceIdentity();
  const devicePayload = buildDeviceAuthPayloadV3({
    deviceId: deviceIdentity.deviceId,
    clientId: GATEWAY_CLIENT_ID,
    clientMode: GATEWAY_CLIENT_MODE,
    role: 'operator',
    scopes: [...DEFAULT_GATEWAY_OPERATOR_SCOPES],
    signedAtMs,
    token: gatewayToken || null,
    nonce: challengeNonce,
    platform: process.platform,
    deviceFamily: GATEWAY_CLIENT_DEVICE_FAMILY,
  });
  const deviceSignature = signDevicePayload(deviceIdentity.privateKeyPem, devicePayload);

  return {
    type: 'req',
    id: connectId,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: GATEWAY_CLIENT_ID,
        displayName: GATEWAY_CLIENT_DISPLAY_NAME,
        version: GATEWAY_CLIENT_VERSION,
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODE,
        deviceFamily: GATEWAY_CLIENT_DEVICE_FAMILY,
      },
      ...(gatewayToken ? { auth: { token: gatewayToken } } : {}),
      caps: [...GATEWAY_CLIENT_CAPS],
      role: 'operator',
      scopes: [...DEFAULT_GATEWAY_OPERATOR_SCOPES],
      device: {
        id: deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
        signature: deviceSignature,
        signedAt: signedAtMs,
        nonce: challengeNonce,
      },
    },
  };
}

export function createGatewayClient(options: GatewayClientOptions = {}) {
  let socket: WebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let connectRequestId: string | null = null;
  let isConnected = false;
  let gatewayReady = false;
  let isClosingSocket = false;
  let connectedAt = 0;
  let lifecycleEpoch = 0;
  let transportEpoch = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempts = 0;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  let gatewayReadyFallbackTimer: NodeJS.Timeout | null = null;
  let initialReadyHeartbeatRecoveryTimer: NodeJS.Timeout | null = null;
  let diagnostics: GatewayDiagnosticsSnapshot = buildInitialDiagnostics();
  let connectionSnapshot: GatewayConnectionStatePayload = {
    state: 'disconnected',
    portReachable: false,
    gatewayReady: false,
    healthSummary: 'unresponsive',
    transportEpoch: 0,
    diagnostics,
    updatedAt: Date.now(),
  };
  const pendingRequests = new Map<string, PendingRequest>();

  function buildIssue(input: {
    message: string;
    source: GatewayTransportIssue['source'];
    code?: string;
    details?: unknown;
  }): GatewayTransportIssue {
    return {
      message: input.message,
      source: input.source,
      at: Date.now(),
      ...(input.code ? { code: input.code } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
    };
  }

  function updateDiagnostics(
    patch: Partial<GatewayDiagnosticsSnapshot>,
  ): GatewayDiagnosticsSnapshot {
    diagnostics = {
      ...diagnostics,
      ...patch,
    };
    return diagnostics;
  }

  function updateConnectionSnapshot(
    patch: Partial<Omit<GatewayConnectionStatePayload, 'updatedAt'>>,
  ): GatewayConnectionStatePayload {
    const nextSnapshot: GatewayConnectionStatePayload = {
      state: patch.state ?? connectionSnapshot.state,
      portReachable: patch.portReachable ?? connectionSnapshot.portReachable,
      gatewayReady: patch.gatewayReady ?? connectionSnapshot.gatewayReady,
      transportEpoch: patch.transportEpoch ?? connectionSnapshot.transportEpoch,
      diagnostics: patch.diagnostics ?? connectionSnapshot.diagnostics,
      healthSummary: buildGatewayHealthSummary({
        state: patch.state ?? connectionSnapshot.state,
        portReachable: patch.portReachable ?? connectionSnapshot.portReachable,
        gatewayReady: patch.gatewayReady ?? connectionSnapshot.gatewayReady,
        diagnostics: patch.diagnostics ?? connectionSnapshot.diagnostics,
      }),
      ...(patch.lastError !== undefined
        ? (patch.lastError ? { lastError: patch.lastError } : {})
        : (connectionSnapshot.lastError ? { lastError: connectionSnapshot.lastError } : {})),
      ...(patch.lastIssue !== undefined
        ? (patch.lastIssue ? { lastIssue: patch.lastIssue } : {})
        : (connectionSnapshot.lastIssue ? { lastIssue: connectionSnapshot.lastIssue } : {})),
      updatedAt: Date.now(),
    };
    const unchanged = connectionSnapshot.state === nextSnapshot.state
      && connectionSnapshot.portReachable === nextSnapshot.portReachable
      && connectionSnapshot.gatewayReady === nextSnapshot.gatewayReady
      && connectionSnapshot.transportEpoch === nextSnapshot.transportEpoch
      && connectionSnapshot.healthSummary === nextSnapshot.healthSummary
      && connectionSnapshot.lastError === nextSnapshot.lastError
      && connectionSnapshot.lastIssue?.message === nextSnapshot.lastIssue?.message
      && connectionSnapshot.lastIssue?.source === nextSnapshot.lastIssue?.source
      && connectionSnapshot.lastIssue?.code === nextSnapshot.lastIssue?.code
      && sameDiagnosticsSnapshot(connectionSnapshot.diagnostics, nextSnapshot.diagnostics);
    if (unchanged) {
      return connectionSnapshot;
    }
    connectionSnapshot = nextSnapshot;
    options.onGatewayConnectionState?.(connectionSnapshot);
    return connectionSnapshot;
  }

  function clearConnectionState(): void {
    connectPromise = null;
    connectRequestId = null;
    isConnected = false;
    gatewayReady = false;
    connectedAt = 0;
    socket = null;
  }

  function resetConnectionHandshakeState(): void {
    connectRequestId = null;
    isConnected = false;
    gatewayReady = false;
  }

  function rejectAllPending(error: Error): void {
    for (const [requestId, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  function reportGatewayError(error: unknown, issue?: GatewayTransportIssue): void {
    const normalized = ensureError(error);
    if (issue) {
      updateConnectionSnapshot({
        diagnostics,
        lastError: issue.message,
        lastIssue: issue,
      });
    }
    options.onGatewayError?.(normalized);
  }

  function clearHeartbeatTimers(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatTimeoutTimer) {
      clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
  }

  function clearRecoveryTimers(): void {
    if (gatewayReadyFallbackTimer) {
      clearTimeout(gatewayReadyFallbackTimer);
      gatewayReadyFallbackTimer = null;
    }
    if (initialReadyHeartbeatRecoveryTimer) {
      clearTimeout(initialReadyHeartbeatRecoveryTimer);
      initialReadyHeartbeatRecoveryTimer = null;
    }
  }

  function bumpLifecycleEpoch(): number {
    lifecycleEpoch += 1;
    return lifecycleEpoch;
  }

  function markAlive(source: 'message' | 'pong' | 'rpc') {
    const now = Date.now();
    updateDiagnostics({
      lastAliveAt: now,
      consecutiveHeartbeatMisses: 0,
    });
    updateConnectionSnapshot({
      lastError: '',
      lastIssue: null,
      diagnostics,
    });
    if (source === 'rpc' && !gatewayReady) {
      gatewayReady = true;
      updateConnectionSnapshot({
        gatewayReady: true,
        diagnostics,
      });
    }
  }

  function recordRpcSuccess() {
    updateDiagnostics({
      lastRpcSuccessAt: Date.now(),
      consecutiveRpcFailures: 0,
      lastRpcFailureAt: undefined,
      lastRpcFailureMethod: undefined,
    });
    updateConnectionSnapshot({
      lastError: '',
      lastIssue: null,
      diagnostics,
    });
  }

  function recordRpcFailure(method: string, issue?: GatewayTransportIssue) {
    updateDiagnostics({
      lastRpcFailureAt: Date.now(),
      lastRpcFailureMethod: method,
      consecutiveRpcFailures: diagnostics.consecutiveRpcFailures + 1,
    });
    updateConnectionSnapshot({
      ...(issue ? { lastIssue: issue, lastError: issue.message } : {}),
      diagnostics,
    });
  }

  function recordSocketClose(code: number) {
    updateDiagnostics({
      lastSocketCloseAt: Date.now(),
      lastSocketCloseCode: code,
      consecutiveHeartbeatMisses: 0,
    });
  }

  async function requestGatewayRestart(): Promise<void> {
    if (typeof options.requestGatewayRestart !== 'function') {
      return;
    }
    try {
      await options.requestGatewayRestart('transport-unresponsive');
    } catch (error) {
      reportGatewayError(error, buildIssue({
        message: ensureError(error, 'Gateway restart request failed').message,
        source: 'runtime',
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
      diagnostics,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledEpoch !== lifecycleEpoch) {
        return;
      }
      void ensureConnected().catch((error) => {
        const failure = ensureError(error, `Gateway reconnect failed: ${reason}`);
        updateConnectionSnapshot({
          state: 'disconnected',
          lastError: failure.message,
          lastIssue: buildIssue({
            message: failure.message,
            source: 'connect',
          }),
          diagnostics,
        });
        scheduleReconnect(reason);
      });
    }, delayMs);
  }

  function scheduleGatewayReadyFallback(expectedEpoch: number): void {
    if (gatewayReadyFallbackTimer) {
      clearTimeout(gatewayReadyFallbackTimer);
    }
    gatewayReadyFallbackTimer = setTimeout(() => {
      gatewayReadyFallbackTimer = null;
      if (expectedEpoch !== lifecycleEpoch || !isConnected || gatewayReady) {
        return;
      }
      void gatewayRpc('system-presence', {}, 5_000).catch(() => {
        if (expectedEpoch !== lifecycleEpoch || !isConnected || gatewayReady) {
          return;
        }
        scheduleGatewayReadyFallback(expectedEpoch);
      });
    }, GATEWAY_READY_FALLBACK_MS);
  }

  function scheduleHeartbeat(expectedEpoch: number): void {
    clearHeartbeatTimers();
    const tick = () => {
      if (expectedEpoch !== lifecycleEpoch || !socket || socket.readyState !== WebSocket.OPEN || !isConnected) {
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        reportGatewayError(error, buildIssue({
          message: ensureError(error, 'Gateway ping failed').message,
          source: 'runtime',
        }));
      }
      heartbeatTimeoutTimer = setTimeout(() => {
        heartbeatTimeoutTimer = null;
        if (expectedEpoch !== lifecycleEpoch || !isConnected) {
          return;
        }
        const nextMisses = diagnostics.consecutiveHeartbeatMisses + 1;
        updateDiagnostics({
          consecutiveHeartbeatMisses: nextMisses,
          lastHeartbeatTimeoutAt: Date.now(),
        });
        updateConnectionSnapshot({
          diagnostics,
          lastIssue: buildIssue({
            message: 'Gateway heartbeat timeout',
            source: 'heartbeat-timeout',
          }),
          lastError: 'Gateway heartbeat timeout',
        });
        if (nextMisses >= GATEWAY_HEARTBEAT_MAX_MISSES) {
          const withinInitialReadyGrace = !gatewayReady
            && connectedAt > 0
            && (Date.now() - connectedAt) < GATEWAY_INITIAL_READY_HEARTBEAT_GRACE_MS;
          if (withinInitialReadyGrace) {
            if (!initialReadyHeartbeatRecoveryTimer) {
              initialReadyHeartbeatRecoveryTimer = setTimeout(() => {
                initialReadyHeartbeatRecoveryTimer = null;
                void requestGatewayRestart();
              }, Math.max(0, GATEWAY_INITIAL_READY_HEARTBEAT_GRACE_MS - (Date.now() - connectedAt)));
            }
            scheduleHeartbeat(expectedEpoch);
            return;
          }
          void requestGatewayRestart();
          scheduleReconnect('heartbeat-timeout');
          return;
        }
        scheduleHeartbeat(expectedEpoch);
      }, GATEWAY_HEARTBEAT_TIMEOUT_MS);
      heartbeatTimer = setTimeout(tick, GATEWAY_HEARTBEAT_INTERVAL_MS);
    };

    heartbeatTimer = setTimeout(tick, GATEWAY_HEARTBEAT_INTERVAL_MS);
    scheduleGatewayReadyFallback(expectedEpoch);
  }

  async function ensureConnected(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS): Promise<void> {
    if (socket && socket.readyState === WebSocket.OPEN && isConnected) {
      return;
    }
    if (connectPromise) {
      return await connectPromise;
    }

    const gatewayPort = getGatewayPort();
    const wsUrl = `ws://127.0.0.1:${gatewayPort}/ws`;
    const expectedEpoch = bumpLifecycleEpoch();
    resetConnectionHandshakeState();

    connectPromise = new Promise<void>((resolve, reject) => {
      let connectSettled = false;
      const ws = new WebSocket(wsUrl);
      socket = ws;

      const connectTimer = setTimeout(() => {
        if (connectSettled) {
          return;
        }
        connectSettled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        const timeoutError = new Error('Gateway connect timeout');
        updateConnectionSnapshot({
          state: 'disconnected',
          gatewayReady: false,
          transportEpoch,
          lastError: timeoutError.message,
          lastIssue: buildIssue({
            message: timeoutError.message,
            source: 'connect',
          }),
          diagnostics,
        });
        reject(timeoutError);
      }, Math.max(1000, timeoutMs));

      const settleConnectSuccess = () => {
        if (connectSettled) {
          return;
        }
        if (socket !== ws) {
          return;
        }
        connectSettled = true;
        clearTimeout(connectTimer);
        reconnectAttempts = 0;
        connectedAt = Date.now();
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
          diagnostics,
          lastError: '',
          lastIssue: null,
        });
        scheduleHeartbeat(expectedEpoch);
        resolve();
      };

      const settleConnectFailure = (
        error: unknown,
        issuePatch?: Pick<GatewayTransportIssue, 'code' | 'details'>,
      ) => {
        if (connectSettled) {
          return;
        }
        if (socket !== ws) {
          return;
        }
        connectSettled = true;
        clearTimeout(connectTimer);
        try {
          ws.close();
        } catch {
          // ignore
        }
        const failure = ensureError(error, 'Gateway connect failed');
        updateConnectionSnapshot({
          state: 'disconnected',
          gatewayReady: false,
          transportEpoch,
          lastError: failure.message,
          lastIssue: buildIssue({
            message: failure.message,
            source: 'connect',
            ...(issuePatch?.code ? { code: issuePatch.code } : {}),
            ...(issuePatch?.details !== undefined ? { details: issuePatch.details } : {}),
          }),
          diagnostics,
        });
        reject(failure);
      };

      ws.on('open', () => {
        if (socket !== ws) {
          return;
        }
        updateConnectionSnapshot({
          state: 'reconnecting',
          portReachable: true,
          transportEpoch,
          lastError: '',
          lastIssue: null,
        });
      });

      ws.on('message', (rawData: unknown) => {
        if (socket !== ws) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(rawData));
        } catch {
          return;
        }

        if (isGatewayEventFrame(parsed) && !isConnected && parsed.event === 'connect.challenge') {
          const payload = isRecord(parsed.payload) ? parsed.payload : {};
          const challengeNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
          if (!challengeNonce) {
            settleConnectFailure(new Error('Gateway connect.challenge missing nonce'));
            return;
          }
          connectRequestId = `connect-${randomUUID()}`;
          try {
            ws.send(JSON.stringify(buildGatewayConnectRequest(connectRequestId, challengeNonce)));
          } catch (error) {
            settleConnectFailure(error);
          }
          return;
        }

        if (isGatewayResponseFrame(parsed) && !isConnected && parsed.id === connectRequestId) {
          if (parsed.ok === false || parsed.error) {
            settleConnectFailure(
              new Error(`Gateway connect failed: ${extractGatewayErrorMessageFromResponse(parsed)}`),
              {
                code: extractGatewayErrorCode({ error: parsed.error }),
                details: extractGatewayErrorDetails({ error: parsed.error }),
              },
            );
            return;
          }
          isConnected = true;
          connectRequestId = null;
          settleConnectSuccess();
          return;
        }

        if (isGatewayResponseFrame(parsed)) {
          markAlive('rpc');
          const pending = pendingRequests.get(parsed.id);
          if (!pending) {
            return;
          }
          clearTimeout(pending.timer);
          pendingRequests.delete(parsed.id);
          if (parsed.ok === false || parsed.error) {
            recordRpcFailure(pending.method, buildIssue({
              message: `Gateway RPC failed (${pending.method}): ${extractGatewayErrorMessageFromResponse(parsed)}`,
              source: 'rpc',
              code: extractGatewayErrorCode({ error: parsed.error }),
              details: extractGatewayErrorDetails({ error: parsed.error }),
            }));
            pending.reject(
              new Error(
                `Gateway RPC failed (${pending.method}): ${extractGatewayErrorMessageFromResponse(parsed)}`,
              ),
            );
            return;
          }
          recordRpcSuccess();
          pending.resolve(parsed.payload ?? {});
          return;
        }

        if (isGatewayEventFrame(parsed)) {
          markAlive('message');
          if (parsed.event === 'gateway.ready' || parsed.event === 'presence' || parsed.event === 'health') {
            if (!gatewayReady) {
              gatewayReady = true;
              updateConnectionSnapshot({
                gatewayReady: true,
                diagnostics,
              });
            }
          }
          dispatchGatewayProtocolEvent(
            {
              emitNotification: (notification) => {
                options.onGatewayNotification?.(notification);
              },
              emitConversationEvent: (payload) => {
                options.onGatewayConversationEvent?.(payload);
              },
              emitChannelStatus: (payload) => {
                options.onGatewayChannelStatus?.(payload);
              },
            },
            parsed.event,
            parsed.payload,
          );
        }
      });

      ws.on('pong', () => {
        if (socket !== ws || !isConnected) {
          return;
        }
        markAlive('pong');
      });

      ws.on('error', (error: unknown) => {
        if (socket !== ws) {
          return;
        }
        if (!isConnected) {
          settleConnectFailure(error);
          return;
        }
        reportGatewayError(error, buildIssue({
          message: ensureError(error, 'Gateway socket error').message,
          source: 'runtime',
        }));
      });

      ws.on('close', (code: number, reason: unknown) => {
        if (socket !== ws) {
          return;
        }
        clearHeartbeatTimers();
        clearRecoveryTimers();
        recordSocketClose(code);
        const closeError = new Error(
          `Gateway socket closed: code=${String(code)} reason=${String(reason ?? '') || 'unknown'}`,
        );
        const closedDuringConnect = !isConnected;
        const closedByClient = isClosingSocket;
        isClosingSocket = false;
        clearConnectionState();
        rejectAllPending(closeError);
        updateConnectionSnapshot({
          state: 'disconnected',
          gatewayReady: false,
          transportEpoch,
          lastError: closeError.message,
          lastIssue: buildIssue({
            message: closeError.message,
            source: 'socket-close',
            code: String(code),
            details: { reason: String(reason ?? '') || 'unknown' },
          }),
          diagnostics,
        });
        if (closedDuringConnect) {
          settleConnectFailure(closeError);
          return;
        }
        if (!closedByClient) {
          reportGatewayError(closeError, buildIssue({
            message: closeError.message,
            source: 'socket-close',
            code: String(code),
            details: { reason: String(reason ?? '') || 'unknown' },
          }));
          scheduleReconnect('socket-close');
        }
      });
    });

    updateConnectionSnapshot({
      state: 'reconnecting',
      transportEpoch,
      lastError: '',
      lastIssue: null,
      diagnostics,
    });

    try {
      await connectPromise;
    } catch (error) {
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
        lastIssue: null,
        transportEpoch,
        gatewayReady,
        diagnostics,
      });
    }
    const gatewayPort = getGatewayPort();
    const portReachable = await probeGatewayPortReachable(gatewayPort, timeoutMs);
    return updateConnectionSnapshot({
      state: portReachable ? connectionSnapshot.state : 'disconnected',
      portReachable,
      gatewayReady: portReachable ? connectionSnapshot.gatewayReady : false,
      transportEpoch,
      diagnostics,
    });
  }

  async function isGatewayRunning(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS) {
    const snapshot = await readGatewayConnectionState(timeoutMs);
    return snapshot.portReachable;
  }

  async function ensureGatewayReady(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS): Promise<void> {
    const readyTimeoutMs = Math.max(1000, timeoutMs);
    await ensureConnected(readyTimeoutMs);
    await gatewayRpc('status', {}, readyTimeoutMs);
  }

  async function gatewayRpc(method: string, params: unknown, timeoutMs = DEFAULT_GATEWAY_RPC_TIMEOUT_MS) {
    await ensureConnected(Math.max(2000, timeoutMs));
    if (!socket || socket.readyState !== WebSocket.OPEN || !isConnected) {
      throw new Error('Gateway socket unavailable');
    }
    const requestId = `req-${randomUUID()}`;
    return await new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        const timeoutError = new Error(`Gateway RPC timeout: ${method}`);
        recordRpcFailure(method, buildIssue({
          message: timeoutError.message,
          source: 'rpc',
        }));
        rejectRpc(timeoutError);
      }, Math.max(1000, timeoutMs));

      pendingRequests.set(requestId, {
        resolve: (value) => resolveRpc(value),
        reject: (error) => rejectRpc(error),
        timer,
        method,
      });

      try {
        socket.send(JSON.stringify({
          type: 'req',
          id: requestId,
          method,
          params: params || {},
        }));
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        const sendError = ensureError(error, `Failed to send gateway RPC: ${method}`);
        recordRpcFailure(method, buildIssue({
          message: sendError.message,
          source: 'rpc',
        }));
        rejectRpc(sendError);
      }
    });
  }

  function close() {
    clearHeartbeatTimers();
    clearRecoveryTimers();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
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
      lastIssue: null,
      diagnostics,
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

  options.onGatewayConnectionState?.(connectionSnapshot);

  return {
    ensureGatewayReady,
    gatewayRpc,
    isGatewayRunning,
    readGatewayConnectionState,
    buildSecurityAuditQueryParams,
    close,
  };
}

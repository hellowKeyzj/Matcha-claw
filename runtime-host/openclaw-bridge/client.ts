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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export type GatewayConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export interface GatewayConnectionStatePayload {
  readonly state: GatewayConnectionState;
  readonly portReachable: boolean;
  readonly lastError?: string;
  readonly updatedAt: number;
}

export interface GatewayClientOptions {
  readonly onGatewayNotification?: (notification: GatewayNotification) => void;
  readonly onGatewayConversationEvent?: (payload: GatewayConversationEvent) => void;
  readonly onGatewayChannelStatus?: (payload: { channelId: string; status: string }) => void;
  readonly onGatewayError?: (error: Error) => void;
  readonly onGatewayConnectionState?: (payload: GatewayConnectionStatePayload) => void;
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
const GATEWAY_DEVICE_IDENTITY_PATH = join(getRuntimeHostDataDir(), 'identity', 'device.json');
let gatewayDeviceIdentityCache: DeviceIdentity | null = null;

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
        displayName: 'MatchaClaw',
        version: GATEWAY_CLIENT_VERSION,
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODE,
        deviceFamily: GATEWAY_CLIENT_DEVICE_FAMILY,
      },
      ...(gatewayToken ? { auth: { token: gatewayToken } } : {}),
      caps: [],
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
  let isClosingSocket = false;
  let connectionSnapshot: GatewayConnectionStatePayload = {
    state: 'disconnected',
    portReachable: false,
    updatedAt: Date.now(),
  };
  const pendingRequests = new Map<string, PendingRequest>();

  function updateConnectionSnapshot(
    patch: Partial<Omit<GatewayConnectionStatePayload, 'updatedAt'>>,
  ): GatewayConnectionStatePayload {
    const nextSnapshot: GatewayConnectionStatePayload = {
      state: patch.state ?? connectionSnapshot.state,
      portReachable: patch.portReachable ?? connectionSnapshot.portReachable,
      ...(patch.lastError !== undefined
        ? (patch.lastError ? { lastError: patch.lastError } : {})
        : (connectionSnapshot.lastError ? { lastError: connectionSnapshot.lastError } : {})),
      updatedAt: Date.now(),
    };
    const unchanged = connectionSnapshot.state === nextSnapshot.state
      && connectionSnapshot.portReachable === nextSnapshot.portReachable
      && connectionSnapshot.lastError === nextSnapshot.lastError;
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
    socket = null;
  }

  function resetConnectionHandshakeState(): void {
    connectRequestId = null;
    isConnected = false;
  }

  function rejectAllPending(error: Error): void {
    for (const [requestId, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  function reportGatewayError(error: unknown): void {
    const normalized = ensureError(error);
    options.onGatewayError?.(normalized);
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
        reject(new Error('Gateway connect timeout'));
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
        updateConnectionSnapshot({
          state: 'connected',
          portReachable: true,
          lastError: '',
        });
        resolve();
      };

      const settleConnectFailure = (error: unknown) => {
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
          lastError: failure.message,
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
          lastError: '',
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
            );
            return;
          }
          isConnected = true;
          connectRequestId = null;
          settleConnectSuccess();
          return;
        }

        if (isGatewayResponseFrame(parsed)) {
          const pending = pendingRequests.get(parsed.id);
          if (!pending) {
            return;
          }
          clearTimeout(pending.timer);
          pendingRequests.delete(parsed.id);
          if (parsed.ok === false || parsed.error) {
            pending.reject(
              new Error(
                `Gateway RPC failed (${pending.method}): ${extractGatewayErrorMessageFromResponse(parsed)}`,
              ),
            );
            return;
          }
          pending.resolve(parsed.payload ?? {});
          return;
        }

        if (isGatewayEventFrame(parsed)) {
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

      ws.on('error', (error: unknown) => {
        if (socket !== ws) {
          return;
        }
        if (!isConnected) {
          settleConnectFailure(error);
          return;
        }
        reportGatewayError(error);
      });

      ws.on('close', (code: number, reason: unknown) => {
        if (socket !== ws) {
          return;
        }
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
          lastError: closeError.message,
        });
        if (closedDuringConnect) {
          settleConnectFailure(closeError);
          return;
        }
        if (!closedByClient) {
          reportGatewayError(closeError);
        }
      });
    });

    updateConnectionSnapshot({
      state: 'reconnecting',
      lastError: '',
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
      });
    }
    const gatewayPort = getGatewayPort();
    const portReachable = await probeGatewayPortReachable(gatewayPort, timeoutMs);
    return updateConnectionSnapshot({
      state: portReachable ? connectionSnapshot.state : 'disconnected',
      portReachable,
    });
  }

  async function isGatewayRunning(timeoutMs = GATEWAY_CONNECT_TIMEOUT_MS) {
    const snapshot = await readGatewayConnectionState(timeoutMs);
    return snapshot.portReachable;
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
        rejectRpc(new Error(`Gateway RPC timeout: ${method}`));
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
        rejectRpc(ensureError(error, `Failed to send gateway RPC: ${method}`));
      }
    });
  }

  function close() {
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
      lastError: '',
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
    gatewayRpc,
    isGatewayRunning,
    readGatewayConnectionState,
    buildSecurityAuditQueryParams,
    close,
  };
}

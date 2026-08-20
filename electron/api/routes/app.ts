import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PORTS } from '../../utils/config';
import type { RuntimeHostControlOutcome } from '../../main/runtime-host-delivery/control';
import type { AppApiContext } from '../context';
import { getResourcesDir } from '../../utils/paths';
import { sendJson } from '../route-utils';

const GATEWAY_STATUS_UNAVAILABLE = 'Gateway status is unavailable.';

type RuntimeHostControl = Pick<AppApiContext['runtimeHost'], 'command'>;

let lastKnownGatewayStatus: PublicGatewayStatus | null = null;

export type PublicGatewayStatus = Readonly<{
  processState: 'stopped' | 'starting' | 'control_connecting' | 'running' | 'error' | 'reconnecting';
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
  gatewayReady: boolean;
  healthSummary: 'healthy' | 'degraded' | 'unresponsive';
  transportState: 'connected' | 'reconnecting' | 'disconnected';
  portReachable: boolean;
  lastAliveAt?: number;
  lastError?: string;
  lastIssue?: Readonly<{
    message: string;
    source: 'connect' | 'rpc' | 'socket-close' | 'heartbeat-timeout' | 'runtime';
    at: number;
    code?: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  }>;
  diagnostics: Readonly<{
    lastAliveAt?: number;
    lastRpcSuccessAt?: number;
    lastRpcFailureAt?: number;
    lastRpcFailureMethod?: string;
    lastHeartbeatTimeoutAt?: number;
    consecutiveHeartbeatMisses: number;
    lastSocketCloseAt?: number;
    lastSocketCloseCode?: number;
    consecutiveRpcFailures: number;
  }>;
  updatedAt: number;
}>;

export type PublicRuntimeHostStatus = Readonly<{
  status: 'starting' | 'running' | 'stopping' | 'degraded' | 'error' | 'stopped';
  hostLifecycle: HostLifecycle;
  runtimeLifecycle: HostLifecycle;
  updatedAt: number;
  error?: string;
}>;

type RuntimeLifecycle =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waitingToRestart'
  | 'failed'
  | 'shutDown';

type RuntimeFailure =
  | 'artifactUnavailable'
  | 'permissionDenied'
  | 'resourceUnavailable'
  | 'platformRejected'
  | 'stdio'
  | 'readiness'
  | 'unexpectedExit'
  | 'authorityLost'
  | 'cleanupUnconfirmed'
  | 'materialCleanupFailed';

type RuntimeStartupDiagnostic =
  | 'portConflict'
  | 'configurationRejected'
  | 'appServerReportedError'
  | 'unclassifiedStderr'
  | 'invalidUtf8'
  | 'lineTooLong'
  | 'listenerReported'
  | 'bindRejected'
  | 'startupFailed'
  | 'invalidEncoding'
  | 'diagnosticLimitReached';

type HostLifecycle = 'created' | 'starting' | 'ready' | 'shuttingDown' | 'shutDown';

type RuntimeStateProjection = Readonly<{
  lifecycle: RuntimeLifecycle;
  failure?: RuntimeFailure;
  startupDiagnostic?: RuntimeStartupDiagnostic;
}>;

type HostState = Readonly<{
  ok: boolean;
  lifecycle: HostLifecycle;
  matcha: RuntimeStateProjection;
  openClaw: RuntimeStateProjection;
}>;

type GatewaySnapshot =
  | Readonly<{ availability: 'unavailable' }>
  | Readonly<{
    availability: 'available';
    ok: boolean;
    timestampMs: number;
    durationMs: number;
    channelCount: number;
    agentCount: number;
    sessionCount: number;
    heartbeatEnabled: boolean | null;
  }>;

type ControlPhase = 'ready' | 'starting' | 'unavailable';

type ControlSnapshot = Readonly<{
  ready: boolean;
  phase: ControlPhase;
  retryable: boolean;
}>;

type RuntimeSnapshot = Readonly<{
  state: HostState;
  health: HostState;
  gateway: GatewaySnapshot;
  control: ControlSnapshot;
  observedAtMs: number;
}>;

type HostHealthSnapshot = Readonly<{
  state: HostState;
  health: HostState;
}>;

type RuntimeSnapshotObservation =
  | Readonly<{ kind: 'observed'; snapshot: RuntimeSnapshot | null }>
  | Readonly<{ kind: 'unavailable' }>;

type RuntimeSnapshotFreshness = 'reuse-pending' | 'fresh';

type RuntimeSnapshotProjectionOptions = Readonly<{
  freshness?: RuntimeSnapshotFreshness;
}>;

let pendingRuntimeSnapshot: Promise<RuntimeSnapshotObservation> | undefined;
let pendingHostHealthSnapshot: Promise<HostHealthSnapshot | null> | undefined;

export function unavailableGatewayStatus(): PublicGatewayStatus {
  return {
    processState: 'error',
    port: PORTS.OPENCLAW_GATEWAY,
    error: GATEWAY_STATUS_UNAVAILABLE,
    gatewayReady: false,
    healthSummary: 'unresponsive',
    transportState: 'disconnected',
    portReachable: false,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: Date.now(),
  };
}

export async function readGatewayStatusProjection(
  runtimeHost: RuntimeHostControl,
  options: RuntimeSnapshotProjectionOptions = {},
): Promise<PublicGatewayStatus | null> {
  const observation = await readRuntimeSnapshotProjection(runtimeHost, options);
  if (observation.kind === 'unavailable') return lastKnownGatewayStatus;
  if (!observation.snapshot) return null;
  const status = projectGatewayStatus(observation.snapshot);
  if (status) {
    lastKnownGatewayStatus = status;
  }
  return status;
}

export async function readRuntimeHostStatusProjection(
  runtimeHost: RuntimeHostControl,
): Promise<PublicRuntimeHostStatus | null> {
  const snapshot = await readHostHealthProjection(runtimeHost);
  return snapshot ? projectRuntimeHostStatus(snapshot) : null;
}

async function readStatusBundle(
  runtimeHost: RuntimeHostControl,
): Promise<Readonly<{
  gatewayStatus: PublicGatewayStatus;
  runtimeHostStatus: PublicRuntimeHostStatus | null;
}>> {
  const gatewayObservation = await readRuntimeSnapshotProjection(runtimeHost);
  const hostSnapshot = gatewayObservation.kind === 'observed' && gatewayObservation.snapshot
    ? { state: gatewayObservation.snapshot.state, health: gatewayObservation.snapshot.health }
    : await readHostHealthProjection(runtimeHost);
  const gatewayStatus = gatewayObservation.kind === 'unavailable'
    ? lastKnownGatewayStatus
    : gatewayObservation.snapshot
      ? projectGatewayStatus(gatewayObservation.snapshot)
      : null;
  if (gatewayStatus) {
    lastKnownGatewayStatus = gatewayStatus;
  }
  return {
    gatewayStatus: gatewayStatus ?? unavailableGatewayStatus(),
    runtimeHostStatus: hostSnapshot ? projectRuntimeHostStatus(hostSnapshot) : null,
  };
}

async function readRuntimeSnapshotProjection(
  runtimeHost: RuntimeHostControl,
  options: RuntimeSnapshotProjectionOptions = {},
): Promise<RuntimeSnapshotObservation> {
  if (options.freshness === 'fresh') return readRuntimeSnapshotFresh(runtimeHost);
  pendingRuntimeSnapshot ??= readRuntimeSnapshotFresh(runtimeHost)
    .finally(() => {
      pendingRuntimeSnapshot = undefined;
    });
  return pendingRuntimeSnapshot;
}

async function readRuntimeSnapshotFresh(
  runtimeHost: RuntimeHostControl,
): Promise<RuntimeSnapshotObservation> {
  try {
    const outcome = await runtimeHost.command({ name: 'host.runtime.snapshot' });
    if (outcome.kind === 'timed-out') return { kind: 'unavailable' as const };
    return {
      kind: 'observed' as const,
      snapshot: readRuntimeSnapshot(outcome),
    };
  } catch {
    return { kind: 'unavailable' as const };
  }
}

async function readHostHealthProjection(
  runtimeHost: RuntimeHostControl,
): Promise<HostHealthSnapshot | null> {
  pendingHostHealthSnapshot ??= (async () => {
    try {
      return readHostHealthSnapshot(
        await runtimeHost.command({ name: 'host.health' }),
      );
    } catch {
      return null;
    } finally {
      pendingHostHealthSnapshot = undefined;
    }
  })();
  return pendingHostHealthSnapshot;
}

export async function handleAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AppApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/app/browser-relay-info' && req.method === 'GET') {
    const relativeDir = 'resources/tools/data/extension/chrome-extension/browser-relay';
    const extensionDir = join(
      getResourcesDir(),
      'tools',
      'data',
      'extension',
      'chrome-extension',
      'browser-relay',
    );

    sendJson(res, 200, {
      relativeDir,
      extensionDir,
      exists: existsSync(extensionDir),
      chromeExtensionsUrl: 'chrome://extensions/',
    });
    return true;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    ctx.eventBus.addSseClient(res);
    const status = await readStatusBundle(ctx.runtimeHost);
    // Send current-state snapshots immediately so renderer subscribers do not
    // miss lifecycle transitions that happened before the SSE connection opened.
    res.write(`event: gateway:status\ndata: ${JSON.stringify(status.gatewayStatus)}\n\n`);
    if (status.runtimeHostStatus) {
      res.write(`event: runtime-host:status\ndata: ${JSON.stringify(status.runtimeHostStatus)}\n\n`);
    }
    return true;
  }

  return false;
}

function projectRuntimeHostStatus(snapshot: HostHealthSnapshot): PublicRuntimeHostStatus {
  const lifecycle = snapshot.state.lifecycle;
  const status = lifecycle === 'ready'
    ? snapshot.health.ok ? 'running' : 'degraded'
    : lifecycle === 'shuttingDown'
      ? 'stopping'
      : lifecycle === 'shutDown'
        ? 'stopped'
        : 'starting';
  return {
    status,
    hostLifecycle: lifecycle,
    runtimeLifecycle: lifecycle,
    updatedAt: Date.now(),
    ...(status === 'degraded' ? { error: 'Runtime Host health is degraded.' } : {}),
  };
}

function projectGatewayStatus(snapshot: RuntimeSnapshot): PublicGatewayStatus | null {
  const processState = mapProcessState(snapshot.state.openClaw.lifecycle, snapshot.control);

  const gatewayAvailable = snapshot.gateway.availability === 'available';
  const gatewayReady = snapshot.control.ready;
  const transportState = mapTransportState(snapshot.gateway);
  const healthSummary = !gatewayAvailable
    ? 'unresponsive'
    : snapshot.gateway.ok ? 'healthy' : 'degraded';
  const diagnostics = {
    consecutiveHeartbeatMisses: 0,
    consecutiveRpcFailures: 0,
  };

  return {
    processState,
    port: PORTS.OPENCLAW_GATEWAY,
    gatewayReady,
    healthSummary,
    transportState,
    portReachable: gatewayAvailable,
    ...(gatewayAvailable ? { lastAliveAt: snapshot.gateway.timestampMs } : {}),
    diagnostics,
    updatedAt: snapshot.observedAtMs,
  };
}

function readRuntimeSnapshot(outcome: RuntimeHostControlOutcome): RuntimeSnapshot | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result;
  if (!hasExactKeys(result, ['state', 'health', 'gateway', 'control', 'observedAtMs'])
    || !isSafeNonNegativeInteger(result.observedAtMs)) {
    return null;
  }

  const state = readHostState(result.state);
  const health = readHostState(result.health);
  const gateway = readGatewaySnapshot(result.gateway);
  const control = readControlSnapshot(result.control);
  if (!state || !health || !gateway || !control) return null;
  return { state, health, gateway, control, observedAtMs: result.observedAtMs };
}

function readHostHealthSnapshot(outcome: RuntimeHostControlOutcome): HostHealthSnapshot | null {
  if (outcome.kind !== 'succeeded' || !isRecord(outcome.result)) return null;
  const result = outcome.result;
  if (!hasExactKeys(result, ['state', 'health'])) return null;
  const state = readHostState(result.state);
  const health = readHostState(result.health);
  return state && health ? { state, health } : null;
}

function readHostState(value: unknown): HostState | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['ok', 'lifecycle', 'matcha', 'openClaw'])
    || typeof value.ok !== 'boolean'
    || !isHostLifecycle(value.lifecycle)) {
    return null;
  }
  const matcha = readRuntimeStateProjection(value.matcha);
  const openClaw = readRuntimeStateProjection(value.openClaw);
  if (!matcha || !openClaw) return null;
  return { ok: value.ok, lifecycle: value.lifecycle, matcha, openClaw };
}

function readRuntimeStateProjection(value: unknown): RuntimeStateProjection | null {
  if (!isRecord(value)
    || !hasExpectedKeys(value, ['lifecycle'], ['failure', 'startupDiagnostic'])
    || !isRuntimeLifecycle(value.lifecycle)
    || (hasOwn(value, 'failure') && !isRuntimeFailure(value.failure))
    || (hasOwn(value, 'startupDiagnostic') && !isRuntimeStartupDiagnostic(value.startupDiagnostic))) {
    return null;
  }
  const failure = hasOwn(value, 'failure') && isRuntimeFailure(value.failure)
    ? value.failure
    : undefined;
  const startupDiagnostic = hasOwn(value, 'startupDiagnostic')
    && isRuntimeStartupDiagnostic(value.startupDiagnostic)
    ? value.startupDiagnostic
    : undefined;
  return {
    lifecycle: value.lifecycle,
    ...(failure ? { failure } : {}),
    ...(startupDiagnostic ? { startupDiagnostic } : {}),
  };
}

function readGatewaySnapshot(value: unknown): GatewaySnapshot | null {
  if (!isRecord(value) || !hasOwn(value, 'availability')) return null;
  if (value.availability === 'unavailable') {
    return hasExactKeys(value, ['availability']) ? { availability: 'unavailable' } : null;
  }
  if (value.availability !== 'available'
    || !hasExactKeys(value, [
      'availability',
      'ok',
      'timestampMs',
      'durationMs',
      'channelCount',
      'agentCount',
      'sessionCount',
      'heartbeatEnabled',
    ])
    || typeof value.ok !== 'boolean'
    || !isSafeNonNegativeInteger(value.timestampMs)
    || !isSafeNonNegativeInteger(value.durationMs)
    || !isSafeNonNegativeInteger(value.channelCount)
    || !isSafeNonNegativeInteger(value.agentCount)
    || !isSafeNonNegativeInteger(value.sessionCount)
    || (value.heartbeatEnabled !== null && typeof value.heartbeatEnabled !== 'boolean')) {
    return null;
  }
  return {
    availability: 'available',
    ok: value.ok,
    timestampMs: value.timestampMs,
    durationMs: value.durationMs,
    channelCount: value.channelCount,
    agentCount: value.agentCount,
    sessionCount: value.sessionCount,
    heartbeatEnabled: value.heartbeatEnabled,
  };
}

function readControlSnapshot(value: unknown): ControlSnapshot | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['ready', 'phase', 'retryable'])
    || typeof value.ready !== 'boolean'
    || !isControlPhase(value.phase)
    || typeof value.retryable !== 'boolean') {
    return null;
  }
  const valid = value.phase === 'ready'
    ? value.ready && !value.retryable
    : value.phase === 'starting'
      ? !value.ready && value.retryable
      : !value.ready && !value.retryable;
  return valid ? { ready: value.ready, phase: value.phase, retryable: value.retryable } : null;
}

function mapTransportState(
  gateway: GatewaySnapshot,
): PublicGatewayStatus['transportState'] {
  if (gateway.availability === 'unavailable') {
    return 'disconnected';
  }
  return gateway.ok ? 'connected' : 'reconnecting';
}

function hasExpectedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mapProcessState(
  lifecycle: RuntimeLifecycle,
  control: ControlSnapshot,
): PublicGatewayStatus['processState'] {
  switch (lifecycle) {
    case 'starting':
      return 'starting';
    case 'running':
      return control.ready ? 'running' : 'control_connecting';
    case 'waitingToRestart':
      return 'reconnecting';
    case 'failed':
      return 'error';
    case 'stopping':
    case 'unavailable':
    case 'idle':
    case 'shutDown':
      return 'stopped';
  }
}

function isRuntimeLifecycle(value: unknown): value is RuntimeLifecycle {
  return value === 'unavailable'
    || value === 'idle'
    || value === 'starting'
    || value === 'running'
    || value === 'stopping'
    || value === 'waitingToRestart'
    || value === 'failed'
    || value === 'shutDown';
}

function isRuntimeFailure(value: unknown): value is RuntimeFailure {
  return value === 'artifactUnavailable'
    || value === 'permissionDenied'
    || value === 'resourceUnavailable'
    || value === 'platformRejected'
    || value === 'stdio'
    || value === 'readiness'
    || value === 'unexpectedExit'
    || value === 'authorityLost'
    || value === 'cleanupUnconfirmed'
    || value === 'materialCleanupFailed';
}

function isRuntimeStartupDiagnostic(value: unknown): value is RuntimeStartupDiagnostic {
  return value === 'portConflict'
    || value === 'configurationRejected'
    || value === 'appServerReportedError'
    || value === 'unclassifiedStderr'
    || value === 'invalidUtf8'
    || value === 'lineTooLong'
    || value === 'listenerReported'
    || value === 'bindRejected'
    || value === 'startupFailed'
    || value === 'invalidEncoding'
    || value === 'diagnosticLimitReached';
}

function isHostLifecycle(value: unknown): value is HostLifecycle {
  return value === 'created'
    || value === 'starting'
    || value === 'ready'
    || value === 'shuttingDown'
    || value === 'shutDown';
}

function isControlPhase(value: unknown): value is ControlPhase {
  return value === 'ready' || value === 'starting' || value === 'unavailable';
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

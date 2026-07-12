import type { GatewayTransportIssue } from '../../shared/gateway-error';

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

export interface GatewayCapabilitiesSnapshot {
  readonly methods: readonly string[];
  readonly updatedAt: number;
}

export type GatewayControlReadinessPhase = 'ready' | 'starting' | 'unavailable';

export interface GatewayMethodReadiness {
  readonly ready: boolean;
  readonly methods: readonly string[];
  readonly missingMethods: readonly string[];
  readonly capabilities?: GatewayCapabilitiesSnapshot;
}

export interface GatewayControlReadiness {
  readonly ready: boolean;
  readonly phase: GatewayControlReadinessPhase;
  readonly requiredMethods: readonly string[];
  readonly missingMethods: readonly string[];
  readonly retryable: boolean;
  readonly code?: string;
  readonly error?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;
  readonly capabilities?: GatewayCapabilitiesSnapshot;
}

export interface GatewayControlReadinessOptions {
  readonly handshakeTimeoutMs?: number;
  readonly livenessProbeTimeoutMs?: number;
}

export const DEFAULT_GATEWAY_BASE_METHODS = [
  'status',
  'config.get',
  'agents.list',
  'skills.status',
  'system-presence',
] as const;

export function normalizeGatewayMethods(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .filter((method): method is string => typeof method === 'string')
    .map((method) => method.trim())
    .filter((method) => method.length > 0)));
}

export function inspectGatewayMethods(
  capabilities: GatewayCapabilitiesSnapshot | null,
  methods: readonly string[],
): GatewayMethodReadiness {
  const requiredMethods = normalizeGatewayMethods(methods);
  const available = new Set(capabilities?.methods ?? []);
  const missingMethods = requiredMethods.filter((method) => !available.has(method));
  return {
    ready: missingMethods.length === 0,
    methods: requiredMethods,
    missingMethods,
    ...(capabilities ? { capabilities } : {}),
  };
}

export interface GatewayChatPort {
  chatSend(params: Record<string, unknown>): Promise<unknown>;
}

export interface GatewayRpcPort {
  gatewayRpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  isGatewayRunning(timeoutMs?: number): Promise<boolean>;
}

export interface GatewayConnectionPort {
  inspectGatewayControlReadiness(
    methods: readonly string[],
    options?: GatewayControlReadinessOptions,
  ): Promise<GatewayControlReadiness>;
  ensureGatewayReady(timeoutMs?: number): Promise<void>;
  ensureGatewayMethods(methods: readonly string[], timeoutMs?: number): Promise<GatewayMethodReadiness>;
  inspectGatewayMethodReadiness(methods: readonly string[], timeoutMs?: number): Promise<GatewayMethodReadiness>;
  readGatewayCapabilities(timeoutMs?: number): Promise<GatewayCapabilitiesSnapshot | null>;
  readGatewayConnectionState(timeoutMs?: number): Promise<unknown>;
  recoverGatewayConnection(reason: string, timeoutMs?: number): Promise<unknown>;
}

export interface GatewayChannelPort {
  readGatewayConnectionState(timeoutMs?: number): Promise<unknown>;
  channelsStatus(probe: boolean): Promise<unknown>;
  channelsConnect(channelId: string): Promise<unknown>;
  channelsDisconnect(channelId: string): Promise<unknown>;
  channelsRequestQr(channelType: string): Promise<unknown>;
}

export interface GatewayCronPort {
  readGatewayConnectionState(timeoutMs?: number): Promise<unknown>;
  listCronJobs(includeDisabled?: boolean): Promise<unknown>;
  addCronJob(payload: Record<string, unknown>): Promise<unknown>;
  updateCronJob(id: string, patch: Record<string, unknown>): Promise<unknown>;
  removeCronJob(id: string): Promise<unknown>;
  runCronJob(id: string, mode?: 'force' | 'due'): Promise<unknown>;
}

export interface GatewaySecurityPort {
  isGatewayRunning(timeoutMs?: number): Promise<boolean>;
  securityPolicySync(policy: unknown): Promise<unknown>;
  securityAuditQueryFromUrl(url: URL): Promise<unknown>;
  securityQuickAuditRun(): Promise<unknown>;
  securityEmergencyRun(): Promise<unknown>;
  securityIntegrityCheck(): Promise<unknown>;
  securityIntegrityRebaseline(): Promise<unknown>;
  securitySkillsScan(scanPath?: string): Promise<unknown>;
  securityAdvisoriesCheck(feedUrl?: string | null): Promise<unknown>;
  securityRemediationPreview(): Promise<unknown>;
  securityRemediationApply(actions: string[]): Promise<unknown>;
  securityRemediationRollback(snapshotId?: string): Promise<unknown>;
}

export interface GatewayRuntimePort extends
  GatewayChatPort,
  GatewayRpcPort,
  GatewayConnectionPort,
  GatewayChannelPort,
  GatewayCronPort,
  GatewaySecurityPort {}

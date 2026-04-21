export type SessionId = string;
export type RunId = string;
export type ToolId = string;

export interface DriverConfig {
  gatewayPort?: number;
  token?: string;
}

export interface HealthStatus {
  status: 'running' | 'starting' | 'stopped' | 'error' | string;
  detail?: string;
  portReachable?: boolean;
  connectionState?: 'connected' | 'reconnecting' | 'disconnected' | string;
  lastError?: string;
  updatedAt?: number;
}

export interface ToolSource {
  kind: 'path' | 'package' | 'registry' | 'inline' | string;
  spec: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  id: ToolId;
  name?: string;
  source: 'native' | 'platform' | string;
  enabled?: boolean;
  description?: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface ResourceBinding {
  id: string;
  endpoint: string;
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface Credentials {
  token?: string;
  callbackToken?: string;
  signature?: string;
  metadata?: Record<string, unknown>;
}

export interface RunContext {
  sessionId: SessionId;
  systemPrompt: string;
  resourceBindings: ResourceBinding[];
  enabledTools: ToolDefinition[];
  platformCredentials: Credentials;
}

export interface RegistryQuery {
  includeDisabled?: boolean;
  requestedToolIds?: ToolId[];
}

export interface AssembleRequest {
  sessionId: SessionId;
  systemPrompt?: string;
  resourceBindings?: ResourceBinding[];
  requestedToolIds?: ToolId[];
  credentials?: Credentials;
}

export interface ToolExecRequest {
  toolId: ToolId;
  args?: Record<string, unknown>;
  sessionId?: SessionId;
  runId?: RunId;
}

export interface ToolExecResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface ReconcileReport {
  discovered: ToolDefinition[];
  missing: ToolDefinition[];
  conflicts: ToolDefinition[];
}

export interface PolicyCheck {
  toolId: ToolId;
  action: 'execute' | 'install' | 'enable' | 'disable' | string;
  sessionId?: SessionId;
  metadata?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

export interface AuditEvent {
  type: string;
  ts: number;
  payload?: Record<string, unknown>;
}

export interface StandardEvent {
  type: string;
  ts?: number;
  runId?: RunId;
  sessionId?: SessionId;
  payload?: Record<string, unknown>;
}

export interface AgentRuntimeDriver {
  initialize(config: DriverConfig): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  installTool(source: ToolSource): Promise<ToolId>;
  uninstallTool(toolId: ToolId): Promise<void>;
  enableTool(toolId: ToolId): Promise<void>;
  disableTool(toolId: ToolId): Promise<void>;
  listInstalledTools(): Promise<ToolDefinition[]>;
  execute(context: RunContext, eventTx?: unknown): Promise<RunId>;
  abort(runId: RunId): Promise<void>;
}

export interface ToolRegistryPort {
  upsertNative(tools: ToolDefinition[]): Promise<void>;
  upsertPlatform(tools: ToolDefinition[]): Promise<void>;
  setEnabled(toolId: ToolId, enabled: boolean): Promise<void>;
  listEffective(query: RegistryQuery): Promise<ToolDefinition[]>;
}

export interface ContextAssemblerPort {
  assemble(req: AssembleRequest): Promise<RunContext>;
}

export interface ToolExecutorPort {
  executeTool(req: ToolExecRequest): Promise<ToolExecResult>;
}

export interface RuntimeManagerPort {
  runtimeHealth(): Promise<HealthStatus>;
  installNativeTool(source: ToolSource): Promise<ToolId>;
  reconcileNativeTools(): Promise<ReconcileReport>;
}

export interface PolicyEnginePort {
  authorizeTool(req: PolicyCheck): Promise<PolicyDecision>;
}

export interface AuditSinkPort {
  append(event: AuditEvent): Promise<void>;
}

export interface EventBusPort {
  publish(event: StandardEvent): Promise<void>;
}

export interface ReconcilerPort {
  reconcileTools(): Promise<ReconcileReport>;
}

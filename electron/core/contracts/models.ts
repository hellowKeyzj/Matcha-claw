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

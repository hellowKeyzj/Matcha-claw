export type SecurityPreset = "strict" | "balanced" | "relaxed";
export type SecurityRisk = "critical" | "high" | "medium" | "low" | "info";
export type SecurityGuardAction = "block" | "redact" | "confirm" | "warn" | "log";
export type SecurityGuardSeverity = "critical" | "high" | "medium" | "low";
export type SecurityFailureMode = "block_all" | "safe_mode" | "read_only";

export type SecuritySeverityActions = {
  critical: SecurityGuardAction;
  high: SecurityGuardAction;
  medium: SecurityGuardAction;
  low: SecurityGuardAction;
};

export type SecurityDestructiveCategories = {
  fileDelete: boolean;
  gitDestructive: boolean;
  sqlDestructive: boolean;
  systemDestructive: boolean;
  processKill: boolean;
  networkDestructive: boolean;
  privilegeEscalation: boolean;
};

export type SecuritySyncResult = {
  preset: SecurityPreset;
  securityPolicyVersion: number;
  overrideAgentCount: number;
  backend: "security-core";
};

export type SecurityPolicyPayload = {
  preset?: unknown;
  securityPolicyVersion?: unknown;
  securityPolicyByAgent?: unknown;
  runtime?: unknown;
};

export type SecurityCoreRuntimeConfig = {
  enabled: boolean;
  autoHarden: boolean;
  enableCredentialMonitor: boolean;
  enableMemoryIntegrityMonitor: boolean;
  enableCostMonitor: boolean;
  auditOnGatewayStart: boolean;
  runtimeGuardEnabled: boolean;
  enablePromptInjectionGuard: boolean;
  blockDestructive: boolean;
  blockSecrets: boolean;
  extraDestructivePatterns: string[];
  extraSecretPatterns: string[];
  extraPromptInjectionPatterns: string[];
  allowlistedTools: string[];
  allowlistedSessions: string[];
  allowPathPrefixes: string[];
  allowDomains: string[];
  auditEgressAllowlist: string[];
  auditDailyCostLimitUsd: number;
  auditFailureMode: SecurityFailureMode | null;
  logDetections: boolean;
  destructiveAction: SecurityGuardAction;
  destructiveSeverityActions: SecuritySeverityActions;
  destructiveCategories: SecurityDestructiveCategories;
  secretAction: SecurityGuardAction;
  secretSeverityActions: SecuritySeverityActions;
};

export type SecurityAuditFinding = {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  description: string;
  evidence: string;
  ts: number;
};

export type SecurityAuditSummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type SecurityStartupAuditReport = {
  id: string;
  ts: number;
  version: string;
  score: number;
  findings: SecurityAuditFinding[];
  summary: SecurityAuditSummary;
};

export type SecurityAuditItem = {
  ts: number;
  toolName: string;
  risk: SecurityRisk;
  action: "audit" | "allow" | "block";
  decision: string;
  policyPreset?: SecurityPreset;
  ruleId?: string;
  source: "startup-audit" | "runtime-guard" | "monitor";
  detail?: string;
  agentId?: string;
};

export type SecurityAuditQueryResult = {
  page: number;
  pageSize: number;
  total: number;
  items: SecurityAuditItem[];
  backend: "security-core";
};

export type BeforeToolCallResult = {
  block: true;
  blockReason: string;
  auditItem: SecurityAuditItem;
} | {
  params: Record<string, unknown>;
  auditItem?: SecurityAuditItem;
} | {
  block?: false;
  auditItem?: SecurityAuditItem;
} | void;

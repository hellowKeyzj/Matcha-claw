export type SecurityPreset = 'strict' | 'balanced' | 'relaxed';
export type SecurityGuardAction = 'block' | 'redact' | 'confirm' | 'warn' | 'log';
export type SecurityGuardSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SecurityFailureMode = 'block_all' | 'safe_mode' | 'read_only';
export type SecuritySeverityActions = Record<SecurityGuardSeverity, SecurityGuardAction>;

export type SecurityDestructiveCategories = {
  fileDelete: boolean;
  gitDestructive: boolean;
  sqlDestructive: boolean;
  systemDestructive: boolean;
  processKill: boolean;
  networkDestructive: boolean;
  privilegeEscalation: boolean;
};

export type SecurityRuntimePolicy = {
  autoHarden: boolean;
  monitors: {
    credentials: boolean;
    memory: boolean;
    cost: boolean;
  };
  auditOnGatewayStart: boolean;
  runtimeGuardEnabled: boolean;
  enablePromptInjectionGuard: boolean;
  blockDestructive: boolean;
  blockSecrets: boolean;
  allowPathPrefixes: string[];
  allowDomains: string[];
  auditEgressAllowlist: string[];
  auditDailyCostLimitUsd: number;
  auditFailureMode: SecurityFailureMode | null;
  promptInjectionPatterns: string[];
  allowlist: {
    tools: string[];
    sessions: string[];
  };
  logging: {
    logDetections: boolean;
  };
  destructive: {
    action: SecurityGuardAction;
    severityActions: SecuritySeverityActions;
    categories: SecurityDestructiveCategories;
  };
  secrets: {
    action: SecurityGuardAction;
    severityActions: SecuritySeverityActions;
  };
  destructivePatterns: string[];
  secretPatterns: string[];
};

export type SecurityPolicyPayload = {
  preset: SecurityPreset;
  securityPolicyVersion: number;
  runtime: SecurityRuntimePolicy;
};

export type SecurityRuleCatalogPlatform = 'universal' | 'linux' | 'windows' | 'macos' | 'powershell';

export type SecurityRuleCatalogItem = {
  platform: SecurityRuleCatalogPlatform;
  command: string;
  category: 'file_delete' | 'git_destructive' | 'sql_destructive' | 'system_destructive' | 'process_kill' | 'network_destructive' | 'privilege_escalation';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  reason: string;
};

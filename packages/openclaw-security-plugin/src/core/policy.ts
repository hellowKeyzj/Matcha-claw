import type {
  SecurityDestructiveCategories,
  SecurityFailureMode,
  SecurityGuardAction,
  SecuritySeverityActions,
  SecurityCoreRuntimeConfig,
  SecurityPolicyPayload,
  SecurityPreset,
  SecuritySyncResult,
} from "./types.js";

export const DEFAULT_POLICY: SecuritySyncResult = {
  preset: "balanced",
  securityPolicyVersion: 1,
  overrideAgentCount: 0,
  backend: "security-core",
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return raw;
}

function normalizePreset(value: unknown): SecurityPreset {
  if (typeof value !== "string") {
    return "balanced";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "strict" || normalized === "balanced" || normalized === "relaxed") {
    return normalized;
  }
  return "balanced";
}

function normalizeGuardAction(value: unknown, fallback: SecurityGuardAction): SecurityGuardAction {
  if (
    value === "block" ||
    value === "redact" ||
    value === "confirm" ||
    value === "warn" ||
    value === "log"
  ) {
    return value;
  }
  return fallback;
}

function normalizeFailureMode(value: unknown, fallback: SecurityFailureMode | null): SecurityFailureMode | null {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "block_all" || normalized === "safe_mode" || normalized === "read_only") {
    return normalized;
  }
  return fallback;
}

function normalizeSeverityActions(
  value: unknown,
  defaults: SecuritySeverityActions,
): SecuritySeverityActions {
  const raw = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    critical: normalizeGuardAction(raw.critical, defaults.critical),
    high: normalizeGuardAction(raw.high, defaults.high),
    medium: normalizeGuardAction(raw.medium, defaults.medium),
    low: normalizeGuardAction(raw.low, defaults.low),
  };
}

function normalizeDestructiveCategories(value: unknown): SecurityDestructiveCategories {
  const raw = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    fileDelete: normalizeBoolean(raw.fileDelete, true),
    gitDestructive: normalizeBoolean(raw.gitDestructive, true),
    sqlDestructive: normalizeBoolean(raw.sqlDestructive, true),
    systemDestructive: normalizeBoolean(raw.systemDestructive, true),
    processKill: normalizeBoolean(raw.processKill, true),
    networkDestructive: normalizeBoolean(raw.networkDestructive, true),
    privilegeEscalation: normalizeBoolean(raw.privilegeEscalation, true),
  };
}

const DEFAULT_DESTRUCTIVE_SEVERITY_ACTIONS: SecuritySeverityActions = {
  critical: "block",
  high: "confirm",
  medium: "confirm",
  low: "warn",
};

const DEFAULT_SECRET_SEVERITY_ACTIONS: SecuritySeverityActions = {
  critical: "block",
  high: "block",
  medium: "redact",
  low: "warn",
};

export function resolvePolicy(payload: SecurityPolicyPayload, current: SecuritySyncResult): SecuritySyncResult {
  const preset = normalizePreset(payload.preset);
  const securityPolicyVersion = normalizePositiveInt(payload.securityPolicyVersion, current.securityPolicyVersion);
  const overrideAgentCount = typeof payload.securityPolicyByAgent === "object" && payload.securityPolicyByAgent !== null
    ? Object.keys(payload.securityPolicyByAgent as Record<string, unknown>).length
    : 0;
  return {
    preset,
    securityPolicyVersion,
    overrideAgentCount,
    backend: "security-core",
  };
}

export function mergeRuntimeConfig(
  baseConfig: SecurityCoreRuntimeConfig,
  payload: SecurityPolicyPayload,
): SecurityCoreRuntimeConfig {
  const runtimePayload = typeof payload.runtime === "object" && payload.runtime !== null
    ? payload.runtime
    : null;
  if (!runtimePayload) {
    return baseConfig;
  }
  const normalized = resolveRuntimeConfig(runtimePayload);
  return normalized;
}

export function resolveRuntimeConfig(rawConfig: unknown): SecurityCoreRuntimeConfig {
  const config = typeof rawConfig === "object" && rawConfig !== null
    ? rawConfig as Record<string, unknown>
    : {};
  const monitors = typeof config.monitors === "object" && config.monitors !== null
    ? config.monitors as Record<string, unknown>
    : {};
  const allowlist = typeof config.allowlist === "object" && config.allowlist !== null
    ? config.allowlist as Record<string, unknown>
    : {};
  const destructive = typeof config.destructive === "object" && config.destructive !== null
    ? config.destructive as Record<string, unknown>
    : {};
  const secrets = typeof config.secrets === "object" && config.secrets !== null
    ? config.secrets as Record<string, unknown>
    : {};
  const logging = typeof config.logging === "object" && config.logging !== null
    ? config.logging as Record<string, unknown>
    : {};
  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    autoHarden: typeof config.autoHarden === "boolean" ? config.autoHarden : false,
    enableCredentialMonitor: typeof monitors.credentials === "boolean" ? monitors.credentials : true,
    enableMemoryIntegrityMonitor: typeof monitors.memory === "boolean" ? monitors.memory : true,
    enableCostMonitor: typeof monitors.cost === "boolean" ? monitors.cost : false,
    auditOnGatewayStart: typeof config.auditOnGatewayStart === "boolean" ? config.auditOnGatewayStart : true,
    runtimeGuardEnabled: typeof config.runtimeGuardEnabled === "boolean" ? config.runtimeGuardEnabled : true,
    enablePromptInjectionGuard: typeof config.enablePromptInjectionGuard === "boolean"
      ? config.enablePromptInjectionGuard
      : true,
    blockDestructive: typeof config.blockDestructive === "boolean" ? config.blockDestructive : true,
    blockSecrets: typeof config.blockSecrets === "boolean" ? config.blockSecrets : true,
    extraDestructivePatterns: normalizeStringArray(config.destructivePatterns),
    extraSecretPatterns: normalizeStringArray(config.secretPatterns),
    extraPromptInjectionPatterns: normalizeStringArray(config.promptInjectionPatterns),
    allowlistedTools: normalizeStringArray(allowlist.tools),
    allowlistedSessions: normalizeStringArray(allowlist.sessions),
    allowPathPrefixes: normalizeStringArray(config.allowPathPrefixes),
    allowDomains: normalizeStringArray(config.allowDomains),
    auditEgressAllowlist: normalizeStringArray(config.auditEgressAllowlist),
    auditDailyCostLimitUsd: normalizePositiveNumber(config.auditDailyCostLimitUsd, 5),
    auditFailureMode: normalizeFailureMode(config.auditFailureMode, null),
    logDetections: normalizeBoolean(logging.logDetections, true),
    destructiveAction: normalizeGuardAction(destructive.action, "confirm"),
    destructiveSeverityActions: normalizeSeverityActions(
      destructive.severityActions,
      DEFAULT_DESTRUCTIVE_SEVERITY_ACTIONS,
    ),
    destructiveCategories: normalizeDestructiveCategories(destructive.categories),
    secretAction: normalizeGuardAction(secrets.action, "block"),
    secretSeverityActions: normalizeSeverityActions(
      secrets.severityActions,
      DEFAULT_SECRET_SEVERITY_ACTIONS,
    ),
  };
}

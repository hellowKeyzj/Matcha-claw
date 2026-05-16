import {
  DEFAULT_DESTRUCTIVE_CATEGORIES,
  cloneRuntimeTemplate,
} from './security-policy-presets';
import type {
  SecurityDestructiveCategories,
  SecurityFailureMode,
  SecurityGuardAction,
  SecurityPolicyPayload,
  SecurityPreset,
  SecurityRuntimePolicy,
  SecuritySeverityActions,
} from './security-policy-types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGuardAction(value: unknown): SecurityGuardAction | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'block'
    || normalized === 'redact'
    || normalized === 'confirm'
    || normalized === 'warn'
    || normalized === 'log'
  ) {
    return normalized;
  }
  return undefined;
}

function normalizePreset(value: unknown): SecurityPreset | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'balanced' || normalized === 'relaxed') {
    return normalized;
  }
  return undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return raw;
}

function normalizeFailureMode(value: unknown, fallback: SecurityFailureMode | null): SecurityFailureMode | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'block_all' || normalized === 'safe_mode' || normalized === 'read_only') {
    return normalized;
  }
  return fallback;
}

function normalizeSeverityActions(value: unknown, defaults: SecuritySeverityActions): SecuritySeverityActions {
  const raw = isRecord(value) ? value : {};
  return {
    critical: normalizeGuardAction(raw.critical) ?? defaults.critical,
    high: normalizeGuardAction(raw.high) ?? defaults.high,
    medium: normalizeGuardAction(raw.medium) ?? defaults.medium,
    low: normalizeGuardAction(raw.low) ?? defaults.low,
  };
}

function normalizeDestructiveCategories(value: unknown): SecurityDestructiveCategories {
  const raw = isRecord(value) ? value : {};
  return {
    fileDelete: normalizeBoolean(raw.fileDelete, DEFAULT_DESTRUCTIVE_CATEGORIES.fileDelete),
    gitDestructive: normalizeBoolean(raw.gitDestructive, DEFAULT_DESTRUCTIVE_CATEGORIES.gitDestructive),
    sqlDestructive: normalizeBoolean(raw.sqlDestructive, DEFAULT_DESTRUCTIVE_CATEGORIES.sqlDestructive),
    systemDestructive: normalizeBoolean(raw.systemDestructive, DEFAULT_DESTRUCTIVE_CATEGORIES.systemDestructive),
    processKill: normalizeBoolean(raw.processKill, DEFAULT_DESTRUCTIVE_CATEGORIES.processKill),
    networkDestructive: normalizeBoolean(raw.networkDestructive, DEFAULT_DESTRUCTIVE_CATEGORIES.networkDestructive),
    privilegeEscalation: normalizeBoolean(raw.privilegeEscalation, DEFAULT_DESTRUCTIVE_CATEGORIES.privilegeEscalation),
  };
}

function normalizeRuntimePolicy(value: unknown, fallback: SecurityRuntimePolicy): SecurityRuntimePolicy {
  const raw = isRecord(value) ? value : {};
  const monitors = isRecord(raw.monitors) ? raw.monitors : {};
  const allowlist = isRecord(raw.allowlist) ? raw.allowlist : {};
  const logging = isRecord(raw.logging) ? raw.logging : {};
  const destructive = isRecord(raw.destructive) ? raw.destructive : {};
  const secrets = isRecord(raw.secrets) ? raw.secrets : {};
  return {
    autoHarden: normalizeBoolean(raw.autoHarden, fallback.autoHarden),
    monitors: {
      credentials: normalizeBoolean(monitors.credentials, fallback.monitors.credentials),
      memory: normalizeBoolean(monitors.memory, fallback.monitors.memory),
      cost: normalizeBoolean(monitors.cost, fallback.monitors.cost),
    },
    auditOnGatewayStart: normalizeBoolean(raw.auditOnGatewayStart, fallback.auditOnGatewayStart),
    runtimeGuardEnabled: normalizeBoolean(raw.runtimeGuardEnabled, fallback.runtimeGuardEnabled),
    enablePromptInjectionGuard: normalizeBoolean(raw.enablePromptInjectionGuard, fallback.enablePromptInjectionGuard),
    blockDestructive: normalizeBoolean(raw.blockDestructive, fallback.blockDestructive),
    blockSecrets: normalizeBoolean(raw.blockSecrets, fallback.blockSecrets),
    allowPathPrefixes: normalizeStringList(
      raw.allowPathPrefixes ?? fallback.allowPathPrefixes,
    ),
    allowDomains: normalizeStringList(
      raw.allowDomains ?? fallback.allowDomains,
    ),
    auditEgressAllowlist: normalizeStringList(
      raw.auditEgressAllowlist ?? fallback.auditEgressAllowlist,
    ),
    auditDailyCostLimitUsd: normalizePositiveNumber(
      raw.auditDailyCostLimitUsd,
      fallback.auditDailyCostLimitUsd,
    ),
    auditFailureMode: normalizeFailureMode(
      raw.auditFailureMode,
      fallback.auditFailureMode,
    ),
    promptInjectionPatterns: normalizeStringList(raw.promptInjectionPatterns ?? fallback.promptInjectionPatterns),
    allowlist: {
      tools: normalizeStringList(allowlist.tools),
      sessions: normalizeStringList(allowlist.sessions),
    },
    logging: {
      logDetections: normalizeBoolean(logging.logDetections, fallback.logging.logDetections),
    },
    destructive: {
      action: normalizeGuardAction(destructive.action) ?? fallback.destructive.action,
      severityActions: normalizeSeverityActions(
        destructive.severityActions,
        fallback.destructive.severityActions,
      ),
      categories: normalizeDestructiveCategories(destructive.categories),
    },
    secrets: {
      action: normalizeGuardAction(secrets.action) ?? fallback.secrets.action,
      severityActions: normalizeSeverityActions(
        secrets.severityActions,
        fallback.secrets.severityActions,
      ),
    },
    destructivePatterns: normalizeStringList(raw.destructivePatterns),
    secretPatterns: normalizeStringList(raw.secretPatterns),
  };
}

export function normalizeSecurityPolicyPayload(value: unknown): SecurityPolicyPayload {
  const raw = isRecord(value) ? value : {};
  const preset = normalizePreset(raw.preset) ?? 'relaxed';
  const fallbackRuntime = cloneRuntimeTemplate(preset);
  const versionRaw = raw.securityPolicyVersion;
  const securityPolicyVersion = typeof versionRaw === 'number' && Number.isFinite(versionRaw) && versionRaw > 0
    ? Math.floor(versionRaw)
    : 1;
  return {
    preset,
    securityPolicyVersion,
    runtime: normalizeRuntimePolicy(raw.runtime, fallbackRuntime),
  };
}

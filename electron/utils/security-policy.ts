import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOpenClawConfigDir } from './paths';

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

const POLICY_DIR = join(getOpenClawConfigDir(), 'policies');
const SECURITY_POLICY_PATH = join(POLICY_DIR, 'security.policy.json');

const DEFAULT_DESTRUCTIVE_SEVERITY_ACTIONS: SecuritySeverityActions = {
  critical: 'block',
  high: 'confirm',
  medium: 'confirm',
  low: 'warn',
};

const DEFAULT_SECRET_SEVERITY_ACTIONS: SecuritySeverityActions = {
  critical: 'block',
  high: 'block',
  medium: 'redact',
  low: 'warn',
};

const DEFAULT_DESTRUCTIVE_CATEGORIES: SecurityDestructiveCategories = {
  fileDelete: true,
  gitDestructive: true,
  sqlDestructive: true,
  systemDestructive: true,
  processKill: true,
  networkDestructive: true,
  privilegeEscalation: true,
};

const PRESET_RUNTIME_TEMPLATES: Record<SecurityPreset, SecurityRuntimePolicy> = {
  strict: {
    autoHarden: false,
    monitors: {
      credentials: true,
      memory: true,
      cost: true,
    },
    auditOnGatewayStart: true,
    runtimeGuardEnabled: true,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: {
      tools: [],
      sessions: [],
    },
    logging: {
      logDetections: true,
    },
    destructive: {
      action: 'block',
      severityActions: {
        critical: 'block',
        high: 'block',
        medium: 'confirm',
        low: 'warn',
      },
      categories: DEFAULT_DESTRUCTIVE_CATEGORIES,
    },
    secrets: {
      action: 'block',
      severityActions: {
        critical: 'block',
        high: 'block',
        medium: 'block',
        low: 'redact',
      },
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
  balanced: {
    autoHarden: false,
    monitors: {
      credentials: true,
      memory: true,
      cost: false,
    },
    auditOnGatewayStart: true,
    runtimeGuardEnabled: true,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: {
      tools: [],
      sessions: [],
    },
    logging: {
      logDetections: true,
    },
    destructive: {
      action: 'confirm',
      severityActions: DEFAULT_DESTRUCTIVE_SEVERITY_ACTIONS,
      categories: DEFAULT_DESTRUCTIVE_CATEGORIES,
    },
    secrets: {
      action: 'block',
      severityActions: DEFAULT_SECRET_SEVERITY_ACTIONS,
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
  relaxed: {
    autoHarden: false,
    monitors: {
      credentials: true,
      memory: true,
      cost: false,
    },
    auditOnGatewayStart: true,
    runtimeGuardEnabled: true,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: {
      tools: [],
      sessions: [],
    },
    logging: {
      logDetections: true,
    },
    destructive: {
      action: 'warn',
      severityActions: {
        critical: 'confirm',
        high: 'warn',
        medium: 'warn',
        low: 'log',
      },
      categories: DEFAULT_DESTRUCTIVE_CATEGORIES,
    },
    secrets: {
      action: 'redact',
      severityActions: {
        critical: 'block',
        high: 'redact',
        medium: 'warn',
        low: 'log',
      },
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
};

function cloneRuntimeTemplate(preset: SecurityPreset): SecurityRuntimePolicy {
  return JSON.parse(JSON.stringify(PRESET_RUNTIME_TEMPLATES[preset])) as SecurityRuntimePolicy;
}

const DEFAULT_RUNTIME_POLICY: SecurityRuntimePolicy = cloneRuntimeTemplate('balanced');

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
  const preset = normalizePreset(raw.preset) ?? 'balanced';
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

export function getSecurityPolicyFilePath(): string {
  return SECURITY_POLICY_PATH;
}

function readPolicyFile(filePath: string): SecurityPolicyPayload | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeSecurityPolicyPayload(parsed);
  } catch {
    return null;
  }
}

export function readSecurityPolicyFromFile(): SecurityPolicyPayload {
  const preferred = readPolicyFile(SECURITY_POLICY_PATH);
  if (preferred) {
    return preferred;
  }
  return normalizeSecurityPolicyPayload({});
}

export function writeSecurityPolicyToFile(payload: unknown): SecurityPolicyPayload {
  const normalized = normalizeSecurityPolicyPayload(payload);
  mkdirSync(POLICY_DIR, { recursive: true });
  writeFileSync(SECURITY_POLICY_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

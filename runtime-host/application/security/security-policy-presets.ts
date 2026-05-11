import type {
  SecurityDestructiveCategories,
  SecurityPreset,
  SecurityRuntimePolicy,
  SecuritySeverityActions,
} from './security-policy-types';

export const DEFAULT_DESTRUCTIVE_SEVERITY_ACTIONS: SecuritySeverityActions = {
  critical: 'block',
  high: 'confirm',
  medium: 'confirm',
  low: 'warn',
};

export const DEFAULT_SECRET_SEVERITY_ACTIONS: SecuritySeverityActions = {
  critical: 'block',
  high: 'block',
  medium: 'redact',
  low: 'warn',
};

export const DEFAULT_DESTRUCTIVE_CATEGORIES: SecurityDestructiveCategories = {
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

export function cloneRuntimeTemplate(preset: SecurityPreset): SecurityRuntimePolicy {
  return JSON.parse(JSON.stringify(PRESET_RUNTIME_TEMPLATES[preset])) as SecurityRuntimePolicy;
}

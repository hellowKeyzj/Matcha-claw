import { create } from 'zustand';
import {
  hostSecurityReadPolicy,
  hostSecurityWritePolicy,
} from '@/lib/security-runtime';

export type Preset = 'strict' | 'balanced' | 'relaxed';
export type Action = 'block' | 'redact' | 'confirm' | 'warn' | 'log';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type FailureMode = 'block_all' | 'safe_mode' | 'read_only' | null;

export type RuntimePolicy = {
  runtimeGuardEnabled: boolean;
  auditOnGatewayStart: boolean;
  autoHarden: boolean;
  enablePromptInjectionGuard: boolean;
  blockDestructive: boolean;
  blockSecrets: boolean;
  monitors: { credentials: boolean; memory: boolean; cost: boolean };
  logging: { logDetections: boolean };
  allowPathPrefixes: string[];
  allowDomains: string[];
  auditEgressAllowlist: string[];
  auditDailyCostLimitUsd: number;
  auditFailureMode: FailureMode;
  promptInjectionPatterns: string[];
  allowlist: { tools: string[]; sessions: string[] };
  destructive: {
    action: Action;
    severityActions: Record<Severity, Action>;
    categories: {
      fileDelete: boolean;
      gitDestructive: boolean;
      sqlDestructive: boolean;
      systemDestructive: boolean;
      processKill: boolean;
      networkDestructive: boolean;
      privilegeEscalation: boolean;
    };
  };
  secrets: {
    action: Action;
    severityActions: Record<Severity, Action>;
  };
  destructivePatterns: string[];
  secretPatterns: string[];
};

export type SecurityPolicy = {
  preset: Preset;
  securityPolicyVersion: number;
  runtime: RuntimePolicy;
};

const ALL_ACTIONS: Action[] = ['block', 'redact', 'confirm', 'warn', 'log'];

function normalizeDestructiveAction(value: Action): Action {
  if (value === 'redact') return 'warn';
  return value;
}

const PRESET_RUNTIME_TEMPLATES: Record<Preset, RuntimePolicy> = {
  strict: {
    runtimeGuardEnabled: true,
    auditOnGatewayStart: true,
    autoHarden: false,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    monitors: { credentials: true, memory: true, cost: true },
    logging: { logDetections: true },
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: { tools: [], sessions: [] },
    destructive: {
      action: 'block',
      severityActions: { critical: 'block', high: 'block', medium: 'confirm', low: 'warn' },
      categories: {
        fileDelete: true,
        gitDestructive: true,
        sqlDestructive: true,
        systemDestructive: true,
        processKill: true,
        networkDestructive: true,
        privilegeEscalation: true,
      },
    },
    secrets: {
      action: 'block',
      severityActions: { critical: 'block', high: 'block', medium: 'block', low: 'redact' },
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
  balanced: {
    runtimeGuardEnabled: true,
    auditOnGatewayStart: true,
    autoHarden: false,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    monitors: { credentials: true, memory: true, cost: false },
    logging: { logDetections: true },
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: { tools: [], sessions: [] },
    destructive: {
      action: 'confirm',
      severityActions: { critical: 'block', high: 'confirm', medium: 'confirm', low: 'warn' },
      categories: {
        fileDelete: true,
        gitDestructive: true,
        sqlDestructive: true,
        systemDestructive: true,
        processKill: true,
        networkDestructive: true,
        privilegeEscalation: true,
      },
    },
    secrets: {
      action: 'block',
      severityActions: { critical: 'block', high: 'block', medium: 'redact', low: 'warn' },
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
  relaxed: {
    runtimeGuardEnabled: true,
    auditOnGatewayStart: true,
    autoHarden: false,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    monitors: { credentials: true, memory: true, cost: false },
    logging: { logDetections: true },
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'],
    auditDailyCostLimitUsd: 5,
    auditFailureMode: null,
    promptInjectionPatterns: [],
    allowlist: { tools: [], sessions: [] },
    destructive: {
      action: 'warn',
      severityActions: { critical: 'confirm', high: 'warn', medium: 'warn', low: 'log' },
      categories: {
        fileDelete: true,
        gitDestructive: true,
        sqlDestructive: true,
        systemDestructive: true,
        processKill: true,
        networkDestructive: true,
        privilegeEscalation: true,
      },
    },
    secrets: {
      action: 'redact',
      severityActions: { critical: 'block', high: 'redact', medium: 'warn', low: 'log' },
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
};

function cloneRuntimeTemplate(preset: Preset): RuntimePolicy {
  return JSON.parse(JSON.stringify(PRESET_RUNTIME_TEMPLATES[preset])) as RuntimePolicy;
}

const DEFAULT_POLICY: SecurityPolicy = {
  preset: 'balanced',
  securityPolicyVersion: 1,
  runtime: cloneRuntimeTemplate('balanced'),
};

let securityPolicyCache: SecurityPolicy | null = null;
let securitySavedPolicySnapshotCache: SecurityPolicy | null = null;

function cloneSecurityPolicy(policy: SecurityPolicy): SecurityPolicy {
  return JSON.parse(JSON.stringify(policy)) as SecurityPolicy;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function normalizePolicy(raw: unknown): SecurityPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_POLICY;
  }
  const record = raw as Record<string, unknown>;
  const runtimeRaw = (record.runtime && typeof record.runtime === 'object' && !Array.isArray(record.runtime))
    ? record.runtime as Record<string, unknown>
    : {};
  const monitors = (runtimeRaw.monitors && typeof runtimeRaw.monitors === 'object' && !Array.isArray(runtimeRaw.monitors))
    ? runtimeRaw.monitors as Record<string, unknown>
    : {};
  const logging = (runtimeRaw.logging && typeof runtimeRaw.logging === 'object' && !Array.isArray(runtimeRaw.logging))
    ? runtimeRaw.logging as Record<string, unknown>
    : {};
  const allowlist = (runtimeRaw.allowlist && typeof runtimeRaw.allowlist === 'object' && !Array.isArray(runtimeRaw.allowlist))
    ? runtimeRaw.allowlist as Record<string, unknown>
    : {};
  const destructive = (runtimeRaw.destructive && typeof runtimeRaw.destructive === 'object' && !Array.isArray(runtimeRaw.destructive))
    ? runtimeRaw.destructive as Record<string, unknown>
    : {};
  const secrets = (runtimeRaw.secrets && typeof runtimeRaw.secrets === 'object' && !Array.isArray(runtimeRaw.secrets))
    ? runtimeRaw.secrets as Record<string, unknown>
    : {};
  const categories = (destructive.categories && typeof destructive.categories === 'object' && !Array.isArray(destructive.categories))
    ? destructive.categories as Record<string, unknown>
    : {};
  const preset = record.preset === 'strict' || record.preset === 'balanced' || record.preset === 'relaxed'
    ? record.preset
    : DEFAULT_POLICY.preset;
  const runtimeTemplate = cloneRuntimeTemplate(preset);
  const version = Number(record.securityPolicyVersion);
  const securityPolicyVersion = Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
  const toBool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const toAction = (v: unknown, d: Action) => (ALL_ACTIONS.includes(v as Action) ? v as Action : d);
  const toPositiveNumber = (v: unknown, d: number) => {
    const rawValue = Number(v);
    return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : d;
  };
  const toFailureMode = (v: unknown, d: FailureMode): FailureMode => {
    if (v === null || v === undefined) return d;
    if (v === 'block_all' || v === 'safe_mode' || v === 'read_only') return v;
    return d;
  };
  const toSeverityActions = (v: unknown, defaults: Record<Severity, Action>) => {
    const rawActions = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    return {
      critical: toAction(rawActions.critical, defaults.critical),
      high: toAction(rawActions.high, defaults.high),
      medium: toAction(rawActions.medium, defaults.medium),
      low: toAction(rawActions.low, defaults.low),
    };
  };
  return {
    preset,
    securityPolicyVersion,
    runtime: {
      runtimeGuardEnabled: toBool(runtimeRaw.runtimeGuardEnabled, runtimeTemplate.runtimeGuardEnabled),
      auditOnGatewayStart: toBool(runtimeRaw.auditOnGatewayStart, runtimeTemplate.auditOnGatewayStart),
      autoHarden: toBool(runtimeRaw.autoHarden, runtimeTemplate.autoHarden),
      enablePromptInjectionGuard: toBool(runtimeRaw.enablePromptInjectionGuard, runtimeTemplate.enablePromptInjectionGuard),
      blockDestructive: toBool(runtimeRaw.blockDestructive, runtimeTemplate.blockDestructive),
      blockSecrets: toBool(runtimeRaw.blockSecrets, runtimeTemplate.blockSecrets),
      monitors: {
        credentials: toBool(monitors.credentials, runtimeTemplate.monitors.credentials),
        memory: toBool(monitors.memory, runtimeTemplate.monitors.memory),
        cost: toBool(monitors.cost, runtimeTemplate.monitors.cost),
      },
      logging: {
        logDetections: toBool(logging.logDetections, runtimeTemplate.logging.logDetections),
      },
      allowPathPrefixes: normalizeStringList(
        runtimeRaw.allowPathPrefixes ?? runtimeTemplate.allowPathPrefixes,
      ),
      allowDomains: normalizeStringList(
        runtimeRaw.allowDomains ?? runtimeTemplate.allowDomains,
      ),
      auditEgressAllowlist: normalizeStringList(
        runtimeRaw.auditEgressAllowlist ?? runtimeTemplate.auditEgressAllowlist,
      ),
      auditDailyCostLimitUsd: toPositiveNumber(
        runtimeRaw.auditDailyCostLimitUsd,
        runtimeTemplate.auditDailyCostLimitUsd,
      ),
      auditFailureMode: toFailureMode(
        runtimeRaw.auditFailureMode,
        runtimeTemplate.auditFailureMode,
      ),
      promptInjectionPatterns: normalizeStringList(runtimeRaw.promptInjectionPatterns ?? runtimeTemplate.promptInjectionPatterns),
      allowlist: {
        tools: normalizeStringList(allowlist.tools),
        sessions: normalizeStringList(allowlist.sessions),
      },
      destructive: {
        action: normalizeDestructiveAction(toAction(destructive.action, runtimeTemplate.destructive.action)),
        severityActions: (() => {
          const actions = toSeverityActions(destructive.severityActions, runtimeTemplate.destructive.severityActions);
          return {
            critical: normalizeDestructiveAction(actions.critical),
            high: normalizeDestructiveAction(actions.high),
            medium: normalizeDestructiveAction(actions.medium),
            low: normalizeDestructiveAction(actions.low),
          };
        })(),
        categories: {
          fileDelete: toBool(categories.fileDelete, runtimeTemplate.destructive.categories.fileDelete),
          gitDestructive: toBool(categories.gitDestructive, runtimeTemplate.destructive.categories.gitDestructive),
          sqlDestructive: toBool(categories.sqlDestructive, runtimeTemplate.destructive.categories.sqlDestructive),
          systemDestructive: toBool(categories.systemDestructive, runtimeTemplate.destructive.categories.systemDestructive),
          processKill: toBool(categories.processKill, runtimeTemplate.destructive.categories.processKill),
          networkDestructive: toBool(categories.networkDestructive, runtimeTemplate.destructive.categories.networkDestructive),
          privilegeEscalation: toBool(categories.privilegeEscalation, runtimeTemplate.destructive.categories.privilegeEscalation),
        },
      },
      secrets: {
        action: toAction(secrets.action, runtimeTemplate.secrets.action),
        severityActions: toSeverityActions(secrets.severityActions, runtimeTemplate.secrets.severityActions),
      },
      destructivePatterns: Array.isArray(runtimeRaw.destructivePatterns)
        ? runtimeRaw.destructivePatterns.filter((x): x is string => typeof x === 'string')
        : [],
      secretPatterns: Array.isArray(runtimeRaw.secretPatterns)
        ? runtimeRaw.secretPatterns.filter((x): x is string => typeof x === 'string')
        : [],
    },
  };
}

interface SecurityPolicyState {
  policyReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  policy: SecurityPolicy;
  savedPolicySnapshot: SecurityPolicy;
  error: string | null;
  updateRuntime: (updater: (current: RuntimePolicy) => RuntimePolicy) => void;
  applyPresetTemplate: (nextPreset: Preset) => void;
  loadPolicy: () => Promise<void>;
  savePolicy: () => Promise<void>;
}

export const useSecurityPolicyStore = create<SecurityPolicyState>((set, get) => ({
  policyReady: securityPolicyCache !== null,
  initialLoading: securityPolicyCache === null,
  refreshing: false,
  mutating: false,
  policy: securityPolicyCache ? cloneSecurityPolicy(securityPolicyCache) : cloneSecurityPolicy(DEFAULT_POLICY),
  savedPolicySnapshot: securitySavedPolicySnapshotCache
    ? cloneSecurityPolicy(securitySavedPolicySnapshotCache)
    : (securityPolicyCache ? cloneSecurityPolicy(securityPolicyCache) : cloneSecurityPolicy(DEFAULT_POLICY)),
  error: null,

  updateRuntime: (updater) => {
    set((state) => ({
      policy: {
        ...state.policy,
        runtime: updater(state.policy.runtime),
      },
    }));
  },

  applyPresetTemplate: (nextPreset) => {
    set((state) => ({
      policy: {
        ...state.policy,
        preset: nextPreset,
        runtime: cloneRuntimeTemplate(nextPreset),
      },
    }));
  },

  loadPolicy: async () => {
    const hasCachedPolicy = securityPolicyCache !== null;
    if (hasCachedPolicy) {
      set({ refreshing: true, initialLoading: false });
    } else {
      set({ initialLoading: true, refreshing: false });
    }
    try {
      const payload = await hostSecurityReadPolicy<unknown>();
      const normalized = normalizePolicy(payload);
      const policy = cloneSecurityPolicy(normalized);
      const savedSnapshot = cloneSecurityPolicy(normalized);
      securityPolicyCache = policy;
      securitySavedPolicySnapshotCache = savedSnapshot;
      set({
        policy,
        savedPolicySnapshot: savedSnapshot,
        policyReady: true,
        error: null,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'errors.loadFailed',
      });
    } finally {
      set({ initialLoading: false, refreshing: false });
    }
  },

  savePolicy: async () => {
    set({ mutating: true });
    try {
      const payload: SecurityPolicy = get().policy;
      await hostSecurityWritePolicy(payload);
      const nextPolicy = cloneSecurityPolicy(payload);
      const savedSnapshot = cloneSecurityPolicy(nextPolicy);
      securityPolicyCache = nextPolicy;
      securitySavedPolicySnapshotCache = savedSnapshot;
      set({
        policy: nextPolicy,
        savedPolicySnapshot: savedSnapshot,
        policyReady: true,
        error: null,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'errors.saveFailed',
      });
      throw error;
    } finally {
      set({ mutating: false });
    }
  },
}));

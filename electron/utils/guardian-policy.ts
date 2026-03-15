import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOpenClawConfigDir } from './paths';
import type { AppSettings } from './store';

type SecurityAction = 'allow' | 'confirm' | 'deny';
type SecurityPreset = 'strict' | 'balanced' | 'relaxed';
type ConfirmStrategy = 'every_time' | 'session';

type AgentSecurityPolicy = {
  preset?: SecurityPreset;
  defaultAction?: SecurityAction;
  allowTools?: string[];
  confirmTools?: string[];
  denyTools?: string[];
  allowPathPrefixes?: string[];
  allowDomains?: string[];
  allowCommandExecution?: boolean;
  allowDependencyInstall?: boolean;
  confirmStrategy?: ConfirmStrategy;
  capabilities?: string[];
};

type GuardianPolicyPayload = {
  preset: SecurityPreset;
  securityPolicyVersion: number;
  securityPolicyByAgent: Record<string, AgentSecurityPolicy>;
};

type OpenClawConfig = Record<string, unknown>;

const OPENCLAW_CONFIG_PATH = join(getOpenClawConfigDir(), 'openclaw.json');
const GUARDIAN_USER_POLICY_PATH = join(getOpenClawConfigDir(), 'policies', 'guardian.policy.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(value: unknown): SecurityAction | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'allow' || normalized === 'confirm' || normalized === 'deny') {
    return normalized;
  }
  return undefined;
}

function normalizePreset(value: unknown): SecurityPreset | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'balanced' || normalized === 'relaxed') {
    return normalized;
  }
  return undefined;
}

function normalizeConfirmStrategy(value: unknown): ConfirmStrategy | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'every_time' || normalized === 'session') {
    return normalized;
  }
  return undefined;
}

function normalizeToolList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeAgentPolicy(value: unknown): AgentSecurityPolicy {
  if (!isRecord(value)) {
    return {};
  }
  const preset = normalizePreset(value.preset);
  const defaultAction = normalizeAction(value.defaultAction);
  const allowTools = normalizeToolList(value.allowTools);
  const confirmTools = normalizeToolList(value.confirmTools);
  const denyTools = normalizeToolList(value.denyTools);
  const allowPathPrefixes = normalizeStringList(value.allowPathPrefixes);
  const allowDomains = normalizeStringList(value.allowDomains);
  const allowCommandExecution = typeof value.allowCommandExecution === 'boolean'
    ? value.allowCommandExecution
    : undefined;
  const allowDependencyInstall = typeof value.allowDependencyInstall === 'boolean'
    ? value.allowDependencyInstall
    : undefined;
  const confirmStrategy = normalizeConfirmStrategy(value.confirmStrategy);
  const capabilities = normalizeStringList(value.capabilities);
  return {
    ...(preset ? { preset } : {}),
    ...(defaultAction ? { defaultAction } : {}),
    ...(allowTools ? { allowTools } : {}),
    ...(confirmTools ? { confirmTools } : {}),
    ...(denyTools ? { denyTools } : {}),
    ...(allowPathPrefixes ? { allowPathPrefixes } : {}),
    ...(allowDomains ? { allowDomains } : {}),
    ...(typeof allowCommandExecution === 'boolean' ? { allowCommandExecution } : {}),
    ...(typeof allowDependencyInstall === 'boolean' ? { allowDependencyInstall } : {}),
    ...(confirmStrategy ? { confirmStrategy } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function normalizePolicyByAgent(value: unknown): Record<string, AgentSecurityPolicy> {
  if (!isRecord(value)) {
    return {};
  }
  const output: Record<string, AgentSecurityPolicy> = {};
  for (const [rawAgentId, rawPolicy] of Object.entries(value)) {
    const agentId = rawAgentId.trim();
    if (!agentId) {
      continue;
    }
    output[agentId] = normalizeAgentPolicy(rawPolicy);
  }
  return output;
}

function readOpenClawConfig(): OpenClawConfig {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeOpenClawConfig(config: OpenClawConfig): void {
  mkdirSync(getOpenClawConfigDir(), { recursive: true });
  writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeGuardianUserPolicy(payload: GuardianPolicyPayload): void {
  mkdirSync(join(getOpenClawConfigDir(), 'policies'), { recursive: true });
  writeFileSync(GUARDIAN_USER_POLICY_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function buildGuardianPolicyPayloadFromSettings(
  settings: Pick<AppSettings, 'securityPreset' | 'securityPolicyVersion' | 'securityPolicyByAgent'>,
): GuardianPolicyPayload {
  const versionRaw = settings.securityPolicyVersion;
  const version = Number.isFinite(versionRaw) && versionRaw > 0
    ? Math.floor(versionRaw)
    : 1;
  const preset = normalizePreset(settings.securityPreset) ?? 'balanced';
  return {
    preset,
    securityPolicyVersion: version,
    securityPolicyByAgent: normalizePolicyByAgent(settings.securityPolicyByAgent),
  };
}

export function syncGuardianPolicyToOpenClawConfig(
  settings: Pick<AppSettings, 'securityPreset' | 'securityPolicyVersion' | 'securityPolicyByAgent'>,
): { changed: boolean; payload: GuardianPolicyPayload; configPath: string; userPolicyPath: string } {
  const payload = buildGuardianPolicyPayloadFromSettings(settings);
  const config = readOpenClawConfig();
  // NOTE:
  // OpenClaw 当前配置 schema 不允许 plugins.entries.task-manager.guardian，
  // 若写入会导致 Gateway 启动失败并触发 doctor 修复循环。
  // 因此仅把策略落到 guardian.policy.json，运行时通过 guardian.policy.sync 注入。
  let changed = false;
  if (isRecord(config.plugins)) {
    const plugins = { ...config.plugins };
    if (isRecord(plugins.entries)) {
      const entries = { ...plugins.entries } as Record<string, unknown>;
      if (isRecord(entries['task-manager'])) {
        const taskManagerEntry = { ...entries['task-manager'] } as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(taskManagerEntry, 'guardian')) {
          delete taskManagerEntry.guardian;
          changed = true;
          if (Object.keys(taskManagerEntry).length > 0) {
            entries['task-manager'] = taskManagerEntry;
          } else {
            delete entries['task-manager'];
          }
          plugins.entries = entries;
          config.plugins = plugins;
        }
      }
    }
  }
  if (changed) {
    writeOpenClawConfig(config);
  }
  writeGuardianUserPolicy(payload);

  return {
    changed,
    payload,
    configPath: OPENCLAW_CONFIG_PATH,
    userPolicyPath: GUARDIAN_USER_POLICY_PATH,
  };
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type GuardRisk = "low" | "medium" | "high" | "critical";
export type GuardAction = "allow" | "confirm" | "deny";
export type GuardDecision = "allow-once" | "allow-always" | "deny" | "allow";
type GuardPreset = "strict" | "balanced" | "relaxed";
type ConfirmStrategy = "every_time" | "session";

type BeforeToolEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type AfterToolEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  execApprovalManager?: unknown;
  broadcast?: (event: string, payload: unknown, options?: Record<string, unknown>) => void;
};

type GatewayContextLike = {
  execApprovalManager?: unknown;
  broadcast?: (event: string, payload: unknown, options?: Record<string, unknown>) => void;
};

type ExecApprovalRecordLike = {
  id: string;
  request: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number;
};

type ExecApprovalManagerLike = {
  create: (request: Record<string, unknown>, timeoutMs: number, id?: string | null) => ExecApprovalRecordLike;
  register: (record: ExecApprovalRecordLike, timeoutMs: number) => Promise<"allow-once" | "allow-always" | "deny" | null>;
};

type GuardAuditEvent = {
  traceId: string;
  runId: string | null;
  sessionKey: string | null;
  agentId: string | null;
  toolName: string;
  risk: GuardRisk;
  action: GuardAction;
  decision: GuardDecision;
  durationMs: number | null;
  result: "ok" | "error" | "blocked";
  paramsPreview: Record<string, unknown>;
  policyVersion: number;
  policyPreset: GuardPreset;
  ruleId: string;
  requiredCapabilities: string[];
  ts: number;
};

type GuardTrace = {
  traceId: string;
  startedAtMs: number;
  runId: string | null;
  sessionKey: string | null;
  agentId: string | null;
  toolName: string;
  risk: GuardRisk;
  action: GuardAction;
  decision: GuardDecision;
  paramsPreview: Record<string, unknown>;
  policyVersion: number;
  policyPreset: GuardPreset;
  ruleId: string;
  requiredCapabilities: string[];
};

type GuardQuery = {
  page?: unknown;
  pageSize?: unknown;
  agentId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  risk?: unknown;
  action?: unknown;
  policyPreset?: unknown;
  ruleId?: unknown;
  fromMs?: unknown;
  toMs?: unknown;
};

type GuardPolicy = {
  preset: GuardPreset;
  defaultAction: GuardAction;
  approvalTimeoutMs: number;
  allowTools: Set<string>;
  confirmTools: Set<string>;
  denyTools: Set<string>;
  allowPathPrefixes: string[];
  allowDomains: Set<string>;
  allowCommandExecution: boolean;
  allowDependencyInstall: boolean;
  confirmStrategy: ConfirmStrategy;
  capabilities: Set<string>;
  networkUnknownAction: GuardAction;
  sensitivePathAction: GuardAction;
  highRiskAction: GuardAction;
};

type GuardDiagnostics = {
  enabled: boolean;
  slowBeforeToolCallMs: number;
  slowAfterToolCallMs: number;
  slowApprovalWaitMs: number;
  slowAuditWriteMs: number;
};

type GuardAgentPolicyOverride = {
  preset?: GuardPreset;
  defaultAction?: GuardAction;
  allowTools?: Set<string>;
  confirmTools?: Set<string>;
  denyTools?: Set<string>;
  allowPathPrefixes?: string[];
  allowDomains?: Set<string>;
  allowCommandExecution?: boolean;
  allowDependencyInstall?: boolean;
  confirmStrategy?: ConfirmStrategy;
  capabilities?: Set<string>;
};

const SENSITIVE_KEY_RE = /(token|key|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|ssh|credential)/i;
const CONTENT_KEY_RE = /(content|body|prompt|text|message|data)/i;
const PATH_KEY_RE = /(path|file|filepath|directory|cwd|workspace)/i;
const NETWORK_TOOL_RE = /(http|fetch|request|upload|webhook|send|post|socket|mail|smtp|discord|telegram|slack)/i;
const HIGH_RISK_TOOL_RE = /(system\.run|nodes\.run|exec|shell|write|delete|remove|unlink|truncate|replace|install|uninstall|spawn)/i;
const COMMAND_TOOL_RE = /(system\.run|nodes\.run|exec|shell|spawn|terminal|command|powershell|bash|cmd)/i;
const INSTALL_TOOL_RE = /(install|uninstall|npm|pnpm|yarn|pip|brew|apt|apk|choco|cargo add)/i;
const PROMPT_INJECTION_RE = /(ignore previous instructions|reveal system prompt|bypass security|disable guardian|leak secrets|expose api keys)/i;
const SYSTEM_PROMPT_EXFIL_RE = /(system prompt|reveal prompt|dump instructions)/i;
const IMMUTABLE_DISABLE_TOOL_RE = /(disable.*guardian|guardian.*disable)/i;
const SECRET_PATH_RE = /(\.env|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|[\\/]\.config[\\/]|id_rsa|wallet|credentials)/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CAP_READ_LOCAL_FILES = "CAP_READ_LOCAL_FILES";
const CAP_WRITE_LOCAL_FILES = "CAP_WRITE_LOCAL_FILES";
const CAP_EXECUTE_COMMAND = "CAP_EXECUTE_COMMAND";
const CAP_NETWORK_REQUEST = "CAP_NETWORK_REQUEST";
const CAP_INSTALL_DEPENDENCY = "CAP_INSTALL_DEPENDENCY";

const DEFAULT_ALLOW_TOOLS = [
  "task_create",
  "task_set_plan_markdown",
  "task_bind_session",
  "task_request_user_input",
  "task_wait_approval",
  "task_mark_failed",
  "task_list",
  "task_get",
  "task_resume",
  "sessions_list",
  "memory_get",
  "memory_search",
];

const DEFAULT_CONFIRM_TOOLS = [
  "system.run",
  "nodes.run",
  "fs.write_file",
  "fs.delete_file",
  "fs.remove",
  "http.request",
];

const DEFAULT_DENY_TOOLS = [
  "system.disable_guardian",
  "security.disable_guard",
];

const DEFAULT_APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_POLICY_PRESET: GuardPreset = "balanced";
const POLICY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../policy");
const DEFAULT_GUARD_DIAGNOSTICS: GuardDiagnostics = {
  enabled: true,
  slowBeforeToolCallMs: 1200,
  slowAfterToolCallMs: 300,
  slowApprovalWaitMs: 1200,
  slowAuditWriteMs: 120,
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function readPolicyFile(relativePath: string): Record<string, unknown> {
  const fullPath = path.join(POLICY_DIR, relativePath);
  if (!existsSync(fullPath)) {
    return {};
  }
  try {
    const raw = readFileSync(fullPath, "utf8");
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ensureStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  const noProtocol = trimmed.replace(/^[a-z]+:\/\//, "");
  const host = noProtocol.split("/")[0]?.split(":")[0] ?? "";
  return host.replace(/\.$/, "");
}

function normalizeCapability(value: string): string {
  return value.trim().toUpperCase();
}

function normalizePreset(value: unknown): GuardPreset | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "strict" || normalized === "balanced" || normalized === "relaxed") {
    return normalized;
  }
  return undefined;
}

function normalizeAction(value: unknown): GuardAction | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "allow" || normalized === "confirm" || normalized === "deny") {
    return normalized;
  }
  return undefined;
}

function normalizeConfirmStrategy(value: unknown): ConfirmStrategy | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "every_time" || normalized === "session") {
    return normalized;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePolicy(pluginConfig: Record<string, unknown> | undefined): GuardPolicy {
  const runtimeGuardConfig = isObject(pluginConfig?.guardian) ? (pluginConfig?.guardian as Record<string, unknown>) : {};
  const defaultPolicyConfig = readPolicyFile("default.json");
  const presetFromConfig = normalizePreset(runtimeGuardConfig.preset ?? defaultPolicyConfig.preset) ?? DEFAULT_POLICY_PRESET;
  const presetPolicyConfig = readPolicyFile(path.join("presets", `${presetFromConfig}.json`));
  const guardConfig: Record<string, unknown> = {
    ...defaultPolicyConfig,
    ...presetPolicyConfig,
    ...runtimeGuardConfig,
    preset: presetFromConfig,
  };
  const preset = normalizePreset(guardConfig.preset) ?? DEFAULT_POLICY_PRESET;
  const defaultActionRaw = typeof guardConfig.defaultAction === "string" ? guardConfig.defaultAction.trim().toLowerCase() : "confirm";
  const defaultAction: GuardAction = defaultActionRaw === "allow" || defaultActionRaw === "deny" || defaultActionRaw === "confirm"
    ? defaultActionRaw
    : (preset === "strict" ? "deny" : preset === "relaxed" ? "allow" : "confirm");
  const approvalTimeoutMsRaw = typeof guardConfig.approvalTimeoutMs === "number" ? guardConfig.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
  const approvalTimeoutMs = Number.isFinite(approvalTimeoutMsRaw) && approvalTimeoutMsRaw > 0
    ? Math.floor(approvalTimeoutMsRaw)
    : DEFAULT_APPROVAL_TIMEOUT_MS;
  const ensureArray = (value: unknown): string[] => (
    Array.isArray(value)
      ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      : []
  );
  const allowPathPrefixes = ensureArray(guardConfig.allowPathPrefixes);
  const allowDomains = ensureArray(guardConfig.allowDomains).map(normalizeDomain).filter((item) => item.length > 0);
  const allowCommandExecution = typeof guardConfig.allowCommandExecution === "boolean"
    ? guardConfig.allowCommandExecution
    : preset !== "strict";
  const allowDependencyInstall = typeof guardConfig.allowDependencyInstall === "boolean"
    ? guardConfig.allowDependencyInstall
    : preset === "relaxed";
  const confirmStrategy = normalizeConfirmStrategy(guardConfig.confirmStrategy) ?? (preset === "balanced" ? "session" : "every_time");
  const capabilities = ensureArray(guardConfig.capabilities).map(normalizeCapability);
  const defaultCapabilities = (() => {
    if (capabilities.length > 0) {
      return capabilities;
    }
    if (preset === "strict") {
      return [CAP_READ_LOCAL_FILES, CAP_NETWORK_REQUEST];
    }
    if (preset === "relaxed") {
      return [CAP_READ_LOCAL_FILES, CAP_WRITE_LOCAL_FILES, CAP_EXECUTE_COMMAND, CAP_NETWORK_REQUEST, CAP_INSTALL_DEPENDENCY];
    }
    return [CAP_READ_LOCAL_FILES, CAP_WRITE_LOCAL_FILES, CAP_EXECUTE_COMMAND, CAP_NETWORK_REQUEST];
  })();
  const networkUnknownAction = normalizeAction(guardConfig.networkUnknownAction) ?? (preset === "relaxed" ? "allow" : "confirm");
  const sensitivePathAction = normalizeAction(guardConfig.sensitivePathAction) ?? (preset === "strict" ? "deny" : preset === "relaxed" ? "allow" : "confirm");
  const highRiskAction = normalizeAction(guardConfig.highRiskAction) ?? (preset === "strict" ? "deny" : preset === "relaxed" ? "allow" : "confirm");
  return {
    preset,
    defaultAction,
    approvalTimeoutMs,
    allowTools: new Set(ensureStringArray(guardConfig.allowTools, DEFAULT_ALLOW_TOOLS).map(normalizeToolName)),
    confirmTools: new Set(ensureStringArray(guardConfig.confirmTools, DEFAULT_CONFIRM_TOOLS).map(normalizeToolName)),
    denyTools: new Set(ensureStringArray(guardConfig.denyTools, DEFAULT_DENY_TOOLS).map(normalizeToolName)),
    allowPathPrefixes,
    allowDomains: new Set(allowDomains),
    allowCommandExecution,
    allowDependencyInstall,
    confirmStrategy,
    capabilities: new Set(defaultCapabilities),
    networkUnknownAction,
    sensitivePathAction,
    highRiskAction,
  };
}

function normalizeAgentId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function ensureOptionalToolSet(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeToolName(item))
    .filter((item) => item.length > 0);
  return new Set(normalized);
}

function ensureOptionalDomainSet(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeDomain(item))
    .filter((item) => item.length > 0);
  return new Set(normalized);
}

function ensureOptionalCapabilitySet(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeCapability(item))
    .filter((item) => item.length > 0);
  return new Set(normalized);
}

function ensureOptionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized;
}

function normalizeAgentPolicyOverrides(value: unknown): Map<string, GuardAgentPolicyOverride> {
  const result = new Map<string, GuardAgentPolicyOverride>();
  if (!isObject(value)) {
    return result;
  }
  for (const [rawAgentId, rawPolicy] of Object.entries(value)) {
    const agentId = normalizeAgentId(rawAgentId);
    if (!agentId || !isObject(rawPolicy)) {
      continue;
    }
    const preset = normalizePreset(rawPolicy.preset);
    const defaultAction = normalizeAction(rawPolicy.defaultAction);
    const allowTools = ensureOptionalToolSet(rawPolicy.allowTools);
    const confirmTools = ensureOptionalToolSet(rawPolicy.confirmTools);
    const denyTools = ensureOptionalToolSet(rawPolicy.denyTools);
    const allowPathPrefixes = ensureOptionalStringList(rawPolicy.allowPathPrefixes);
    const allowDomains = ensureOptionalDomainSet(rawPolicy.allowDomains);
    const allowCommandExecution = typeof rawPolicy.allowCommandExecution === "boolean"
      ? rawPolicy.allowCommandExecution
      : undefined;
    const allowDependencyInstall = typeof rawPolicy.allowDependencyInstall === "boolean"
      ? rawPolicy.allowDependencyInstall
      : undefined;
    const confirmStrategy = normalizeConfirmStrategy(rawPolicy.confirmStrategy);
    const capabilities = ensureOptionalCapabilitySet(rawPolicy.capabilities);
    result.set(agentId, {
      ...(preset ? { preset } : {}),
      ...(defaultAction ? { defaultAction } : {}),
      ...(allowTools ? { allowTools } : {}),
      ...(confirmTools ? { confirmTools } : {}),
      ...(denyTools ? { denyTools } : {}),
      ...(allowPathPrefixes ? { allowPathPrefixes } : {}),
      ...(allowDomains ? { allowDomains } : {}),
      ...(typeof allowCommandExecution === "boolean" ? { allowCommandExecution } : {}),
      ...(typeof allowDependencyInstall === "boolean" ? { allowDependencyInstall } : {}),
      ...(confirmStrategy ? { confirmStrategy } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return result;
}

function isPathLike(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-zA-Z]:\\/.test(value);
}

function maskPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return `hash:${sha256(normalized).slice(0, 10)}`;
  }
  const fileName = parts[parts.length - 1];
  const stem = fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName;
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  const tailHash = sha256(fileName).slice(0, 8);
  const head = parts.slice(0, Math.max(1, parts.length - 2));
  return `${head.join("/")}/.../${stem.slice(0, 3)}-${tailHash}${ext}`;
}

function summarizeText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const textHash = sha256(trimmed).slice(0, 10);
  if (trimmed.length <= 96) {
    return `${trimmed} [sha:${textHash}]`;
  }
  return `${trimmed.slice(0, 48)}... [len:${trimmed.length}, sha:${textHash}]`;
}

function redactValue(value: unknown, keyHint: string, depth = 0): unknown {
  if (depth > 4) {
    return { type: "truncated", depth };
  }
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    if (SENSITIVE_KEY_RE.test(keyHint) || /^sk-[a-z0-9]/i.test(value.trim()) || /^ghp_[a-z0-9]/i.test(value.trim())) {
      return "[REDACTED]";
    }
    if (CONTENT_KEY_RE.test(keyHint)) {
      return { type: "text", length: value.length, sha256: sha256(value).slice(0, 12) };
    }
    if (PATH_KEY_RE.test(keyHint) || isPathLike(value)) {
      return maskPath(value);
    }
    return summarizeText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const preview = value.slice(0, 8).map((item, index) => redactValue(item, `${keyHint}[${index}]`, depth + 1));
    return value.length > 8 ? [...preview, { type: "truncated", total: value.length }] : preview;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    const output: Record<string, unknown> = {};
    for (const [index, [key, nested]] of entries.entries()) {
      if (index >= 24) {
        output.__truncated = { total: entries.length };
        break;
      }
      output[key] = redactValue(nested, key, depth + 1);
    }
    return output;
  }
  return String(value);
}

function buildParamsPreview(params: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(params);
  return {
    keys,
    keyCount: keys.length,
    preview: redactValue(params, "params"),
    hash: sha256(JSON.stringify(params)),
  };
}

function containsSensitiveValue(value: unknown, keyHint = ""): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value === "string") {
    if (SENSITIVE_KEY_RE.test(keyHint)) {
      return true;
    }
    const text = value.toLowerCase();
    return text.includes("-----begin") || text.includes("bearer ") || text.includes("api_key=") || text.includes("authorization:");
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveValue(item, keyHint));
  }
  if (isObject(value)) {
    return Object.entries(value).some(([key, nested]) => containsSensitiveValue(nested, key));
  }
  return false;
}

function collectStrings(value: unknown, keyHint: string, output: Array<{ key: string; value: string }>, depth = 0): void {
  if (depth > 5 || value == null) {
    return;
  }
  if (typeof value === "string") {
    output.push({ key: keyHint, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${keyHint}[${index}]`, output, depth + 1));
    return;
  }
  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      collectStrings(nested, key, output, depth + 1);
    }
  }
}

function extractPathsFromParams(params: Record<string, unknown>): string[] {
  const strings: Array<{ key: string; value: string }> = [];
  collectStrings(params, "params", strings);
  const paths = new Set<string>();
  for (const entry of strings) {
    const keyLooksLikePath = PATH_KEY_RE.test(entry.key);
    if (!keyLooksLikePath && !isPathLike(entry.value)) {
      continue;
    }
    const normalized = entry.value.trim();
    if (!normalized) {
      continue;
    }
    paths.add(normalized);
  }
  return [...paths];
}

function extractDomainsFromParams(params: Record<string, unknown>): string[] {
  const strings: Array<{ key: string; value: string }> = [];
  collectStrings(params, "params", strings);
  const domains = new Set<string>();
  for (const entry of strings) {
    const value = entry.value.trim();
    if (!value) {
      continue;
    }
    try {
      const parsed = new URL(value);
      if (parsed.hostname) {
        domains.add(normalizeDomain(parsed.hostname));
      }
      continue;
    } catch {
      // ignore parse error
    }
    const matched = value.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})\b/gi);
    if (!matched) {
      continue;
    }
    for (const candidate of matched) {
      const normalized = normalizeDomain(candidate);
      if (normalized) {
        domains.add(normalized);
      }
    }
  }
  return [...domains];
}

function normalizeComparablePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase().replace(/\/$/, "");
}

function isSensitivePath(pathValue: string): boolean {
  return SECRET_PATH_RE.test(normalizeComparablePath(pathValue));
}

function isPathAllowed(pathValue: string, allowPathPrefixes: string[]): boolean {
  if (allowPathPrefixes.length === 0) {
    return true;
  }
  const normalized = normalizeComparablePath(pathValue);
  for (const prefixRaw of allowPathPrefixes) {
    const prefix = normalizeComparablePath(prefixRaw);
    if (!prefix) {
      continue;
    }
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function isIpAddress(value: string): boolean {
  return IPV4_RE.test(value);
}

function isDomainAllowed(domain: string, allowDomains: Set<string>): boolean {
  if (allowDomains.size === 0) {
    return false;
  }
  for (const item of allowDomains) {
    if (domain === item || domain.endsWith(`.${item}`)) {
      return true;
    }
  }
  return false;
}

function isDependencyInstallAttempt(toolName: string, params: Record<string, unknown>): boolean {
  if (INSTALL_TOOL_RE.test(toolName)) {
    return true;
  }
  const strings: Array<{ key: string; value: string }> = [];
  collectStrings(params, "params", strings);
  return strings.some((entry) => /command|cmd|script|shell|exec|args|arguments/i.test(entry.key)
    && INSTALL_TOOL_RE.test(entry.value.toLowerCase()));
}

function deriveRequiredCapabilities(toolName: string, params: Record<string, unknown>): string[] {
  const caps = new Set<string>();
  const paths = extractPathsFromParams(params);
  if (paths.length > 0) {
    caps.add(HIGH_RISK_TOOL_RE.test(toolName) ? CAP_WRITE_LOCAL_FILES : CAP_READ_LOCAL_FILES);
  }
  if (NETWORK_TOOL_RE.test(toolName)) {
    caps.add(CAP_NETWORK_REQUEST);
  }
  if (COMMAND_TOOL_RE.test(toolName)) {
    caps.add(CAP_EXECUTE_COMMAND);
  }
  if (isDependencyInstallAttempt(toolName, params)) {
    caps.add(CAP_INSTALL_DEPENDENCY);
  }
  return [...caps];
}

function asRiskByAction(action: GuardAction): GuardRisk {
  if (action === "deny") {
    return "critical";
  }
  if (action === "confirm") {
    return "high";
  }
  return "low";
}

function normalizeDecision(value: unknown): "allow-once" | "allow-always" | "deny" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "allow-once" || normalized === "allow-always" || normalized === "deny") {
    return normalized;
  }
  return null;
}

function computeTraceKey(event: { runId?: string; toolCallId?: string; toolName: string }, ctx: { sessionKey?: string }): string {
  const runId = event.runId ?? "no-run";
  const toolCallId = event.toolCallId ?? "no-tool-call";
  const sessionKey = ctx.sessionKey ?? "no-session";
  return `${runId}::${toolCallId}::${sessionKey}::${normalizeToolName(event.toolName)}`;
}

function toInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const resolved = toInt(value, fallback);
  return resolved >= 0 ? resolved : fallback;
}

function resolveDiagnosticsConfig(guardConfig: Record<string, unknown>): GuardDiagnostics {
  const diagnosticsRaw = isObject(guardConfig.diagnostics) ? (guardConfig.diagnostics as Record<string, unknown>) : {};
  const enabled = typeof diagnosticsRaw.enabled === "boolean" ? diagnosticsRaw.enabled : DEFAULT_GUARD_DIAGNOSTICS.enabled;
  return {
    enabled,
    slowBeforeToolCallMs: toNonNegativeInt(diagnosticsRaw.slowBeforeToolCallMs, DEFAULT_GUARD_DIAGNOSTICS.slowBeforeToolCallMs),
    slowAfterToolCallMs: toNonNegativeInt(diagnosticsRaw.slowAfterToolCallMs, DEFAULT_GUARD_DIAGNOSTICS.slowAfterToolCallMs),
    slowApprovalWaitMs: toNonNegativeInt(diagnosticsRaw.slowApprovalWaitMs, DEFAULT_GUARD_DIAGNOSTICS.slowApprovalWaitMs),
    slowAuditWriteMs: toNonNegativeInt(diagnosticsRaw.slowAuditWriteMs, DEFAULT_GUARD_DIAGNOSTICS.slowAuditWriteMs),
  };
}

function normalizeDecisionText(value: GuardDecision): string {
  if (value === "allow") {
    return "allow-once";
  }
  return value;
}

export class GuardianController {
  private readonly api: OpenClawPluginApi;
  private basePolicy: GuardPolicy;
  private readonly diagnostics: GuardDiagnostics;
  private securityPolicyVersion = 1;
  private agentPolicyOverrides = new Map<string, GuardAgentPolicyOverride>();
  private readonly allowAlwaysCache = new Set<string>();
  private readonly traces = new Map<string, GuardTrace>();
  private gatewayContext: GatewayContextLike | null = null;
  private auditDb: any = null;
  private auditDbReady: Promise<void> | null = null;
  private readonly auditDbPath: string;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.basePolicy = normalizePolicy(api.pluginConfig);
    const guardConfig = isObject(api.pluginConfig?.guardian) ? (api.pluginConfig?.guardian as Record<string, unknown>) : {};
    this.diagnostics = resolveDiagnosticsConfig(guardConfig);
    this.applyPolicyOverrides(guardConfig, false);
    const stateDirFromEnv = typeof process.env.OPENCLAW_STATE_DIR === "string" ? process.env.OPENCLAW_STATE_DIR.trim() : "";
    const stateDir = stateDirFromEnv || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".openclaw");
    this.auditDbPath = path.join(stateDir, "guardian-audit.db");
  }

  bindGatewayContext(context: GatewayContextLike): void {
    this.gatewayContext = context;
  }

  private bindGatewayContextFromToolContext(ctx: ToolContext): void {
    const nextContext: GatewayContextLike = {};
    if (ctx.execApprovalManager) {
      nextContext.execApprovalManager = ctx.execApprovalManager;
    }
    if (typeof ctx.broadcast === "function") {
      nextContext.broadcast = ctx.broadcast;
    }
    if (!nextContext.execApprovalManager && !nextContext.broadcast) {
      return;
    }
    const current = this.gatewayContext ?? {};
    this.gatewayContext = {
      execApprovalManager: nextContext.execApprovalManager ?? current.execApprovalManager,
      broadcast: nextContext.broadcast ?? current.broadcast,
    };
  }

  private resolveApprovalManager(): ExecApprovalManagerLike | null {
    const candidate = this.gatewayContext?.execApprovalManager as ExecApprovalManagerLike | undefined;
    if (!candidate) {
      return null;
    }
    if (typeof candidate.create !== "function" || typeof candidate.register !== "function") {
      return null;
    }
    return candidate;
  }

  private publish(event: string, payload: Record<string, unknown>): void {
    const gatewayContext = this.gatewayContext;
    try {
      gatewayContext?.broadcast?.(event, payload, { dropIfSlow: true });
    } catch (error) {
      this.api.logger.warn?.(`[guardian] 广播审批事件失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private warnSlowPath(kind: string, durationMs: number, thresholdMs: number, details: Record<string, unknown>): void {
    if (!this.diagnostics.enabled || durationMs < thresholdMs) {
      return;
    }
    const summary = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    this.api.logger.warn?.(
      `[guardian] ${kind} 耗时 ${durationMs}ms (阈值 ${thresholdMs}ms)${summary ? ` ${summary}` : ""}`,
    );
  }

  private applyPolicyOverrides(guardConfig: Record<string, unknown>, updateBasePolicy: boolean): void {
    if (updateBasePolicy) {
      const basePolicyKeys = [
        "preset",
        "defaultAction",
        "approvalTimeoutMs",
        "allowTools",
        "confirmTools",
        "denyTools",
        "allowPathPrefixes",
        "allowDomains",
        "allowCommandExecution",
        "allowDependencyInstall",
        "confirmStrategy",
        "capabilities",
        "networkUnknownAction",
        "sensitivePathAction",
        "highRiskAction",
      ];
      const basePolicyPatch: Record<string, unknown> = {};
      for (const key of basePolicyKeys) {
        if (Object.prototype.hasOwnProperty.call(guardConfig, key)) {
          basePolicyPatch[key] = guardConfig[key];
        }
      }
      const hasBasePolicyPatch = Object.keys(basePolicyPatch).length > 0;
      if (hasBasePolicyPatch) {
        const patchContainsPreset = Object.prototype.hasOwnProperty.call(basePolicyPatch, "preset");
        if (patchContainsPreset) {
          // preset 变更时必须回到对应预设默认值，避免沿用旧 preset 的衍生动作。
          this.basePolicy = normalizePolicy({ guardian: basePolicyPatch });
        } else {
          const currentBaseConfig: Record<string, unknown> = {
            preset: this.basePolicy.preset,
            defaultAction: this.basePolicy.defaultAction,
            approvalTimeoutMs: this.basePolicy.approvalTimeoutMs,
            allowTools: [...this.basePolicy.allowTools],
            confirmTools: [...this.basePolicy.confirmTools],
            denyTools: [...this.basePolicy.denyTools],
            allowPathPrefixes: [...this.basePolicy.allowPathPrefixes],
            allowDomains: [...this.basePolicy.allowDomains],
            allowCommandExecution: this.basePolicy.allowCommandExecution,
            allowDependencyInstall: this.basePolicy.allowDependencyInstall,
            confirmStrategy: this.basePolicy.confirmStrategy,
            capabilities: [...this.basePolicy.capabilities],
            networkUnknownAction: this.basePolicy.networkUnknownAction,
            sensitivePathAction: this.basePolicy.sensitivePathAction,
            highRiskAction: this.basePolicy.highRiskAction,
          };
          this.basePolicy = normalizePolicy({ guardian: { ...currentBaseConfig, ...basePolicyPatch } });
        }
      }
    }
    const version = toInt(guardConfig.securityPolicyVersion, 1);
    this.securityPolicyVersion = version > 0 ? version : 1;
    this.agentPolicyOverrides = normalizeAgentPolicyOverrides(guardConfig.securityPolicyByAgent);
  }

  private resolveEffectivePolicy(ctx: ToolContext): GuardPolicy {
    const agentId = normalizeAgentId(ctx.agentId);
    const override = agentId ? this.agentPolicyOverrides.get(agentId) : undefined;
    if (!override) {
      return this.basePolicy;
    }
    return {
      ...this.basePolicy,
      preset: override.preset ?? this.basePolicy.preset,
      defaultAction: override.defaultAction ?? this.basePolicy.defaultAction,
      allowTools: override.allowTools ?? this.basePolicy.allowTools,
      confirmTools: override.confirmTools ?? this.basePolicy.confirmTools,
      denyTools: override.denyTools ?? this.basePolicy.denyTools,
      allowPathPrefixes: override.allowPathPrefixes ?? this.basePolicy.allowPathPrefixes,
      allowDomains: override.allowDomains ?? this.basePolicy.allowDomains,
      allowCommandExecution: override.allowCommandExecution ?? this.basePolicy.allowCommandExecution,
      allowDependencyInstall: override.allowDependencyInstall ?? this.basePolicy.allowDependencyInstall,
      confirmStrategy: override.confirmStrategy ?? this.basePolicy.confirmStrategy,
      capabilities: override.capabilities ?? this.basePolicy.capabilities,
    };
  }

  syncPolicy(payload: unknown): { securityPolicyVersion: number; overrideAgentCount: number; preset: GuardPreset } {
    const guardConfig = isObject(payload)
      ? (isObject(payload.guardian) ? payload.guardian : payload)
      : {};
    if (isObject(guardConfig)) {
      this.applyPolicyOverrides(guardConfig, true);
    }
    return {
      securityPolicyVersion: this.securityPolicyVersion,
      overrideAgentCount: this.agentPolicyOverrides.size,
      preset: this.basePolicy.preset,
    };
  }

  private evaluatePolicy(
    policy: GuardPolicy,
    event: BeforeToolEvent,
    ctx: ToolContext,
  ): { risk: GuardRisk; action: GuardAction; reason: string; ruleId: string; requiredCapabilities: string[] } {
    const toolName = normalizeToolName(event.toolName);
    if (!toolName) {
      return { risk: "low", action: "allow", reason: "empty_tool_name", ruleId: "policy.empty_tool", requiredCapabilities: [] };
    }

    if (IMMUTABLE_DISABLE_TOOL_RE.test(toolName)) {
      return { risk: "critical", action: "deny", reason: "immutable_disable_guardian", ruleId: "immutable.disable_guardian", requiredCapabilities: [] };
    }
    const stringValues: Array<{ key: string; value: string }> = [];
    collectStrings(event.params, "params", stringValues);
    if (stringValues.some((entry) => PROMPT_INJECTION_RE.test(entry.value.toLowerCase()))) {
      return { risk: "critical", action: "deny", reason: "prompt_injection_detected", ruleId: "immutable.prompt_injection", requiredCapabilities: [] };
    }
    if (stringValues.some((entry) => SYSTEM_PROMPT_EXFIL_RE.test(entry.value.toLowerCase()))) {
      return { risk: "critical", action: "deny", reason: "system_prompt_exfiltration", ruleId: "immutable.system_prompt", requiredCapabilities: [] };
    }

    const allowAlwaysKey = `${ctx.sessionKey ?? "global"}::${normalizeAgentId(ctx.agentId) || "agent"}::${toolName}`;
    if (policy.allowTools.has(toolName)) {
      return { risk: "low", action: "allow", reason: "allowlist_tool", ruleId: "user.allow_tools", requiredCapabilities: [] };
    }
    if (policy.denyTools.has(toolName)) {
      return { risk: "critical", action: "deny", reason: "denylist_tool", ruleId: "user.deny_tools", requiredCapabilities: [] };
    }

    const requiredCapabilities = deriveRequiredCapabilities(toolName, event.params);
    const missingCapabilities = requiredCapabilities.filter((capability) => !policy.capabilities.has(capability));
    if (missingCapabilities.length > 0) {
      return { risk: "high", action: "deny", reason: "missing_capability", ruleId: "capability.missing", requiredCapabilities: missingCapabilities };
    }

    if (isDependencyInstallAttempt(toolName, event.params) && !policy.allowDependencyInstall) {
      return { risk: "high", action: "deny", reason: "dependency_install_disabled", ruleId: "policy.install_disabled", requiredCapabilities };
    }
    if (COMMAND_TOOL_RE.test(toolName) && !policy.allowCommandExecution) {
      return { risk: "high", action: "deny", reason: "command_execution_disabled", ruleId: "policy.command_disabled", requiredCapabilities };
    }

    const touchedPaths = extractPathsFromParams(event.params);
    const sensitivePath = touchedPaths.find((item) => isSensitivePath(item));
    if (sensitivePath) {
      return {
        risk: policy.sensitivePathAction === "deny" ? "critical" : "high",
        action: policy.sensitivePathAction,
        reason: "sensitive_path_access",
        ruleId: "path.sensitive",
        requiredCapabilities,
      };
    }
    const outsidePath = touchedPaths.find((item) => !isPathAllowed(item, policy.allowPathPrefixes));
    if (outsidePath) {
      const action: GuardAction = policy.preset === "strict" ? "deny" : "confirm";
      return {
        risk: action === "deny" ? "high" : "medium",
        action,
        reason: "path_outside_allowlist",
        ruleId: "path.allowlist",
        requiredCapabilities,
      };
    }

    const domains = extractDomainsFromParams(event.params);
    if (NETWORK_TOOL_RE.test(toolName)) {
      if (containsSensitiveValue(event.params)) {
        return { risk: "critical", action: "deny", reason: "sensitive_data_egress", ruleId: "immutable.secret_egress", requiredCapabilities };
      }
      const ipDomain = domains.find((item) => isIpAddress(item));
      if (ipDomain) {
        return { risk: "high", action: "confirm", reason: "raw_ip_destination", ruleId: "network.raw_ip", requiredCapabilities };
      }
      const unknownDomain = domains.find((item) => !isDomainAllowed(item, policy.allowDomains));
      if (unknownDomain || domains.length === 0) {
        return {
          risk: asRiskByAction(policy.networkUnknownAction),
          action: policy.networkUnknownAction,
          reason: "untrusted_network_destination",
          ruleId: "network.untrusted",
          requiredCapabilities,
        };
      }
    }

    if (policy.confirmTools.has(toolName)) {
      if (this.allowAlwaysCache.has(allowAlwaysKey)) {
        return { risk: "low", action: "allow", reason: "allow_always_cache", ruleId: "approval.session_cache", requiredCapabilities };
      }
      return { risk: "high", action: "confirm", reason: "confirmlist_tool", ruleId: "user.confirm_tools", requiredCapabilities };
    }
    const hasSensitive = containsSensitiveValue(event.params);
    if (HIGH_RISK_TOOL_RE.test(toolName) || hasSensitive) {
      return {
        risk: asRiskByAction(policy.highRiskAction),
        action: policy.highRiskAction,
        reason: hasSensitive ? "sensitive_payload" : "high_risk_tool",
        ruleId: "preset.high_risk",
        requiredCapabilities,
      };
    }
    return {
      risk: asRiskByAction(policy.defaultAction),
      action: policy.defaultAction,
      reason: "default_policy",
      ruleId: "policy.default",
      requiredCapabilities,
    };
  }

  private async ensureAuditDbReady(): Promise<void> {
    if (this.auditDb) {
      return;
    }
    if (this.auditDbReady) {
      await this.auditDbReady;
      return;
    }
    this.auditDbReady = (async () => {
      await mkdir(path.dirname(this.auditDbPath), { recursive: true });
      const sqliteModuleName = "node:sqlite";
      const sqlite = await import(/* @vite-ignore */ sqliteModuleName);
      this.auditDb = new sqlite.DatabaseSync(this.auditDbPath);
      this.auditDb.exec(`
        CREATE TABLE IF NOT EXISTS guardian_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          trace_id TEXT NOT NULL,
          run_id TEXT,
          session_key TEXT,
          agent_id TEXT,
          tool_name TEXT NOT NULL,
          risk TEXT NOT NULL,
          action TEXT NOT NULL,
          decision TEXT NOT NULL,
          duration_ms INTEGER,
          result TEXT NOT NULL,
          params_preview TEXT NOT NULL,
          policy_version INTEGER NOT NULL DEFAULT 1,
          policy_preset TEXT NOT NULL DEFAULT 'balanced',
          rule_id TEXT,
          required_capabilities TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_ts ON guardian_audit(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_run_id ON guardian_audit(run_id);
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_agent_id ON guardian_audit(agent_id);
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_session_key ON guardian_audit(session_key);
      `);
      const tableInfo = this.auditDb.prepare("PRAGMA table_info(guardian_audit)").all() as Array<{ name?: string }>;
      const columns = new Set(tableInfo.map((item) => String(item.name ?? "")));
      if (!columns.has("policy_version")) {
        this.auditDb.exec("ALTER TABLE guardian_audit ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1;");
      }
      if (!columns.has("policy_preset")) {
        this.auditDb.exec("ALTER TABLE guardian_audit ADD COLUMN policy_preset TEXT NOT NULL DEFAULT 'balanced';");
      }
      if (!columns.has("rule_id")) {
        this.auditDb.exec("ALTER TABLE guardian_audit ADD COLUMN rule_id TEXT;");
      }
      if (!columns.has("required_capabilities")) {
        this.auditDb.exec("ALTER TABLE guardian_audit ADD COLUMN required_capabilities TEXT NOT NULL DEFAULT '[]';");
      }
    })();
    await this.auditDbReady;
  }

  private async appendAudit(event: GuardAuditEvent): Promise<void> {
    const appendStartedAt = Date.now();
    try {
      await this.ensureAuditDbReady();
      const stmt = this.auditDb.prepare(`
        INSERT INTO guardian_audit (
          ts, trace_id, run_id, session_key, agent_id, tool_name, risk, action, decision, duration_ms, result, params_preview,
          policy_version, policy_preset, rule_id, required_capabilities
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      const writeStartedAt = Date.now();
      stmt.run(
        event.ts,
        event.traceId,
        event.runId,
        event.sessionKey,
        event.agentId,
        event.toolName,
        event.risk,
        event.action,
        event.decision,
        event.durationMs,
        event.result,
        JSON.stringify(event.paramsPreview),
        event.policyVersion,
        event.policyPreset,
        event.ruleId,
        JSON.stringify(event.requiredCapabilities),
      );
      const writeDurationMs = Math.max(0, Date.now() - writeStartedAt);
      this.warnSlowPath("audit 写入", writeDurationMs, this.diagnostics.slowAuditWriteMs, {
        runId: event.runId,
        toolName: event.toolName,
        decision: event.decision,
        result: event.result,
      });
    } catch (error) {
      this.api.logger.warn?.(`[guardian] 写审计失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const appendDurationMs = Math.max(0, Date.now() - appendStartedAt);
      this.warnSlowPath("audit 追加", appendDurationMs, this.diagnostics.slowAuditWriteMs, {
        runId: event.runId,
        toolName: event.toolName,
        decision: event.decision,
      });
    }
  }

  async beforeToolCall(event: BeforeToolEvent, ctx: ToolContext): Promise<{ block: boolean; blockReason: string } | void> {
    const hookStartedAt = Date.now();
    let action: GuardAction | "unknown" = "unknown";
    let ruleId = "unknown";
    let decisionForLog = "n/a";
    this.bindGatewayContextFromToolContext(ctx);
    try {
      const now = Date.now();
      const traceId = `${event.runId ?? "run"}:${event.toolCallId ?? "tool"}:${sha256(`${event.toolName}:${now}`).slice(0, 8)}`;
      const paramsPreview = buildParamsPreview(event.params);
      const policy = this.resolveEffectivePolicy(ctx);
      const evaluated = this.evaluatePolicy(policy, event, ctx);
      const { risk, action: resolvedAction, reason, ruleId: resolvedRuleId, requiredCapabilities } = evaluated;
      action = resolvedAction;
      ruleId = resolvedRuleId;
      const traceKey = computeTraceKey(event, ctx);

      if (action === "allow") {
        decisionForLog = "allow";
        this.traces.set(traceKey, {
          traceId,
          startedAtMs: now,
          runId: event.runId ?? null,
          sessionKey: ctx.sessionKey ?? null,
          agentId: ctx.agentId ?? null,
          toolName: event.toolName,
          risk,
          action,
          decision: "allow",
          paramsPreview,
          policyVersion: this.securityPolicyVersion,
          policyPreset: policy.preset,
          ruleId,
          requiredCapabilities,
        });
        return;
      }

      if (action === "deny") {
        decisionForLog = "deny";
        await this.appendAudit({
          traceId,
          runId: event.runId ?? null,
          sessionKey: ctx.sessionKey ?? null,
          agentId: ctx.agentId ?? null,
          toolName: event.toolName,
          risk,
          action,
          decision: "deny",
          durationMs: 0,
          result: "blocked",
          paramsPreview,
          policyVersion: this.securityPolicyVersion,
          policyPreset: policy.preset,
          ruleId,
          requiredCapabilities,
          ts: now,
        });
        return { block: true, blockReason: `Guardian blocked: ${reason}` };
      }

      const manager = this.resolveApprovalManager();
      if (!manager) {
        decisionForLog = "deny";
        await this.appendAudit({
          traceId,
          runId: event.runId ?? null,
          sessionKey: ctx.sessionKey ?? null,
          agentId: ctx.agentId ?? null,
          toolName: event.toolName,
          risk,
          action,
          decision: "deny",
          durationMs: 0,
          result: "blocked",
          paramsPreview,
          policyVersion: this.securityPolicyVersion,
          policyPreset: policy.preset,
          ruleId,
          requiredCapabilities,
          ts: now,
        });
        return { block: true, blockReason: "Guardian blocked: approval manager unavailable" };
      }

      const requestPayload: Record<string, unknown> = {
        command: `${event.toolName} (guard-confirm)`,
        host: "gateway",
        security: "allowlist",
        ask: "always",
        agentId: ctx.agentId ?? null,
        sessionKey: ctx.sessionKey ?? null,
        turnSourceChannel: "matchaclaw",
        turnSourceTo: ctx.sessionKey ?? null,
        turnSourceAccountId: ctx.agentId ?? null,
        toolName: event.toolName,
        runId: event.runId ?? null,
        toolCallId: event.toolCallId ?? null,
        paramsPreview,
        ruleId,
        policyPreset: policy.preset,
        requiredCapabilities,
        reason,
      };

      const record = manager.create(requestPayload, policy.approvalTimeoutMs, null);
      const decisionPromise = manager.register(record, policy.approvalTimeoutMs);

      this.publish("exec.approval.requested", {
        id: record.id,
        request: {
          ...record.request,
          sessionKey: ctx.sessionKey ?? null,
          runId: event.runId ?? null,
          toolName: event.toolName,
        },
        sessionKey: ctx.sessionKey ?? null,
        runId: event.runId ?? null,
        toolName: event.toolName,
        createdAt: record.createdAtMs,
        expiresAt: record.expiresAtMs,
      });

      const approvalWaitStartedAt = Date.now();
      const rawDecision = await decisionPromise;
      const approvalWaitDurationMs = Math.max(0, Date.now() - approvalWaitStartedAt);
      this.warnSlowPath("审批等待", approvalWaitDurationMs, this.diagnostics.slowApprovalWaitMs, {
        runId: event.runId ?? null,
        toolCallId: event.toolCallId ?? null,
        toolName: event.toolName,
        ruleId,
      });
      const decisionRaw = normalizeDecision(rawDecision) ?? "deny";
      const decision = decisionRaw === "allow-always" && policy.confirmStrategy === "every_time"
        ? "allow-once"
        : decisionRaw;
      decisionForLog = decision;
      this.publish("exec.approval.resolved", {
        id: record.id,
        decision,
        resolvedBy: "user",
        ts: Date.now(),
        request: {
          ...record.request,
          sessionKey: ctx.sessionKey ?? null,
          runId: event.runId ?? null,
          toolName: event.toolName,
        },
        sessionKey: ctx.sessionKey ?? null,
        runId: event.runId ?? null,
        toolName: event.toolName,
      });

      if (decision === "allow-always" && policy.confirmStrategy === "session" && ruleId === "user.confirm_tools") {
        const key = `${ctx.sessionKey ?? "global"}::${normalizeAgentId(ctx.agentId) || "agent"}::${normalizeToolName(event.toolName)}`;
        this.allowAlwaysCache.add(key);
      }

      if (decision === "allow-once" || decision === "allow-always") {
        this.traces.set(traceKey, {
          traceId,
          startedAtMs: now,
          runId: event.runId ?? null,
          sessionKey: ctx.sessionKey ?? null,
          agentId: ctx.agentId ?? null,
          toolName: event.toolName,
          risk,
          action,
          decision,
          paramsPreview,
          policyVersion: this.securityPolicyVersion,
          policyPreset: policy.preset,
          ruleId,
          requiredCapabilities,
        });
        return;
      }

      await this.appendAudit({
        traceId,
        runId: event.runId ?? null,
        sessionKey: ctx.sessionKey ?? null,
        agentId: ctx.agentId ?? null,
        toolName: event.toolName,
        risk,
        action,
        decision: "deny",
        durationMs: Date.now() - now,
        result: "blocked",
        paramsPreview,
        policyVersion: this.securityPolicyVersion,
        policyPreset: policy.preset,
        ruleId,
        requiredCapabilities,
        ts: Date.now(),
      });
      return { block: true, blockReason: "Guardian blocked: approval denied" };
    } finally {
      const hookDurationMs = Math.max(0, Date.now() - hookStartedAt);
      this.warnSlowPath("before_tool_call", hookDurationMs, this.diagnostics.slowBeforeToolCallMs, {
        runId: event.runId ?? null,
        toolCallId: event.toolCallId ?? null,
        toolName: event.toolName,
        action,
        decision: decisionForLog,
        ruleId,
      });
    }
  }

  async afterToolCall(event: AfterToolEvent, ctx: ToolContext): Promise<void> {
    const hookStartedAt = Date.now();
    let decisionForLog: GuardDecision = "allow";
    this.bindGatewayContextFromToolContext(ctx);
    try {
      const traceKey = computeTraceKey(event, ctx);
      const trace = this.traces.get(traceKey);
      if (trace) {
        this.traces.delete(traceKey);
      }
      const durationMs = typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
        ? Math.floor(event.durationMs)
        : trace
          ? Math.max(0, Date.now() - trace.startedAtMs)
          : null;
      const paramsPreview = trace?.paramsPreview ?? buildParamsPreview(event.params ?? {});
      const decision = trace?.decision ?? "allow";
      decisionForLog = decision;
      const result = event.error ? "error" : "ok";
      const policy = this.resolveEffectivePolicy(ctx);
      await this.appendAudit({
        traceId: trace?.traceId ?? `${event.runId ?? "run"}:${event.toolCallId ?? "tool"}:${sha256(`${event.toolName}:${Date.now()}`).slice(0, 8)}`,
        runId: event.runId ?? trace?.runId ?? null,
        sessionKey: ctx.sessionKey ?? trace?.sessionKey ?? null,
        agentId: ctx.agentId ?? trace?.agentId ?? null,
        toolName: event.toolName,
        risk: trace?.risk ?? "low",
        action: trace?.action ?? "allow",
        decision,
        durationMs,
        result,
        paramsPreview,
        policyVersion: trace?.policyVersion ?? this.securityPolicyVersion,
        policyPreset: trace?.policyPreset ?? policy.preset,
        ruleId: trace?.ruleId ?? "after_tool_call",
        requiredCapabilities: trace?.requiredCapabilities ?? deriveRequiredCapabilities(normalizeToolName(event.toolName), event.params ?? {}),
        ts: Date.now(),
      });
    } finally {
      const hookDurationMs = Math.max(0, Date.now() - hookStartedAt);
      this.warnSlowPath("after_tool_call", hookDurationMs, this.diagnostics.slowAfterToolCallMs, {
        runId: event.runId ?? null,
        toolCallId: event.toolCallId ?? null,
        toolName: event.toolName,
        decision: decisionForLog,
      });
    }
  }

  async queryAudits(query: GuardQuery): Promise<{
    page: number;
    pageSize: number;
    total: number;
    items: Array<Record<string, unknown>>;
  }> {
    await this.ensureAuditDbReady();
    const page = Math.max(1, toInt(query.page, 1));
    const pageSize = Math.max(1, Math.min(200, toInt(query.pageSize, 20)));
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const params: unknown[] = [];

    const addLike = (field: string, value: unknown): void => {
      if (typeof value !== "string" || !value.trim()) {
        return;
      }
      whereParts.push(`${field} = ?`);
      params.push(value.trim());
    };

    addLike("agent_id", query.agentId);
    addLike("run_id", query.runId);
    addLike("session_key", query.sessionKey);
    addLike("risk", query.risk);
    addLike("action", query.action);
    addLike("policy_preset", query.policyPreset);
    addLike("rule_id", query.ruleId);

    const fromMs = toInt(query.fromMs, 0);
    if (fromMs > 0) {
      whereParts.push("ts >= ?");
      params.push(fromMs);
    }
    const toMs = toInt(query.toMs, 0);
    if (toMs > 0) {
      whereParts.push("ts <= ?");
      params.push(toMs);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    const totalStmt = this.auditDb.prepare(`SELECT COUNT(1) as count FROM guardian_audit ${whereSql}`);
    const totalRow = totalStmt.get(...params) as { count?: number } | undefined;
    const total = typeof totalRow?.count === "number" ? totalRow.count : 0;

    const listStmt = this.auditDb.prepare(`
      SELECT
        ts,
        trace_id as traceId,
        run_id as runId,
        session_key as sessionKey,
        agent_id as agentId,
        tool_name as toolName,
        risk,
        action,
        decision,
        duration_ms as durationMs,
        result,
        params_preview as paramsPreview,
        policy_version as policyVersion,
        policy_preset as policyPreset,
        rule_id as ruleId,
        required_capabilities as requiredCapabilities
      FROM guardian_audit
      ${whereSql}
      ORDER BY ts DESC
      LIMIT ?
      OFFSET ?
    `);
    const rows = listStmt.all(...params, pageSize, offset) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      ...row,
      decision: normalizeDecisionText((typeof row.decision === "string" ? row.decision : "allow") as GuardDecision),
      paramsPreview: (() => {
        if (typeof row.paramsPreview !== "string") {
          return {};
        }
        try {
          return JSON.parse(row.paramsPreview);
        } catch {
          return {};
        }
      })(),
      requiredCapabilities: (() => {
        if (typeof row.requiredCapabilities !== "string") {
          return [];
        }
        try {
          const parsed = JSON.parse(row.requiredCapabilities);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    }));
    return { page, pageSize, total, items };
  }
}

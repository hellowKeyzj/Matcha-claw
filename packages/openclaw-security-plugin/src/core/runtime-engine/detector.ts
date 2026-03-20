import { scanForPatterns } from "../../vendor/shield-core/scanner.js";
import { SECRET_PATTERNS, type NamedPattern } from "../../vendor/shield-core/patterns.js";
import { detectDestructive } from "../../vendor/clawguardian-destructive/detector.js";
import type { SecurityCoreRuntimeConfig } from "../types.js";
import type {
  DetectBeforeToolCallInput,
  RuntimeDestructiveDetection,
  RuntimePolicyDetection,
  RuntimeDetection,
  RuntimeSecretDetection,
} from "./types.js";
import { compileExtraPatternsCached, highestSecretSeverity } from "./shared.js";

const SECURECLAW_SECRET_PATTERNS: NamedPattern[] = [
  { name: "anthropic_key_v2", pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: "openai_project_key", pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/ },
  { name: "generic_sk_key", pattern: /sk-[a-zA-Z0-9_-]{20,}/ },
];

const SECRET_BASELINE_PATTERNS: NamedPattern[] = [
  ...SECRET_PATTERNS,
  ...SECURECLAW_SECRET_PATTERNS,
];

const PROMPT_INJECTION_BASE_PATTERNS: NamedPattern[] = [
  { name: "prompt_injection_ignore_previous", pattern: /ignore\s+(?:all\s+)?previous\s+instructions?/i },
  { name: "prompt_injection_override", pattern: /(?:new|override)\s+(?:system|developer)\s+prompt/i },
  { name: "prompt_injection_you_are_now", pattern: /you\s+are\s+now\s+(?:an?\s+)?/i },
  { name: "prompt_injection_exfiltrate", pattern: /\b(?:exfiltrate|leak|dump)\b.{0,32}\b(?:secret|credential|token|key|prompt)\b/i },
  { name: "prompt_injection_data_forward", pattern: /\b(?:forward|send|post)\b.{0,32}\b(?:to|http|https|webhook)\b/i },
];

const PATH_HINT_KEYS = new Set([
  "path",
  "paths",
  "filepath",
  "file_path",
  "filename",
  "file",
  "target",
  "targetpath",
  "target_path",
  "dest",
  "destination",
  "output",
  "outputpath",
  "output_path",
  "inputfile",
  "input_file",
  "workspace",
  "workdir",
  "cwd",
  "root",
  "dir",
  "directory",
  "patch",
  "applypatch",
  "apply_patch",
]);

const DOMAIN_HINT_KEYS = new Set([
  "url",
  "uri",
  "endpoint",
  "baseurl",
  "base_url",
  "domain",
  "host",
  "hostname",
  "origin",
  "website",
  "webhook",
  "proxy",
]);

const URL_RE = /\bhttps?:\/\/[^\s"'<>()]+/gi;
const APPLY_PATCH_FILE_RE = /^\*\*\*\s(?:Add|Update|Delete)\sFile:\s+(.+)$/gm;
const APPLY_PATCH_MOVE_RE = /^\*\*\*\sMove to:\s+(.+)$/gm;
const TOKEN_SPLIT_RE = /"[^"]*"|'[^']*'|\S+/g;

const PATH_PREFIX_CACHE = new Map<string, string[]>();
const DOMAIN_ALLOWLIST_CACHE = new Map<string, string[]>();
const PROMPT_PATTERN_CACHE = new Map<string, NamedPattern[]>();

type StringEntry = {
  key: string;
  value: string;
};

function destructiveCategoryEnabled(
  category: string,
  runtimeConfig: SecurityCoreRuntimeConfig,
): boolean {
  const categories = runtimeConfig.destructiveCategories;
  switch (category) {
    case "file_delete":
      return categories.fileDelete;
    case "git_destructive":
      return categories.gitDestructive;
    case "sql_destructive":
      return categories.sqlDestructive;
    case "system_destructive":
      return categories.systemDestructive;
    case "process_kill":
      return categories.processKill;
    case "network_destructive":
      return categories.networkDestructive;
    case "privilege_escalation":
      return categories.privilegeEscalation;
    default:
      return true;
  }
}

function normalizeList(values: string[]): string[] {
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeListKey(values: string[]): string {
  return normalizeList(values).join("\u0001");
}

function collectStringEntries(value: unknown, limit = 256): StringEntry[] {
  const output: StringEntry[] = [];
  const stack: Array<{ key: string; value: unknown }> = [{ key: "", value }];

  while (stack.length > 0 && output.length < limit) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const node = current.value;
    if (typeof node === "string") {
      output.push({ key: current.key, value: node });
      continue;
    }
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push({ key: current.key, value: node[index] });
      }
      continue;
    }
    if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, next] = entries[index]!;
        stack.push({ key, value: next });
      }
    }
  }

  return output;
}

function trimQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 1) {
    return trimmed;
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function looksLikePath(rawValue: string): boolean {
  const value = trimQuotes(rawValue);
  if (value.length < 2) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  return (
    value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("~")
    || /^[a-zA-Z]:[\\/]/.test(value)
    || value.includes("/")
    || value.includes("\\")
  );
}

function normalizePathText(rawValue: string): string {
  const value = trimQuotes(rawValue).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (value.length === 0) {
    return "";
  }
  if (value === "/") {
    return "/";
  }
  if (/^[a-zA-Z]:\/$/.test(value)) {
    return value.toLowerCase();
  }
  return value.replace(/\/+$/, "").toLowerCase();
}

function normalizePathPrefixesCached(prefixes: string[]): string[] {
  const cacheKey = normalizeListKey(prefixes);
  if (!cacheKey) {
    return [];
  }
  const cached = PATH_PREFIX_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const normalized = normalizeList(prefixes)
    .map((prefix) => normalizePathText(prefix))
    .filter((prefix) => prefix.length > 0);
  PATH_PREFIX_CACHE.set(cacheKey, normalized);
  return normalized;
}

function normalizeDomain(rawDomain: string): string {
  const trimmed = trimQuotes(rawDomain).toLowerCase();
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutPath = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  const withoutPort = withoutPath.split(":", 1)[0] ?? "";
  const withoutWildcard = withoutPort.startsWith("*.") ? withoutPort.slice(2) : withoutPort;
  return withoutWildcard.trim();
}

function normalizeDomainsCached(domains: string[]): string[] {
  const cacheKey = normalizeListKey(domains);
  if (!cacheKey) {
    return [];
  }
  const cached = DOMAIN_ALLOWLIST_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const normalized = normalizeList(domains)
    .map((domain) => normalizeDomain(domain))
    .filter((domain) => domain.length > 0);
  DOMAIN_ALLOWLIST_CACHE.set(cacheKey, normalized);
  return normalized;
}

function isPathAllowed(pathValue: string, allowPrefixes: string[]): boolean {
  const normalizedPath = normalizePathText(pathValue);
  if (!normalizedPath) {
    return true;
  }
  return allowPrefixes.some((prefix) => {
    if (normalizedPath === prefix) return true;
    if (prefix === "/") return normalizedPath.startsWith("/");
    return normalizedPath.startsWith(`${prefix}/`);
  });
}

function isLocalDomain(domain: string): boolean {
  return domain === "localhost" || domain === "127.0.0.1" || domain === "::1";
}

function isDomainAllowed(domainValue: string, allowDomains: string[]): boolean {
  const normalizedDomain = normalizeDomain(domainValue);
  if (!normalizedDomain || isLocalDomain(normalizedDomain)) {
    return true;
  }
  return allowDomains.some((allowed) => (
    normalizedDomain === allowed || normalizedDomain.endsWith(`.${allowed}`)
  ));
}

function parseApplyPatchPaths(rawPatch: string): string[] {
  const matches: string[] = [];
  APPLY_PATCH_FILE_RE.lastIndex = 0;
  APPLY_PATCH_MOVE_RE.lastIndex = 0;

  let match: RegExpExecArray | null = null;
  while ((match = APPLY_PATCH_FILE_RE.exec(rawPatch)) !== null) {
    const filePath = match[1]?.trim();
    if (filePath) {
      matches.push(filePath);
    }
  }
  while ((match = APPLY_PATCH_MOVE_RE.exec(rawPatch)) !== null) {
    const filePath = match[1]?.trim();
    if (filePath) {
      matches.push(filePath);
    }
  }
  return matches;
}

function tokenize(text: string): string[] {
  const matches = text.match(TOKEN_SPLIT_RE);
  if (!matches) return [];
  return matches;
}

function extractPathsFromCommandText(commandText: string): string[] {
  const candidates: string[] = [];
  const tokens = tokenize(commandText);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = trimQuotes(tokens[index] ?? "");
    if (!token) continue;
    if (looksLikePath(token)) {
      candidates.push(token);
    }
  }
  return candidates;
}

function extractPathCandidates(
  toolName: string,
  toolParams: Record<string, unknown>,
  entries: StringEntry[],
): string[] {
  const output = new Set<string>();
  const lowerToolName = toolName.toLowerCase();

  const pushPath = (rawValue: string): void => {
    const value = trimQuotes(rawValue);
    if (!value) return;
    if (looksLikePath(value)) {
      output.add(value);
    }
  };

  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    if (
      PATH_HINT_KEYS.has(key)
      || key.endsWith("path")
      || key.endsWith("file")
      || key.endsWith("dir")
      || key.endsWith("directory")
    ) {
      pushPath(entry.value);
    }
    if (key === "command" || key === "cmd" || key === "input") {
      extractPathsFromCommandText(entry.value).forEach((value) => pushPath(value));
    }
  }

  if (Array.isArray(toolParams.args)) {
    toolParams.args
      .filter((item): item is string => typeof item === "string")
      .forEach((value) => pushPath(value));
  }

  if (lowerToolName.includes("apply_patch")) {
    const patch = typeof toolParams.input === "string"
      ? toolParams.input
      : typeof toolParams.patch === "string"
        ? toolParams.patch
        : "";
    if (patch) {
      parseApplyPatchPaths(patch).forEach((value) => pushPath(value));
    }
  }

  return [...output];
}

function extractDomainCandidates(
  toolParams: Record<string, unknown>,
  entries: StringEntry[],
): string[] {
  const output = new Set<string>();

  const pushDomainValue = (rawValue: string): void => {
    const value = trimQuotes(rawValue);
    if (!value) return;

    URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    let matchedUrl = false;
    while ((match = URL_RE.exec(value)) !== null) {
      matchedUrl = true;
      output.add(match[0]);
    }
    if (matchedUrl) return;

    const normalized = normalizeDomain(value);
    if (normalized) {
      output.add(normalized);
    }
  };

  for (const entry of entries) {
    const key = entry.key.toLowerCase();
    if (DOMAIN_HINT_KEYS.has(key) || key.endsWith("url") || key.endsWith("domain") || key.endsWith("host")) {
      pushDomainValue(entry.value);
      continue;
    }

    URL_RE.lastIndex = 0;
    if (URL_RE.test(entry.value)) {
      pushDomainValue(entry.value);
    }
  }

  const directUrl = typeof toolParams.url === "string" ? toolParams.url : undefined;
  if (directUrl) {
    pushDomainValue(directUrl);
  }

  return [...output];
}

function resolvePromptPatterns(extraPatterns: string[]): NamedPattern[] {
  const cacheKey = normalizeListKey(extraPatterns);
  const cached = PROMPT_PATTERN_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = [
    ...PROMPT_INJECTION_BASE_PATTERNS,
    ...compileExtraPatternsCached(extraPatterns, "prompt_injection_extra"),
  ];
  PROMPT_PATTERN_CACHE.set(cacheKey, resolved);
  return resolved;
}

function firstPromptInjectionHit(fullText: string, extraPatterns: string[]): string | undefined {
  if (!fullText.trim()) {
    return undefined;
  }
  const patterns = resolvePromptPatterns(extraPatterns);
  for (const item of patterns) {
    if (item.pattern.test(fullText)) {
      return item.name;
    }
  }
  return undefined;
}

type PolicyRuleInput = {
  toolName: string;
  toolParams: Record<string, unknown>;
  fullText: string;
  runtimeConfig: SecurityCoreRuntimeConfig;
  entries: StringEntry[];
};

type PolicyRuleContext = PolicyRuleInput & {
  cache: {
    allowPrefixes?: string[];
    pathCandidates?: string[];
    allowDomains?: string[];
    domainCandidates?: string[];
    promptHitResolved?: boolean;
    promptHit?: string;
  };
};

type PolicyRule = {
  name: string;
  enabled: (ctx: PolicyRuleContext) => boolean;
  execute: (ctx: PolicyRuleContext) => RuntimePolicyDetection | undefined;
};

function getAllowPrefixes(ctx: PolicyRuleContext): string[] {
  if (!ctx.cache.allowPrefixes) {
    ctx.cache.allowPrefixes = normalizePathPrefixesCached(ctx.runtimeConfig.allowPathPrefixes);
  }
  return ctx.cache.allowPrefixes;
}

function getPathCandidates(ctx: PolicyRuleContext): string[] {
  if (!ctx.cache.pathCandidates) {
    ctx.cache.pathCandidates = extractPathCandidates(ctx.toolName, ctx.toolParams, ctx.entries);
  }
  return ctx.cache.pathCandidates;
}

function getAllowDomains(ctx: PolicyRuleContext): string[] {
  if (!ctx.cache.allowDomains) {
    ctx.cache.allowDomains = normalizeDomainsCached(ctx.runtimeConfig.allowDomains);
  }
  return ctx.cache.allowDomains;
}

function getDomainCandidates(ctx: PolicyRuleContext): string[] {
  if (!ctx.cache.domainCandidates) {
    ctx.cache.domainCandidates = extractDomainCandidates(ctx.toolParams, ctx.entries);
  }
  return ctx.cache.domainCandidates;
}

function getPromptInjectionHit(ctx: PolicyRuleContext): string | undefined {
  if (!ctx.cache.promptHitResolved) {
    ctx.cache.promptHit = firstPromptInjectionHit(
      ctx.fullText,
      ctx.runtimeConfig.extraPromptInjectionPatterns,
    );
    ctx.cache.promptHitResolved = true;
  }
  return ctx.cache.promptHit;
}

function executePathPrefixRule(ctx: PolicyRuleContext): RuntimePolicyDetection | undefined {
  const allowPrefixes = getAllowPrefixes(ctx);
  if (allowPrefixes.length === 0) {
    return undefined;
  }
  const blockedPath = getPathCandidates(ctx).find((pathValue) => !isPathAllowed(pathValue, allowPrefixes));
  if (!blockedPath) {
    return undefined;
  }
  return {
    kind: "policy",
    ruleId: "SC-RUNTIME-006",
    severity: "high",
    detail: `path outside allowPathPrefixes: ${blockedPath}`,
    reason: `Blocked by security-core: path '${blockedPath}' is outside allowPathPrefixes`,
    forceBlock: true,
    loggable: true,
  };
}

function executeDomainRule(ctx: PolicyRuleContext): RuntimePolicyDetection | undefined {
  const allowDomains = getAllowDomains(ctx);
  if (allowDomains.length === 0) {
    return undefined;
  }
  const blockedDomain = getDomainCandidates(ctx).find((domain) => !isDomainAllowed(domain, allowDomains));
  if (!blockedDomain) {
    return undefined;
  }
  return {
    kind: "policy",
    ruleId: "SC-RUNTIME-007",
    severity: "high",
    detail: `domain outside allowDomains: ${blockedDomain}`,
    reason: `Blocked by security-core: domain '${blockedDomain}' is outside allowDomains`,
    forceBlock: true,
    loggable: true,
  };
}

function executePromptInjectionRule(ctx: PolicyRuleContext): RuntimePolicyDetection | undefined {
  const hit = getPromptInjectionHit(ctx);
  if (!hit) {
    return undefined;
  }
  return {
    kind: "policy",
    ruleId: "SC-RUNTIME-008",
    severity: "high",
    detail: `prompt injection pattern: ${hit}`,
    reason: `Blocked by security-core: prompt injection pattern detected (${hit})`,
    forceBlock: true,
    loggable: true,
  };
}

const POLICY_RULE_PIPELINE: PolicyRule[] = [
  {
    name: "allow_path_prefixes",
    enabled: (ctx) => ctx.runtimeConfig.allowPathPrefixes.length > 0,
    execute: executePathPrefixRule,
  },
  {
    name: "allow_domains",
    enabled: (ctx) => ctx.runtimeConfig.allowDomains.length > 0,
    execute: executeDomainRule,
  },
  {
    name: "prompt_injection",
    enabled: (ctx) => ctx.runtimeConfig.enablePromptInjectionGuard,
    execute: executePromptInjectionRule,
  },
];

function executePolicyRulePipeline(input: PolicyRuleInput): RuntimePolicyDetection | undefined {
  const ctx: PolicyRuleContext = {
    ...input,
    cache: {},
  };
  for (const rule of POLICY_RULE_PIPELINE) {
    if (!rule.enabled(ctx)) {
      continue;
    }
    const detection = rule.execute(ctx);
    if (detection) {
      return detection;
    }
  }
  return undefined;
}

function buildPolicyDetection(input: PolicyRuleInput): RuntimePolicyDetection | undefined {
  return executePolicyRulePipeline(input);
}

function buildDestructiveMatch(
  input: DetectBeforeToolCallInput,
): RuntimeDestructiveDetection | undefined {
  if (!input.runtimeConfig.blockDestructive) {
    return undefined;
  }
  const destructiveMatch = detectDestructive(input.toolName, input.toolParams);
  if (destructiveMatch && destructiveCategoryEnabled(destructiveMatch.category, input.runtimeConfig)) {
    return {
      kind: "destructive",
      ruleId: "SC-RUNTIME-001",
      severity: destructiveMatch.severity,
      detail: `${destructiveMatch.reason}; ${destructiveMatch.category}; ${destructiveMatch.pattern}`,
      reason: destructiveMatch.reason,
      category: destructiveMatch.category,
      pattern: destructiveMatch.pattern,
      forceBlock: false,
      loggable: true,
    };
  }

  const destructivePatterns = compileExtraPatternsCached(
    input.runtimeConfig.extraDestructivePatterns,
    "destructive_extra",
  );
  if (destructivePatterns.length === 0) {
    return undefined;
  }
  const destructiveHits = scanForPatterns(input.fullText, destructivePatterns);
  if (destructiveHits.length === 0) {
    return undefined;
  }
  return {
    kind: "destructive",
    ruleId: "SC-RUNTIME-001",
    severity: "high",
    detail: destructiveHits.map((item) => item.name).join(", "),
    reason: destructiveHits[0]?.name ?? "match",
    category: "system_destructive",
    pattern: destructiveHits[0]?.name ?? "match",
    forceBlock: true,
    loggable: false,
  };
}

function buildSecretMatch(
  input: DetectBeforeToolCallInput,
): RuntimeSecretDetection | undefined {
  if (!input.runtimeConfig.blockSecrets) {
    return undefined;
  }
  const secretPatterns: NamedPattern[] = [
    ...SECRET_BASELINE_PATTERNS,
    ...compileExtraPatternsCached(input.runtimeConfig.extraSecretPatterns, "secret_extra"),
  ];
  const secretHits = scanForPatterns(input.fullText, secretPatterns);
  if (secretHits.length === 0) {
    return undefined;
  }
  const hitNames = secretHits.map((item) => item.name);
  return {
    kind: "secret",
    ruleId: "SC-RUNTIME-002",
    severity: highestSecretSeverity(hitNames),
    detail: hitNames.join(", "),
    hitNames,
    redactionPatterns: secretPatterns,
    loggable: true,
  };
}

export function buildToolCallText(toolParams: Record<string, unknown>): string {
  const entries = collectStringEntries(toolParams, 512);
  if (entries.length === 0) {
    return "";
  }
  return entries.map((item) => item.value).join(" ");
}

export function detectBeforeToolCall(input: DetectBeforeToolCallInput): RuntimeDetection | undefined {
  const entries = collectStringEntries(input.toolParams, 256);
  const policyDetection = buildPolicyDetection({
    toolName: input.toolName,
    toolParams: input.toolParams,
    fullText: input.fullText,
    runtimeConfig: input.runtimeConfig,
    entries,
  });
  if (policyDetection) {
    return policyDetection;
  }

  const destructiveDetection = buildDestructiveMatch(input);
  if (destructiveDetection) {
    return destructiveDetection;
  }
  return buildSecretMatch(input);
}

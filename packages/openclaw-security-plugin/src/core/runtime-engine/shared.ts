import { redactPatterns, walkStrings } from "../../vendor/shield-core/scanner.js";
import type { NamedPattern } from "../../vendor/shield-core/patterns.js";
import type {
  SecurityCoreRuntimeConfig,
  SecurityGuardAction,
  SecurityGuardSeverity,
  SecurityRisk,
} from "../types.js";

const COMPILED_PATTERN_CACHE = new Map<string, NamedPattern[]>();
const EXEC_STYLE_TOOL_RE = /(?:^|\.)(exec|bash|run|shell|command)$/i;

export const CONFIRM_FLAG = "_clawguardian_confirm";
export const SECURITY_CONFIRM_FLAG = "_security_core_confirm";

function normalizePatternList(patterns: string[]): string[] {
  return patterns
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function compileExtraPatternsCached(patterns: string[], prefix: string): NamedPattern[] {
  const normalized = normalizePatternList(patterns);
  if (normalized.length === 0) {
    return [];
  }
  const cacheKey = `${prefix}:${normalized.join("\u0001")}`;
  const cached = COMPILED_PATTERN_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const output: NamedPattern[] = [];
  normalized.forEach((rawPattern, index) => {
    try {
      output.push({
        name: `${prefix}_${index + 1}`,
        pattern: new RegExp(rawPattern, "i"),
      });
    } catch {
      // ignore invalid regex pattern
    }
  });
  COMPILED_PATTERN_CACHE.set(cacheKey, output);
  return output;
}

export function severityToRisk(severity: SecurityGuardSeverity): SecurityRisk {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

export function resolveActionForSeverity(
  severity: SecurityGuardSeverity,
  fallback: SecurityGuardAction,
  severityActions: SecurityCoreRuntimeConfig["destructiveSeverityActions"] | SecurityCoreRuntimeConfig["secretSeverityActions"],
): SecurityGuardAction {
  return severityActions[severity] ?? fallback;
}

export function hasConfirmFlag(params: unknown): boolean {
  if (typeof params !== "object" || params === null) {
    return false;
  }
  const record = params as Record<string, unknown>;
  return record[CONFIRM_FLAG] === true || record[SECURITY_CONFIRM_FLAG] === true;
}

export function stripConfirmFlag(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }
  const { [CONFIRM_FLAG]: _confirmFlag, [SECURITY_CONFIRM_FLAG]: _securityConfirmFlag, ...rest } =
    params as Record<string, unknown>;
  return rest;
}

export function normalizeToolParams(toolParams: Record<string, unknown>): Record<string, unknown> {
  if (typeof toolParams !== "object" || toolParams === null || Array.isArray(toolParams)) {
    return {};
  }
  return toolParams;
}

export function isAllowlisted(
  toolName: string,
  sessionKey: string | undefined,
  runtimeConfig: SecurityCoreRuntimeConfig,
): boolean {
  if (runtimeConfig.allowlistedTools.includes(toolName)) {
    return true;
  }
  if (sessionKey && runtimeConfig.allowlistedSessions.includes(sessionKey)) {
    return true;
  }
  return false;
}

export function redactToolParams(
  params: Record<string, unknown>,
  patterns: NamedPattern[],
): Record<string, unknown> {
  const redacted = walkStrings(params, (text) => redactPatterns(text, patterns, "REDACTED"));
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
    return {};
  }
  return redacted as Record<string, unknown>;
}

export function isExecStyleTool(toolName: string): boolean {
  return EXEC_STYLE_TOOL_RE.test(toolName);
}

function severityRank(severity: SecurityGuardSeverity): number {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function inferSecretSeverity(patternName: string): SecurityGuardSeverity {
  if (patternName === "private_key") {
    return "critical";
  }
  return "high";
}

export function highestSecretSeverity(hitNames: string[]): SecurityGuardSeverity {
  let current: SecurityGuardSeverity = "low";
  hitNames.forEach((name) => {
    const severity = inferSecretSeverity(name);
    if (severityRank(severity) > severityRank(current)) {
      current = severity;
    }
  });
  return current;
}

import type { SecurityFailureMode } from "./types.js";

const READ_ONLY_RULES = [
  /^read$/i,
  /^memory_(get|search)$/i,
  /^web_search$/i,
  /^finance$/i,
  /^sports$/i,
  /^weather$/i,
  /^time$/i,
  /^sessions_(list|history|status)$/i,
  /^agents_list$/i,
  /^models_list$/i,
  /(^|[._])(get|list|read|search|status|history|preview|catalog)$/i,
];

const MUTATING_RULES = [
  /^exec$/i,
  /^apply_patch$/i,
  /^write$/i,
  /^message$/i,
  /(^|[._])(exec|run|command|shell|write|delete|remove|move|replace|patch|apply|send|create|update|install|uninstall|invoke|set|post|put|revoke|resolve)$/i,
];

type ToolClass = "read_only" | "mutating" | "unknown";

function classifyTool(toolName: string): ToolClass {
  if (READ_ONLY_RULES.some((rule) => rule.test(toolName))) {
    return "read_only";
  }
  if (MUTATING_RULES.some((rule) => rule.test(toolName))) {
    return "mutating";
  }
  return "unknown";
}

export type RuntimeFailureDecision = {
  mode: SecurityFailureMode | null;
  toolClass: ToolClass;
  block: boolean;
  decision: string;
  reason: string;
};

export function decideFailureModeOnRuntimeError(params: {
  mode: SecurityFailureMode | null;
  toolName: string;
}): RuntimeFailureDecision {
  const toolClass = classifyTool(params.toolName);
  const mode = params.mode;

  if (mode === "safe_mode") {
    if (toolClass === "mutating") {
      return {
        mode,
        toolClass,
        block: true,
        decision: "guard-error-safe-mode-blocked",
        reason: "Blocked by security-core safe_mode: runtime guard failed on mutating tool",
      };
    }
    return {
      mode,
      toolClass,
      block: false,
      decision: "guard-error-safe-mode-allowed",
      reason: "Allowed by security-core safe_mode: runtime guard failed on non-mutating tool",
    };
  }

  if (mode === "read_only") {
    if (toolClass === "read_only") {
      return {
        mode,
        toolClass,
        block: false,
        decision: "guard-error-read-only-allowed",
        reason: "Allowed by security-core read_only: runtime guard failed on read-only tool",
      };
    }
    return {
      mode,
      toolClass,
      block: true,
      decision: "guard-error-read-only-blocked",
      reason: "Blocked by security-core read_only: runtime guard failed on non-read-only tool",
    };
  }

  return {
    mode,
    toolClass,
    block: true,
    decision: "guard-error-block-all",
    reason: "Blocked by security-core block_all: runtime guard failed",
  };
}

import type { SecurityGuardAction } from "../types.js";
import type { DecideBeforeToolCallInput, RuntimeDecision, RuntimeDetection } from "./types.js";
import {
  CONFIRM_FLAG,
  isExecStyleTool,
  redactToolParams,
  resolveActionForSeverity,
  severityToRisk,
} from "./shared.js";

function buildForcedBlockDecision(input: DecideBeforeToolCallInput): RuntimeDecision {
  const detection = input.detection;
  return {
    ruleId: detection.ruleId,
    risk: severityToRisk(detection.severity),
    severity: detection.severity,
    detail: detection.detail,
    requestedAction: "block",
    effectiveAction: "block",
    auditAction: "block",
    auditDecision: "deny",
    blockReason: `Blocked by security-core: destructive payload (${(detection as { reason: string }).reason})`,
  };
}

function resolveDestructiveDecision(input: DecideBeforeToolCallInput): RuntimeDecision {
  const detection = input.detection;
  if (detection.kind !== "destructive") {
    throw new Error("resolveDestructiveDecision called with non-destructive detection");
  }

  if (detection.forceBlock) {
    return buildForcedBlockDecision(input);
  }

  const requestedAction = resolveActionForSeverity(
    detection.severity,
    input.runtimeConfig.destructiveAction,
    input.runtimeConfig.destructiveSeverityActions,
  );
  const effectiveAction: SecurityGuardAction = requestedAction === "redact" ? "warn" : requestedAction;
  const base: Omit<RuntimeDecision, "auditAction" | "auditDecision"> = {
    ruleId: detection.ruleId,
    risk: severityToRisk(detection.severity),
    severity: detection.severity,
    detail: detection.detail,
    requestedAction,
    effectiveAction,
  };

  if (effectiveAction === "block") {
    return {
      ...base,
      auditAction: "block",
      auditDecision: "deny",
      blockReason: `Blocked by security-core: destructive payload (${detection.reason})`,
    };
  }

  if (effectiveAction === "confirm" && isExecStyleTool(input.toolName)) {
    return {
      ...base,
      auditAction: "allow",
      auditDecision: "confirm",
      nextParams: {
        ...input.strippedParams,
        ask: "always",
        _security_core: {
          reason: detection.reason,
          severity: detection.severity,
          category: detection.category,
          pattern: detection.pattern,
        },
      },
    };
  }

  if (effectiveAction === "confirm") {
    if (input.confirmed) {
      return {
        ...base,
        auditAction: "allow",
        auditDecision: "confirm-approved",
        nextParams: input.strippedParams,
      };
    }
    return {
      ...base,
      auditAction: "block",
      auditDecision: "confirm-required",
      blockReason: `Blocked by security-core: ${detection.reason}. To proceed, re-run with \`${CONFIRM_FLAG}: true\` in params.`,
    };
  }

  return {
    ...base,
    auditAction: "allow",
    auditDecision: effectiveAction,
  };
}

function resolveSecretDecision(input: DecideBeforeToolCallInput): RuntimeDecision {
  const detection = input.detection;
  if (detection.kind !== "secret") {
    throw new Error("resolveSecretDecision called with non-secret detection");
  }

  const requestedAction = resolveActionForSeverity(
    detection.severity,
    input.runtimeConfig.secretAction,
    input.runtimeConfig.secretSeverityActions,
  );
  const effectiveAction = requestedAction;
  const base: Omit<RuntimeDecision, "auditAction" | "auditDecision"> = {
    ruleId: detection.ruleId,
    risk: severityToRisk(detection.severity),
    severity: detection.severity,
    detail: detection.detail,
    requestedAction,
    effectiveAction,
  };

  if (effectiveAction === "block") {
    return {
      ...base,
      auditAction: "block",
      auditDecision: "deny",
      blockReason: `Blocked by security-core: secret payload (${detection.hitNames[0] ?? "secret"})`,
    };
  }

  if (effectiveAction === "redact") {
    return {
      ...base,
      auditAction: "allow",
      auditDecision: "redact",
      nextParams: redactToolParams(input.strippedParams, detection.redactionPatterns),
    };
  }

  if (effectiveAction === "confirm") {
    if (input.confirmed) {
      return {
        ...base,
        auditAction: "allow",
        auditDecision: "confirm-approved-redact",
        nextParams: {
          ...redactToolParams(input.strippedParams, detection.redactionPatterns),
          _clawguardian_confirmed: detection.hitNames[0] ?? "secret",
        },
      };
    }
    return {
      ...base,
      auditAction: "block",
      auditDecision: "confirm-required",
      blockReason: `Blocked by security-core: secret payload. To proceed with redaction, re-run with \`${CONFIRM_FLAG}: true\` in params.`,
    };
  }

  return {
    ...base,
    auditAction: "allow",
    auditDecision: effectiveAction,
  };
}

function resolvePolicyDecision(input: DecideBeforeToolCallInput): RuntimeDecision {
  const detection = input.detection;
  if (detection.kind !== "policy") {
    throw new Error("resolvePolicyDecision called with non-policy detection");
  }
  return {
    ruleId: detection.ruleId,
    risk: severityToRisk(detection.severity),
    severity: detection.severity,
    detail: detection.detail,
    requestedAction: "block",
    effectiveAction: "block",
    auditAction: "block",
    auditDecision: "policy-deny",
    blockReason: detection.reason,
  };
}

export function decideBeforeToolCall(input: DecideBeforeToolCallInput): RuntimeDecision {
  if (input.detection.kind === "policy") {
    return resolvePolicyDecision(input);
  }
  if (input.detection.kind === "destructive") {
    return resolveDestructiveDecision(input);
  }
  return resolveSecretDecision(input);
}

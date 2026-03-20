import type { SecurityAuditItem } from "../types.js";
import type { ApplyBeforeToolCallDecisionInput, BeforeToolCallGuardOutcome } from "./types.js";

function toAuditItem(input: ApplyBeforeToolCallDecisionInput): SecurityAuditItem {
  return {
    ts: Date.now(),
    toolName: input.toolName,
    risk: input.decision.risk,
    action: input.decision.auditAction,
    decision: input.decision.auditDecision,
    ruleId: input.decision.ruleId,
    policyPreset: input.preset,
    source: "runtime-guard",
    detail: input.decision.detail,
    agentId: input.agentId,
  };
}

export function applyBeforeToolCallDecision(input: ApplyBeforeToolCallDecisionInput): BeforeToolCallGuardOutcome {
  const auditItem = toAuditItem(input);
  if (input.decision.auditAction === "block") {
    return {
      block: true,
      blockReason: input.decision.blockReason ?? "Blocked by security-core",
      auditItem,
    };
  }
  if (input.decision.nextParams) {
    return {
      params: input.decision.nextParams,
      auditItem,
    };
  }
  return { auditItem };
}

import type { NamedPattern } from "../../vendor/shield-core/patterns.js";
import type {
  BeforeToolCallResult,
  SecurityCoreRuntimeConfig,
  SecurityGuardAction,
  SecurityGuardSeverity,
  SecurityPreset,
  SecurityRisk,
} from "../types.js";

export type RuntimeRuleId = "SC-RUNTIME-001" | "SC-RUNTIME-002" | "SC-RUNTIME-006" | "SC-RUNTIME-007" | "SC-RUNTIME-008";
export type RuntimeDetectionKind = "destructive" | "secret" | "policy";

export type RuntimeDestructiveDetection = {
  kind: "destructive";
  ruleId: "SC-RUNTIME-001";
  severity: SecurityGuardSeverity;
  detail: string;
  reason: string;
  category: string;
  pattern: string;
  forceBlock: boolean;
  loggable: boolean;
};

export type RuntimeSecretDetection = {
  kind: "secret";
  ruleId: "SC-RUNTIME-002";
  severity: SecurityGuardSeverity;
  detail: string;
  hitNames: string[];
  redactionPatterns: NamedPattern[];
  loggable: boolean;
};

export type RuntimePolicyDetection = {
  kind: "policy";
  ruleId: "SC-RUNTIME-006" | "SC-RUNTIME-007" | "SC-RUNTIME-008";
  severity: SecurityGuardSeverity;
  detail: string;
  reason: string;
  forceBlock: true;
  loggable: boolean;
};

export type RuntimeDetection = RuntimeDestructiveDetection | RuntimeSecretDetection | RuntimePolicyDetection;

export type DetectBeforeToolCallInput = {
  toolName: string;
  toolParams: Record<string, unknown>;
  fullText: string;
  runtimeConfig: SecurityCoreRuntimeConfig;
};

export type DecideBeforeToolCallInput = {
  toolName: string;
  strippedParams: Record<string, unknown>;
  confirmed: boolean;
  runtimeConfig: SecurityCoreRuntimeConfig;
  detection: RuntimeDetection;
};

export type RuntimeDecision = {
  ruleId: RuntimeRuleId;
  risk: SecurityRisk;
  severity: SecurityGuardSeverity;
  detail: string;
  requestedAction: SecurityGuardAction;
  effectiveAction: SecurityGuardAction;
  auditAction: "allow" | "block";
  auditDecision: string;
  blockReason?: string;
  nextParams?: Record<string, unknown>;
};

export type ApplyBeforeToolCallDecisionInput = {
  toolName: string;
  preset: SecurityPreset;
  agentId?: string;
  decision: RuntimeDecision;
};

export type BeforeToolCallGuardOutcome = BeforeToolCallResult;

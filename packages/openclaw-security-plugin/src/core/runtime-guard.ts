import type { BeforeToolCallResult, SecurityAuditItem, SecurityCoreRuntimeConfig, SecurityPreset } from "./types.js";
import type { RuntimeDetection } from "./runtime-engine/types.js";
import { applyBeforeToolCallDecision } from "./runtime-engine/action.js";
import { buildToolCallText, detectBeforeToolCall } from "./runtime-engine/detector.js";
import { decideBeforeToolCall } from "./runtime-engine/decision.js";
import { isAllowlisted, normalizeToolParams } from "./runtime-engine/shared.js";

function logDetectionIfNeeded(params: {
  runtimeConfig: { logDetections: boolean };
  logger?: { warn?: (message: string) => void };
  detection: RuntimeDetection;
  effectiveAction: string;
}): void {
  const { runtimeConfig, logger, detection, effectiveAction } = params;
  if (!runtimeConfig.logDetections || !detection.loggable || effectiveAction === "log") {
    return;
  }
  logger?.warn?.(`[security-core] ${detection.kind}(${detection.severity}) ${detection.detail}`);
}

function hasBeforeToolChecksEnabled(runtimeConfig: SecurityCoreRuntimeConfig): boolean {
  if (runtimeConfig.blockDestructive) return true;
  if (runtimeConfig.blockSecrets) return true;
  if (runtimeConfig.enablePromptInjectionGuard) return true;
  if (runtimeConfig.allowPathPrefixes.length > 0) return true;
  if (runtimeConfig.allowDomains.length > 0) return true;
  return false;
}

export async function evaluateBeforeToolCall(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  runtimeConfig: SecurityCoreRuntimeConfig;
  preset: SecurityPreset;
  agentId?: string;
  sessionKey?: string;
  logger?: { warn?: (message: string) => void };
}): Promise<BeforeToolCallResult> {
  const {
    toolName,
    toolParams: rawToolParams,
    runtimeConfig,
    preset,
    agentId,
    sessionKey,
    logger,
  } = params;

  if (!runtimeConfig.runtimeGuardEnabled || !hasBeforeToolChecksEnabled(runtimeConfig)) {
    return;
  }
  if (isAllowlisted(toolName, sessionKey, runtimeConfig)) {
    return;
  }

  const toolParams = normalizeToolParams(rawToolParams);
  const detections = detectBeforeToolCall({
    toolName,
    toolParams,
    fullText: buildToolCallText(toolParams),
    runtimeConfig,
  });
  let nextParams = toolParams;
  let requiresApproval = false;
  const auditItems: SecurityAuditItem[] = [];
  for (const detection of detections) {
    const decision = decideBeforeToolCall({
      toolParams: nextParams,
      runtimeConfig,
      detection,
    });
    logDetectionIfNeeded({
      runtimeConfig,
      logger,
      detection,
      effectiveAction: decision.effectiveAction,
    });
    const result = applyBeforeToolCallDecision({ toolName, preset, agentId, decision });
    auditItems.push(...result.auditItems);
    if (result.block) {
      return { ...result, auditItems };
    }
    nextParams = result.params ?? nextParams;
    requiresApproval ||= result.requiresApproval === true;
  }

  if (auditItems.length > 0) {
    return {
      ...(nextParams !== toolParams || requiresApproval ? { params: nextParams } : {}),
      requiresApproval,
      auditItems,
    };
  }
  return;
}

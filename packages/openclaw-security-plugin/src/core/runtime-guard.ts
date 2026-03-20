import type { BeforeToolCallResult, SecurityCoreRuntimeConfig, SecurityPreset } from "./types.js";
import type { RuntimeDetection } from "./runtime-engine/types.js";
import { applyBeforeToolCallDecision } from "./runtime-engine/action.js";
import { buildToolCallText, detectBeforeToolCall } from "./runtime-engine/detector.js";
import { decideBeforeToolCall } from "./runtime-engine/decision.js";
import {
  hasConfirmFlag,
  isAllowlisted,
  normalizeToolParams,
  stripConfirmFlag,
} from "./runtime-engine/shared.js";

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

  const toolParams = normalizeToolParams(rawToolParams);
  const confirmed = hasConfirmFlag(toolParams);
  const strippedParams = stripConfirmFlag(toolParams);

  if (!runtimeConfig.enabled) {
    return;
  }
  if (!runtimeConfig.runtimeGuardEnabled) {
    return;
  }
  if (!hasBeforeToolChecksEnabled(runtimeConfig)) {
    if (confirmed) {
      return { params: strippedParams };
    }
    return;
  }

  if (isAllowlisted(toolName, sessionKey, runtimeConfig)) {
    if (confirmed) {
      return { params: strippedParams };
    }
    return;
  }

  const detection = detectBeforeToolCall({
    toolName,
    toolParams,
    fullText: buildToolCallText(toolParams),
    runtimeConfig,
  });
  if (detection) {
    const decision = decideBeforeToolCall({
      toolName,
      strippedParams,
      confirmed,
      runtimeConfig,
      detection,
    });
    logDetectionIfNeeded({
      runtimeConfig,
      logger,
      detection,
      effectiveAction: decision.effectiveAction,
    });
    return applyBeforeToolCallDecision({
      toolName,
      preset,
      agentId,
      decision,
    });
  }

  if (confirmed) {
    return { params: strippedParams };
  }
  return;
}

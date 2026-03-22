import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runStartupAudit } from "../infrastructure/auditor.js";
import { DEFAULT_POLICY, mergeRuntimeConfig, resolvePolicy, resolveRuntimeConfig } from "../core/policy.js";
import { evaluateBeforeToolCall } from "../core/runtime-guard.js";
import { decideFailureModeOnRuntimeError } from "../core/failure-mode.js";
import { resolveStateDir } from "../vendor/secureclaw-runtime-bridge.js";
import { ApprovalBridgeService } from "../infrastructure/approval-bridge.js";
import { PII_PATTERNS, SECRET_PATTERNS, type NamedPattern } from "../vendor/shield-core/patterns.js";
import { redactPatterns, scanForPatterns } from "../vendor/shield-core/scanner.js";
import { costMonitor, credentialMonitor, memoryIntegrityMonitor } from "../infrastructure/monitors/selected-monitors.js";
import {
  checkAdvisories,
  remediationApply,
  remediationPreview,
  remediationRollback,
  rebuildIntegrityBaseline,
  runEmergencyResponse,
  runIntegrityCheck,
  runQuickAudit,
  runSkillScan,
} from "../infrastructure/actions.js";
import type {
  BeforeToolCallResult,
  SecurityGuardAction,
  SecurityGuardSeverity,
  SecurityAuditItem,
  SecurityAuditQueryResult,
  SecurityCoreRuntimeConfig,
  SecurityPolicyPayload,
  SecurityStartupAuditReport,
  SecuritySyncResult,
} from "../core/types.js";
import { isExecStyleTool, SECURITY_CONFIRM_FLAG } from "../core/runtime-engine/shared.js";

const SECURITY_HOOK_NAMES = [
  "before_agent_start",
  "before_tool_call",
  "tool_result_persist",
  "message_received",
  "after_tool_call",
] as const;
type SecurityHookName = (typeof SECURITY_HOOK_NAMES)[number];

const SECURITY_HOOK_SAMPLE_LIMIT = 512;
const HOOK_STATS_DISABLED_VALUE = 0;
const SECURECLAW_SECRET_PATTERNS: NamedPattern[] = [
  { name: "anthropic_key_v2", pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: "openai_project_key", pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/ },
  { name: "generic_sk_key", pattern: /sk-[a-zA-Z0-9_-]{20,}/ },
];
const OUTPUT_SECRET_BASELINE_PATTERNS: NamedPattern[] = [
  ...SECRET_PATTERNS,
  ...SECURECLAW_SECRET_PATTERNS,
];
const COMPILED_EXTRA_SECRET_PATTERN_CACHE = new Map<string, NamedPattern[]>();
const SECURITY_POLICY_SYSTEM_CONTEXT = [
  "<security-core-policy>",
  "Security Core runtime policy is active.",
  "Never auto-retry blocked tool calls.",
  "When a tool call is blocked by security-core, do not propose alternative commands, do not ask to retry, and do not invoke other tools to bypass policy.",
  "For blocked destructive/secret operations, clearly state the action cannot be performed by the agent and must be handled manually by the user if needed.",
  "Never exfiltrate raw secrets or private keys.",
  "</security-core-policy>",
].join("\n");
const SECURITY_BLOCK_HARD_STOP_DIRECTIVE =
  "Security-core hard stop: do not suggest retries or alternative commands. Reply that this blocked action cannot be executed by the agent and must be performed manually by the user.";
type HookLatencySummary = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  lastMs: number;
  maxMs: number;
};

type HookLatencyMap = Record<SecurityHookName, HookLatencySummary>;
type OutputMatchCategory = "secret" | "pii";
type OutputMatch = {
  category: OutputMatchCategory;
  name: string;
};

function normalizePositiveInt(value: unknown, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

function sortByTsDesc<T extends { ts: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.ts - a.ts);
}

function withHardStopBlockReason(reason: string): string {
  const base = reason.trim();
  if (base.includes(SECURITY_BLOCK_HARD_STOP_DIRECTIVE)) {
    return base;
  }
  return `${base}\n${SECURITY_BLOCK_HARD_STOP_DIRECTIVE}`;
}

function paginateAuditItems(params: Record<string, unknown>, records: SecurityAuditItem[]): SecurityAuditQueryResult {
  const page = normalizePositiveInt(params.page, 1);
  const pageSize = Math.min(200, normalizePositiveInt(params.pageSize, 20));
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const filtered = agentId.length > 0
    ? records.filter((record) => !record.agentId || record.agentId === agentId)
    : records;
  const ordered = sortByTsDesc(filtered);
  const total = ordered.length;
  const offset = (page - 1) * pageSize;
  const items = ordered.slice(offset, offset + pageSize);
  return {
    page,
    pageSize,
    total,
    items,
    backend: "security-core",
  };
}

function severityToRisk(severity: string): "critical" | "high" | "medium" | "low" | "info" {
  const value = severity.trim().toUpperCase();
  if (value === "CRITICAL") return "critical";
  if (value === "HIGH") return "high";
  if (value === "MEDIUM") return "medium";
  if (value === "LOW") return "low";
  return "info";
}

function normalizeAgentId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") {
    return undefined;
  }
  const agentId = (ctx as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string") {
    return undefined;
  }
  const normalized = agentId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePolicyPayload(payload: unknown): SecurityPolicyPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return payload as SecurityPolicyPayload;
}

function isConfirmRequiredGuardResult(value: unknown): value is { block: true; auditItem?: SecurityAuditItem } {
  if (!value || typeof value !== "object") return false;
  const record = value as { block?: unknown; auditItem?: SecurityAuditItem };
  if (record.block !== true) return false;
  return record.auditItem?.decision === "confirm-required";
}

function isBlockedGuardResult(value: BeforeToolCallResult): value is {
  block: true;
  blockReason: string;
  auditItem: SecurityAuditItem;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { block?: unknown; blockReason?: unknown };
  return record.block === true && typeof record.blockReason === "string";
}

function isParamsGuardResult(value: BeforeToolCallResult): value is {
  params: Record<string, unknown>;
  auditItem?: SecurityAuditItem;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { params?: unknown };
  return typeof record.params === "object" && record.params !== null;
}

function registerOptionalGatewayExitHook(
  api: OpenClawPluginApi,
  handler: () => Promise<void>,
): void {
  const onAny = api.on as unknown as (hookName: string, hookHandler: (...args: unknown[]) => unknown) => void;
  onAny("gateway_exit", handler as (...args: unknown[]) => unknown);
}

function freezeRuntimeConfigSnapshot(input: SecurityCoreRuntimeConfig): SecurityCoreRuntimeConfig {
  const snapshot = {
    ...input,
    extraDestructivePatterns: Object.freeze([...input.extraDestructivePatterns]) as string[],
    extraSecretPatterns: Object.freeze([...input.extraSecretPatterns]) as string[],
    extraPromptInjectionPatterns: Object.freeze([...input.extraPromptInjectionPatterns]) as string[],
    allowlistedTools: Object.freeze([...input.allowlistedTools]) as string[],
    allowlistedSessions: Object.freeze([...input.allowlistedSessions]) as string[],
    allowPathPrefixes: Object.freeze([...input.allowPathPrefixes]) as string[],
    allowDomains: Object.freeze([...input.allowDomains]) as string[],
    auditEgressAllowlist: Object.freeze([...input.auditEgressAllowlist]) as string[],
    destructiveSeverityActions: Object.freeze({ ...input.destructiveSeverityActions }),
    destructiveCategories: Object.freeze({ ...input.destructiveCategories }),
    secretSeverityActions: Object.freeze({ ...input.secretSeverityActions }),
  };
  return Object.freeze(snapshot) as SecurityCoreRuntimeConfig;
}

function shouldReconcileMonitors(prev: SecurityCoreRuntimeConfig, next: SecurityCoreRuntimeConfig): boolean {
  return (
    prev.enableCredentialMonitor !== next.enableCredentialMonitor
    || prev.enableMemoryIntegrityMonitor !== next.enableMemoryIntegrityMonitor
    || prev.enableCostMonitor !== next.enableCostMonitor
  );
}

function buildEmergencyLockdownConfig(base: SecurityCoreRuntimeConfig): SecurityCoreRuntimeConfig {
  return {
    ...base,
    runtimeGuardEnabled: true,
    auditOnGatewayStart: true,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    enableCredentialMonitor: true,
    enableMemoryIntegrityMonitor: true,
    enableCostMonitor: true,
    logDetections: true,
    allowlistedTools: [],
    allowlistedSessions: [],
    allowDomains: [],
    destructiveAction: "block",
    destructiveSeverityActions: {
      critical: "block",
      high: "block",
      medium: "block",
      low: "block",
    },
    destructiveCategories: {
      fileDelete: true,
      gitDestructive: true,
      sqlDestructive: true,
      systemDestructive: true,
      processKill: true,
      networkDestructive: true,
      privilegeEscalation: true,
    },
    secretAction: "block",
    secretSeverityActions: {
      critical: "block",
      high: "block",
      medium: "block",
      low: "block",
    },
  };
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function roundMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return HOOK_STATS_DISABLED_VALUE;
  }
  return Number(value.toFixed(3));
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return HOOK_STATS_DISABLED_VALUE;
  if (samples.length === 1) return samples[0];
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function createHookLatencyMap(): HookLatencyMap {
  const map = {} as HookLatencyMap;
  SECURITY_HOOK_NAMES.forEach((name) => {
    map[name] = {
      count: 0,
      p50Ms: HOOK_STATS_DISABLED_VALUE,
      p95Ms: HOOK_STATS_DISABLED_VALUE,
      lastMs: HOOK_STATS_DISABLED_VALUE,
      maxMs: HOOK_STATS_DISABLED_VALUE,
    };
  });
  return map;
}

function normalizePatternList(patterns: string[]): string[] {
  return patterns
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function compileExtraSecretPatternsCached(patterns: string[], prefix: string): NamedPattern[] {
  const normalized = normalizePatternList(patterns);
  if (normalized.length === 0) {
    return [];
  }
  const cacheKey = `${prefix}:${normalized.join("\u0001")}`;
  const cached = COMPILED_EXTRA_SECRET_PATTERN_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }
  const output: NamedPattern[] = [];
  normalized.forEach((rawPattern, index) => {
    try {
      output.push({ name: `${prefix}_${index + 1}`, pattern: new RegExp(rawPattern, "i") });
    } catch {
      // ignore invalid pattern
    }
  });
  COMPILED_EXTRA_SECRET_PATTERN_CACHE.set(cacheKey, output);
  return output;
}

function extractMessageText(event: Record<string, unknown>): string {
  if (typeof event.content === "string") {
    return event.content;
  }
  if (typeof event.text === "string") {
    return event.text;
  }
  if (typeof event.message === "string") {
    return event.message;
  }
  return "";
}

function severityRank(severity: SecurityGuardSeverity): number {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function outputHitSeverity(match: OutputMatch): SecurityGuardSeverity {
  if (match.category === "secret") {
    if (match.name === "private_key") {
      return "critical";
    }
    return "high";
  }
  if (match.name === "us_ssn" || match.name === "credit_card") {
    return "high";
  }
  return "medium";
}

function highestOutputSeverity(matches: OutputMatch[]): SecurityGuardSeverity {
  let maxSeverity: SecurityGuardSeverity = "low";
  matches.forEach((match) => {
    const severity = outputHitSeverity(match);
    if (severityRank(severity) > severityRank(maxSeverity)) {
      maxSeverity = severity;
    }
  });
  return maxSeverity;
}

function resolveOutputAction(
  severity: SecurityGuardSeverity,
  runtimeConfig: ReturnType<typeof resolveRuntimeConfig>,
): { action: SecurityGuardAction; requested: SecurityGuardAction } {
  const requested = runtimeConfig.secretSeverityActions[severity] ?? runtimeConfig.secretAction;
  if (requested === "confirm") {
    // tool_result_persist 是同步 hook，不支持交互确认；安全降级为 block
    return { action: "block", requested };
  }
  return { action: requested, requested };
}

const ADVISORY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;


export function registerSecurityRuntime(api: OpenClawPluginApi): void {
    let runtimeConfig = freezeRuntimeConfigSnapshot(resolveRuntimeConfig(api.pluginConfig));
    const approvalBridge = new ApprovalBridgeService({
      logger: api.logger,
      loadConfig: async () => {
        if (api.runtime?.config?.loadConfig) {
          try {
            return await api.runtime.config.loadConfig();
          } catch {
            return api.config as Record<string, unknown>;
          }
        }
        return api.config as Record<string, unknown>;
      },
    });
    const stateDir = resolveStateDir();
    let monitorsStarted = false;
    let advisoryTimer: NodeJS.Timeout | null = null;

    let currentPolicy: SecuritySyncResult = DEFAULT_POLICY;
    const startupReports: SecurityStartupAuditReport[] = [];
    const auditItems: SecurityAuditItem[] = [];
    const hookSamples = new Map<SecurityHookName, number[]>();
    const hookLatency = createHookLatencyMap();

    const recordHookLatency = (hookName: SecurityHookName, durationMs: number): void => {
      const normalized = Math.max(0, durationMs);
      const samples = hookSamples.get(hookName) ?? [];
      samples.push(normalized);
      if (samples.length > SECURITY_HOOK_SAMPLE_LIMIT) {
        samples.splice(0, samples.length - SECURITY_HOOK_SAMPLE_LIMIT);
      }
      hookSamples.set(hookName, samples);

      const summary = hookLatency[hookName];
      summary.count += 1;
      summary.lastMs = roundMs(normalized);
      summary.maxMs = roundMs(Math.max(summary.maxMs, normalized));
      summary.p50Ms = roundMs(percentile(samples, 0.5));
      summary.p95Ms = roundMs(percentile(samples, 0.95));
    };

    const withHookTimingAsync = async <T>(
      hookName: SecurityHookName,
      fn: () => Promise<T>,
    ): Promise<T> => {
      const started = nowMs();
      try {
        return await fn();
      } finally {
        recordHookLatency(hookName, nowMs() - started);
      }
    };

    const withHookTimingSync = <T>(
      hookName: SecurityHookName,
      fn: () => T,
    ): T => {
      const started = nowMs();
      try {
        return fn();
      } finally {
        recordHookLatency(hookName, nowMs() - started);
      }
    };

    const resolveOutputSecretPatterns = (): NamedPattern[] => [
      ...OUTPUT_SECRET_BASELINE_PATTERNS,
      ...compileExtraSecretPatternsCached(runtimeConfig.extraSecretPatterns, "secret_extra"),
    ];

    const appendAuditItem = (item: SecurityAuditItem): void => {
      auditItems.unshift(item);
      if (auditItems.length > 5000) {
        auditItems.length = 5000;
      }
    };

    const appendMonitorAlert = (monitorName: string, severity: string, message: string, detail?: string): void => {
      appendAuditItem({
        ts: Date.now(),
        toolName: monitorName,
        risk: severityToRisk(severity),
        action: "audit",
        decision: "alert",
        policyPreset: currentPolicy.preset,
        ruleId: `monitor.${monitorName}`,
        source: "monitor",
        detail: detail ? `${message}; ${detail}` : message,
      });
    };

    credentialMonitor.onAlert((alert) => {
      appendMonitorAlert(alert.monitor, alert.severity, alert.message, alert.details);
    });
    memoryIntegrityMonitor.onAlert((alert) => {
      appendMonitorAlert(alert.monitor, alert.severity, alert.message, alert.details);
    });
    costMonitor.onAlert((alert) => {
      appendMonitorAlert(alert.monitor, alert.severity, alert.message, alert.details);
    });

    const startSelectedMonitors = async (): Promise<void> => {
      if (monitorsStarted) {
        return;
      }
      const activeRuntimeConfig = runtimeConfig;
      let startedAny = false;
      if (activeRuntimeConfig.enableCredentialMonitor) {
        await credentialMonitor.start(stateDir);
        startedAny = true;
      }
      if (activeRuntimeConfig.enableMemoryIntegrityMonitor) {
        await memoryIntegrityMonitor.start(stateDir);
        startedAny = true;
      }
      if (activeRuntimeConfig.enableCostMonitor) {
        await costMonitor.start(stateDir);
        startedAny = true;
      }
      monitorsStarted = startedAny;
      api.logger.info(
        `[security-core] monitors started (credentials=${activeRuntimeConfig.enableCredentialMonitor}, memory=${activeRuntimeConfig.enableMemoryIntegrityMonitor}, cost=${activeRuntimeConfig.enableCostMonitor})`,
      );
    };

    const stopSelectedMonitors = async (): Promise<void> => {
      if (!monitorsStarted) {
        return;
      }
      await credentialMonitor.stop();
      await memoryIntegrityMonitor.stop();
      await costMonitor.stop();
      monitorsStarted = false;
      api.logger.info("[security-core] monitors stopped");
    };

    const appendStartupReport = (report: SecurityStartupAuditReport): void => {
      startupReports.unshift(report);
      if (startupReports.length > 500) {
        startupReports.length = 500;
      }
      report.findings.forEach((finding) => {
        appendAuditItem({
          ts: report.ts,
          toolName: "startup-audit",
          risk: severityToRisk(finding.severity),
          action: "audit",
          decision: "finding",
          policyPreset: currentPolicy.preset,
          ruleId: finding.id,
          source: "startup-audit",
          detail: finding.title,
        });
      });
    };

    const runAdvisorySweep = async (): Promise<void> => {
      const advisories = await checkAdvisories();
      advisories.criticalOrHigh.forEach((item) => {
        appendAuditItem({
          ts: Date.now(),
          toolName: "advisory-check",
          risk: item.severity === "critical" ? "critical" : "high",
          action: "audit",
          decision: "advisory",
          policyPreset: currentPolicy.preset,
          ruleId: item.id,
          source: "monitor",
          detail: item.title,
        });
      });
      if (advisories.criticalOrHigh.length > 0) {
        api.logger.warn?.(`[security-core] advisories critical/high=${advisories.criticalOrHigh.length}`);
      }
    };

    const startAdvisorySchedule = (): void => {
      if (advisoryTimer) {
        return;
      }
      advisoryTimer = setInterval(() => {
        void runAdvisorySweep();
      }, ADVISORY_CHECK_INTERVAL_MS);
      void runAdvisorySweep();
      api.logger.info("[security-core] advisory scheduler started");
    };

    const stopAdvisorySchedule = (): void => {
      if (!advisoryTimer) {
        return;
      }
      clearInterval(advisoryTimer);
      advisoryTimer = null;
      api.logger.info("[security-core] advisory scheduler stopped");
    };

    api.on("gateway_start", async () => {
      if (runtimeConfig.auditOnGatewayStart) {
        const report = await runStartupAudit({
          stateDir,
          runtimeConfig,
        });
        appendStartupReport(report);
        api.logger.info(`[security-core] startup audit score=${report.score} findings=${report.findings.length}`);
        if (report.summary.critical > 0) {
          api.logger.warn?.(`[security-core] startup audit critical findings=${report.summary.critical}`);
        }
      }
      if (runtimeConfig.autoHarden) {
        api.logger.warn?.("[security-core] autoHarden is configured but disabled in this trimmed build");
      }
      try {
        await startSelectedMonitors();
      } catch (error) {
        api.logger.warn?.(`[security-core] monitor startup failed: ${String(error)}`);
      }
      startAdvisorySchedule();
    });

    api.on("gateway_stop", async () => {
      stopAdvisorySchedule();
      try {
        await stopSelectedMonitors();
      } catch (error) {
        api.logger.warn?.(`[security-core] monitor stop failed on gateway_stop: ${String(error)}`);
      }
    });

    registerOptionalGatewayExitHook(api, async () => {
      stopAdvisorySchedule();
      try {
        await stopSelectedMonitors();
      } catch (error) {
        api.logger.warn?.(`[security-core] monitor stop failed on gateway_exit: ${String(error)}`);
      }
    });

    api.on("before_agent_start", async (_event) =>
      withHookTimingAsync("before_agent_start", async () => {
        // 不再向可见会话消息注入 security-core 前置文本，避免污染用户对话。
        // 运行时治理仍由 before_tool_call / tool_result_persist 等钩子执行。
        return undefined;
      }));

    api.on("before_prompt_build", async () => {
      if (!runtimeConfig.runtimeGuardEnabled) {
        return undefined;
      }
      // 通过系统上下文注入策略：模型可见，前端聊天气泡不可见。
      return { prependSystemContext: SECURITY_POLICY_SYSTEM_CONTEXT };
    });

    api.on("before_tool_call", async (event, ctx) => {
      return withHookTimingAsync("before_tool_call", async () => {
        const agentId = normalizeAgentId(ctx);
        const sourceParams = (event.params && typeof event.params === "object" && !Array.isArray(event.params))
          ? (event.params as Record<string, unknown>)
          : {};
        const runGuard = async (toolParams: Record<string, unknown>) => await evaluateBeforeToolCall({
          toolName: event.toolName,
          toolParams,
          runtimeConfig,
          preset: currentPolicy.preset,
          agentId,
          sessionKey: ctx?.sessionKey,
          logger: api.logger,
        });

        const applyFailureModeDecision = (error: unknown) => {
          const decision = decideFailureModeOnRuntimeError({
            mode: runtimeConfig.auditFailureMode,
            toolName: event.toolName,
          });
          const errorText = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);

          appendAuditItem({
            ts: Date.now(),
            toolName: event.toolName,
            risk: decision.block ? "high" : "medium",
            action: decision.block ? "block" : "audit",
            decision: decision.decision,
            policyPreset: currentPolicy.preset,
            ruleId: "SC-RUNTIME-FAIL-001",
            source: "runtime-guard",
            detail: `mode=${decision.mode ?? "block_all"} class=${decision.toolClass}; ${errorText}`,
            agentId,
          });

          api.logger.warn?.(
            `[security-core] before_tool_call runtime guard failed: mode=${decision.mode ?? "block_all"} class=${decision.toolClass} error=${errorText}`,
          );

          if (decision.block) {
            return {
              block: true,
              blockReason: withHardStopBlockReason(`${decision.reason}.`),
            };
          }
          return undefined;
        };

        try {
          const result = await runGuard(sourceParams);

          if (isConfirmRequiredGuardResult(result)) {
            if (result.auditItem) {
              appendAuditItem(result.auditItem);
            }

            appendAuditItem({
              ts: Date.now(),
              toolName: event.toolName,
              risk: result.auditItem?.risk ?? "high",
              action: "audit",
              decision: "native-approval-requested",
              policyPreset: currentPolicy.preset,
              ruleId: "SC-RUNTIME-009",
              source: "runtime-guard",
              detail: "confirm requires native approval bridge",
              agentId,
            });

            const approval = await approvalBridge.requestNativeApproval({
              toolName: event.toolName,
              toolParams: sourceParams,
              agentId,
              sessionKey: ctx?.sessionKey,
            });

            if (approval.status === "approved") {
              appendAuditItem({
                ts: Date.now(),
                toolName: event.toolName,
                risk: result.auditItem?.risk ?? "high",
                action: "audit",
                decision: "native-approval-approved",
                policyPreset: currentPolicy.preset,
                ruleId: "SC-RUNTIME-009",
                source: "runtime-guard",
                detail: `approvalId=${approval.approvalId}; decision=${approval.decision}`,
                agentId,
              });
              const replayResult = await runGuard({
                ...sourceParams,
                [SECURITY_CONFIRM_FLAG]: true,
              });
              if (replayResult && typeof replayResult === "object" && "auditItem" in replayResult && replayResult.auditItem) {
                appendAuditItem(replayResult.auditItem);
              }
              if (isBlockedGuardResult(replayResult)) {
                return { block: true, blockReason: withHardStopBlockReason(replayResult.blockReason) };
              }
              if (isParamsGuardResult(replayResult)) {
                if (isExecStyleTool(event.toolName)) {
                  const replayParams = replayResult.params as Record<string, unknown>;
                  const { ask: _ask, ...rest } = replayParams;
                  return { params: rest };
                }
                return { params: replayResult.params };
              }
              return undefined;
            }

            if (approval.status === "denied") {
              appendAuditItem({
                ts: Date.now(),
                toolName: event.toolName,
                risk: result.auditItem?.risk ?? "high",
                action: "block",
                decision: "native-approval-denied",
                policyPreset: currentPolicy.preset,
                ruleId: "SC-RUNTIME-009",
                source: "runtime-guard",
                detail: `approvalId=${approval.approvalId}; decision=${approval.decision}`,
                agentId,
              });
              return {
                block: true,
                blockReason: withHardStopBlockReason("Blocked by security-core: native approval denied."),
              };
            }

            appendAuditItem({
              ts: Date.now(),
              toolName: event.toolName,
              risk: result.auditItem?.risk ?? "high",
              action: "audit",
              decision: approval.status === "timeout" ? "native-approval-timeout" : "native-approval-error",
              policyPreset: currentPolicy.preset,
              ruleId: "SC-RUNTIME-009",
              source: "runtime-guard",
              detail: "detail" in approval ? approval.detail : undefined,
              agentId,
            });
            return applyFailureModeDecision(
              approval.status === "timeout"
                ? new Error(`native approval timeout: ${approval.detail ?? "no decision"}`)
                : new Error(`native approval error: ${approval.detail}`),
            );
          }

          if (result && typeof result === "object" && "auditItem" in result && result.auditItem) {
            appendAuditItem(result.auditItem);
          }
          if (isBlockedGuardResult(result)) {
            return { block: true, blockReason: withHardStopBlockReason(result.blockReason) };
          }
          if (isParamsGuardResult(result)) {
            return { params: result.params };
          }
          return undefined;
        } catch (error) {
          return applyFailureModeDecision(error);
        }
      });
    });

    api.on("tool_result_persist", (event, ctx) =>
      withHookTimingSync("tool_result_persist", () => {
        if (!runtimeConfig.runtimeGuardEnabled) {
          return undefined;
        }
        const message = (event as { message?: unknown }).message;
        if (!message || typeof message !== "object") {
          return undefined;
        }

        const messageRecord = message as { content?: unknown[] };
        if (!Array.isArray(messageRecord.content) || messageRecord.content.length === 0) {
          return undefined;
        }

        const secretPatterns = resolveOutputSecretPatterns();
        const piiPatterns = PII_PATTERNS;
        const redact = (text: string): string => {
          let output = text;
          output = redactPatterns(output, secretPatterns, "REDACTED");
          output = redactPatterns(output, piiPatterns, "PII_REDACTED");
          return output;
        };

        const allMatches: OutputMatch[] = [];
        const nextContent = messageRecord.content.map((item) => {
          if (
            typeof item !== "object" ||
            item === null ||
            (item as { type?: unknown }).type !== "text" ||
            typeof (item as { text?: unknown }).text !== "string"
          ) {
            return item;
          }

          const block = item as { type: "text"; text: string };
          const secretHits = scanForPatterns(block.text, secretPatterns);
          const piiHits = scanForPatterns(block.text, piiPatterns);
          if (secretHits.length === 0 && piiHits.length === 0) {
            return item;
          }
          secretHits.forEach((hit) => allMatches.push({ category: "secret", name: hit.name }));
          piiHits.forEach((hit) => allMatches.push({ category: "pii", name: hit.name }));
          return item;
        });

        if (allMatches.length === 0) {
          return undefined;
        }

        const detail = allMatches.map((item) => `${item.category}:${item.name}`).join(", ");
        const severity = highestOutputSeverity(allMatches);
        const { action, requested } = resolveOutputAction(severity, runtimeConfig);
        const unsupportedConfirmFallback = requested !== action;

        if (runtimeConfig.logDetections && action !== "log") {
          const fallbackSuffix = unsupportedConfirmFallback ? ` (fallback from ${requested})` : "";
          api.logger.warn?.(`[security-core] output-scan ${action} severity=${severity}${fallbackSuffix}: ${detail}`);
        }

        let decision = "output-audit";
        let auditAction: SecurityAuditItem["action"] = "audit";
        let responseMessage: typeof event.message | undefined;

        if (action === "block") {
          decision = unsupportedConfirmFallback ? "output-confirm-fallback-blocked" : "output-blocked";
          auditAction = "block";
          responseMessage = {
            ...(message as typeof event.message & { content?: unknown }),
            content: [
              {
                type: "text",
                text: `[Security Core: Output blocked - severity=${severity}; ${detail}]`,
              },
            ],
          } as typeof event.message;
        } else if (action === "redact") {
          decision = "output-redacted";
          auditAction = "allow";
          responseMessage = {
            ...(message as typeof event.message & { content?: unknown }),
            content: nextContent.map((item) => {
              if (
                typeof item !== "object" ||
                item === null ||
                (item as { type?: unknown }).type !== "text" ||
                typeof (item as { text?: unknown }).text !== "string"
              ) {
                return item;
              }
              const textBlock = item as { type: "text"; text: string };
              return {
                ...textBlock,
                text: redact(textBlock.text),
              };
            }),
          } as typeof event.message;
        } else if (action === "warn" || action === "log") {
          decision = action === "warn" ? "output-warn" : "output-log";
          auditAction = "audit";
        }

        appendAuditItem({
          ts: Date.now(),
          toolName: (event as { toolName?: string }).toolName ?? "tool_result_persist",
          risk: severityToRisk(severity),
          action: auditAction,
          decision,
          policyPreset: currentPolicy.preset,
          ruleId: "SC-RUNTIME-003",
          source: "runtime-guard",
          detail,
          agentId: normalizeAgentId(ctx),
        });

        if (!responseMessage) {
          return undefined;
        }
        return { message: responseMessage };
      }));

    api.on("message_received", async (event, ctx) =>
      withHookTimingAsync("message_received", async () => {
        if (!runtimeConfig.runtimeGuardEnabled) {
          return undefined;
        }
        const text = extractMessageText(event as Record<string, unknown>);
        if (!text.trim()) {
          return undefined;
        }
        const hits = scanForPatterns(text, resolveOutputSecretPatterns());
        if (hits.length === 0) {
          return undefined;
        }
        appendAuditItem({
          ts: Date.now(),
          toolName: "message_received",
          risk: "medium",
          action: "audit",
          decision: "input-secret-detected",
          policyPreset: currentPolicy.preset,
          ruleId: "SC-RUNTIME-004",
          source: "runtime-guard",
          detail: hits.map((item) => item.name).join(", "),
          agentId: normalizeAgentId(ctx),
        });
        if (runtimeConfig.logDetections) {
          api.logger.warn?.(`[security-core] inbound message contains secret-like patterns: ${hits.map((item) => item.name).join(", ")}`);
        }
        return undefined;
      }));

    api.on("after_tool_call", async (event, ctx) =>
      withHookTimingAsync("after_tool_call", async () => {
        const eventRecord = event as { toolName?: string; durationMs?: number; error?: unknown };
        const durationMs = typeof eventRecord.durationMs === "number" ? eventRecord.durationMs : undefined;
        const hasError = typeof eventRecord.error !== "undefined" && eventRecord.error !== null;
        appendAuditItem({
          ts: Date.now(),
          toolName: eventRecord.toolName ?? "after_tool_call",
          risk: hasError ? "medium" : "low",
          action: "audit",
          decision: hasError ? "tool-error" : "tool-ok",
          policyPreset: currentPolicy.preset,
          ruleId: "SC-RUNTIME-005",
          source: "runtime-guard",
          detail: typeof durationMs === "number" ? `durationMs=${durationMs}` : undefined,
          agentId: normalizeAgentId(ctx),
        });
        return undefined;
      }));

    const handlePolicySync = async (options: GatewayRequestHandlerOptions): Promise<void> => {
      const payload = normalizePolicyPayload(options.params);
      currentPolicy = resolvePolicy(payload, currentPolicy);
      const previousRuntimeConfig = runtimeConfig;
      const mergedRuntimeConfig = mergeRuntimeConfig(previousRuntimeConfig, payload);
      const nextRuntimeConfig = mergedRuntimeConfig === previousRuntimeConfig
        ? previousRuntimeConfig
        : freezeRuntimeConfigSnapshot(mergedRuntimeConfig);
      const monitorChanged = shouldReconcileMonitors(previousRuntimeConfig, nextRuntimeConfig);
      runtimeConfig = nextRuntimeConfig;
      if (monitorChanged) {
        try {
          await stopSelectedMonitors();
          await startSelectedMonitors();
        } catch (error) {
          api.logger.warn?.(`[security-core] monitor reconcile failed after policy sync: ${String(error)}`);
        }
      }
      options.respond(true, currentPolicy);
    };

    api.registerGatewayMethod("security.policy.sync", handlePolicySync);

    const handleAuditQuery = async (options: GatewayRequestHandlerOptions): Promise<void> => {
      options.respond(true, paginateAuditItems(options.params ?? {}, auditItems));
    };

    api.registerGatewayMethod("security.audit.query", handleAuditQuery);

    api.registerGatewayMethod("security.audit.latest", async (options: GatewayRequestHandlerOptions) => {
      options.respond(true, {
        backend: "security-core",
        latest: startupReports[0] ?? null,
      });
    });

    api.registerGatewayMethod("security.monitor.status", async (options: GatewayRequestHandlerOptions) => {
      options.respond(true, {
        backend: "security-core",
        monitors: {
          credentials: credentialMonitor.status(),
          memory: memoryIntegrityMonitor.status(),
          cost: costMonitor.status(),
        },
        hookLatency: hookLatency,
      });
    });

    api.registerGatewayMethod("security.quick_audit.run", async (options: GatewayRequestHandlerOptions) => {
      const result = await runQuickAudit(stateDir, runtimeConfig);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.emergency.run", async (options: GatewayRequestHandlerOptions) => {
      const previousRuntimeConfig = runtimeConfig;
      const lockdownConfig = freezeRuntimeConfigSnapshot(
        buildEmergencyLockdownConfig(previousRuntimeConfig),
      );
      const monitorChanged = shouldReconcileMonitors(previousRuntimeConfig, lockdownConfig);
      runtimeConfig = lockdownConfig;
      currentPolicy = {
        ...currentPolicy,
        preset: "strict",
      };
      appendAuditItem({
        ts: Date.now(),
        toolName: "security.emergency.run",
        risk: "critical",
        action: "audit",
        decision: "emergency-lockdown-applied",
        policyPreset: currentPolicy.preset,
        ruleId: "SC-EMERGENCY-001",
        source: "runtime-guard",
        detail: "runtime policy switched to strict lockdown",
      });
      if (monitorChanged) {
        try {
          await stopSelectedMonitors();
          await startSelectedMonitors();
        } catch (error) {
          api.logger.warn?.(`[security-core] monitor reconcile failed after emergency lockdown: ${String(error)}`);
        }
      }
      const result = await runEmergencyResponse(stateDir, lockdownConfig);
      options.respond(true, {
        backend: "security-core",
        lockdownApplied: true,
        lockdown: {
          preset: "strict",
          blockDestructive: lockdownConfig.blockDestructive,
          blockSecrets: lockdownConfig.blockSecrets,
          runtimeGuardEnabled: lockdownConfig.runtimeGuardEnabled,
          enablePromptInjectionGuard: lockdownConfig.enablePromptInjectionGuard,
          allowlistedTools: lockdownConfig.allowlistedTools.length,
          allowlistedSessions: lockdownConfig.allowlistedSessions.length,
          allowDomains: lockdownConfig.allowDomains.length,
        },
        ...result,
      });
    });

    api.registerGatewayMethod("security.integrity.check", async (options: GatewayRequestHandlerOptions) => {
      const result = await runIntegrityCheck(stateDir);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.integrity.rebaseline", async (options: GatewayRequestHandlerOptions) => {
      const result = await rebuildIntegrityBaseline(stateDir);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.skills.scan", async (options: GatewayRequestHandlerOptions) => {
      const scanPath = typeof options.params?.scanPath === "string" ? options.params.scanPath : undefined;
      const result = await runSkillScan({ stateDir, scanPath });
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.advisories.check", async (options: GatewayRequestHandlerOptions) => {
      const feedUrl = typeof options.params?.feedUrl === "string" ? options.params.feedUrl : undefined;
      const result = await checkAdvisories(feedUrl);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.remediation.preview", async (options: GatewayRequestHandlerOptions) => {
      const result = await remediationPreview(stateDir);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.remediation.apply", async (options: GatewayRequestHandlerOptions) => {
      const selectedActions = Array.isArray(options.params?.actions)
        ? options.params.actions.filter((item): item is string => typeof item === "string")
        : undefined;
      const result = await remediationApply(stateDir, selectedActions);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.registerGatewayMethod("security.remediation.rollback", async (options: GatewayRequestHandlerOptions) => {
      const snapshotId = typeof options.params?.snapshotId === "string" ? options.params.snapshotId : undefined;
      const result = await remediationRollback(stateDir, snapshotId);
      options.respond(true, { backend: "security-core", ...result });
    });

    api.logger.info("[security-core] plugin registered (secureclaw-runtime + clawguardian/shield runtime guard)");
}

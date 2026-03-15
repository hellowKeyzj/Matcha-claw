import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type GuardRisk = "low" | "medium" | "high" | "critical";
export type GuardAction = "allow" | "confirm" | "deny";
export type GuardDecision = "allow-once" | "allow-always" | "deny" | "allow";

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
};

type GatewayContextLike = {
  execApprovalManager?: unknown;
  nodeSendToAllSubscribed?: (event: string, payload: unknown) => void;
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
};

type GuardQuery = {
  page?: unknown;
  pageSize?: unknown;
  agentId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  risk?: unknown;
  action?: unknown;
  fromMs?: unknown;
  toMs?: unknown;
};

type GuardPolicy = {
  enabled: boolean;
  defaultAction: GuardAction;
  approvalTimeoutMs: number;
  allowTools: Set<string>;
  confirmTools: Set<string>;
  denyTools: Set<string>;
};

const SENSITIVE_KEY_RE = /(token|key|secret|password|passwd|cookie|authorization|api[_-]?key|private[_-]?key|ssh|credential)/i;
const CONTENT_KEY_RE = /(content|body|prompt|text|message|data)/i;
const PATH_KEY_RE = /(path|file|filepath|directory|cwd|workspace)/i;
const NETWORK_TOOL_RE = /(http|fetch|request|upload|webhook|send|post|socket|mail|smtp|discord|telegram|slack)/i;
const HIGH_RISK_TOOL_RE = /(system\.run|nodes\.run|exec|shell|write|delete|remove|unlink|truncate|replace|install|uninstall|spawn)/i;

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

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePolicy(pluginConfig: Record<string, unknown> | undefined): GuardPolicy {
  const guardConfig = isObject(pluginConfig?.guardian) ? (pluginConfig?.guardian as Record<string, unknown>) : {};
  const enabled = guardConfig.enabled !== false;
  const defaultActionRaw = typeof guardConfig.defaultAction === "string" ? guardConfig.defaultAction.trim().toLowerCase() : "confirm";
  const defaultAction: GuardAction = defaultActionRaw === "allow" || defaultActionRaw === "deny" || defaultActionRaw === "confirm"
    ? defaultActionRaw
    : "confirm";
  const approvalTimeoutMsRaw = typeof guardConfig.approvalTimeoutMs === "number" ? guardConfig.approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS;
  const approvalTimeoutMs = Number.isFinite(approvalTimeoutMsRaw) && approvalTimeoutMsRaw > 0
    ? Math.floor(approvalTimeoutMsRaw)
    : DEFAULT_APPROVAL_TIMEOUT_MS;
  return {
    enabled,
    defaultAction,
    approvalTimeoutMs,
    allowTools: new Set(ensureStringArray(guardConfig.allowTools, DEFAULT_ALLOW_TOOLS).map(normalizeToolName)),
    confirmTools: new Set(ensureStringArray(guardConfig.confirmTools, DEFAULT_CONFIRM_TOOLS).map(normalizeToolName)),
    denyTools: new Set(ensureStringArray(guardConfig.denyTools, DEFAULT_DENY_TOOLS).map(normalizeToolName)),
  };
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

function normalizeDecisionText(value: GuardDecision): string {
  if (value === "allow") {
    return "allow-once";
  }
  return value;
}

export class GuardianController {
  private readonly api: OpenClawPluginApi;
  private readonly policy: GuardPolicy;
  private readonly allowAlwaysCache = new Set<string>();
  private readonly traces = new Map<string, GuardTrace>();
  private gatewayContext: GatewayContextLike | null = null;
  private auditDb: any = null;
  private auditDbReady: Promise<void> | null = null;
  private readonly auditDbPath: string;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.policy = normalizePolicy(api.pluginConfig);
    const stateDirFromEnv = typeof process.env.OPENCLAW_STATE_DIR === "string" ? process.env.OPENCLAW_STATE_DIR.trim() : "";
    const stateDir = stateDirFromEnv || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".openclaw");
    this.auditDbPath = path.join(stateDir, "guardian-audit.db");
  }

  bindGatewayContext(context: GatewayContextLike): void {
    this.gatewayContext = context;
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
    try {
      this.gatewayContext?.nodeSendToAllSubscribed?.(event, payload);
    } catch (error) {
      this.api.logger.warn?.(`[guardian] 发布事件失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private evaluatePolicy(event: BeforeToolEvent, ctx: ToolContext): { risk: GuardRisk; action: GuardAction; reason: string } {
    if (!this.policy.enabled) {
      return { risk: "low", action: "allow", reason: "guardian_disabled" };
    }
    const toolName = normalizeToolName(event.toolName);
    if (!toolName) {
      return { risk: "low", action: "allow", reason: "empty_tool_name" };
    }
    const allowAlwaysKey = `${ctx.sessionKey ?? "global"}::${ctx.agentId ?? "agent"}::${toolName}`;
    if (this.allowAlwaysCache.has(allowAlwaysKey)) {
      return { risk: "low", action: "allow", reason: "allow_always_cache" };
    }
    if (this.policy.allowTools.has(toolName)) {
      return { risk: "low", action: "allow", reason: "allowlist_tool" };
    }
    if (this.policy.denyTools.has(toolName)) {
      return { risk: "critical", action: "deny", reason: "denylist_tool" };
    }
    const hasSensitive = containsSensitiveValue(event.params);
    const maybeOutbound = NETWORK_TOOL_RE.test(toolName);
    if (hasSensitive && maybeOutbound) {
      return { risk: "critical", action: "deny", reason: "sensitive_data_egress" };
    }
    if (this.policy.confirmTools.has(toolName)) {
      return { risk: "high", action: "confirm", reason: "confirmlist_tool" };
    }
    if (HIGH_RISK_TOOL_RE.test(toolName) || hasSensitive) {
      return { risk: "high", action: "confirm", reason: hasSensitive ? "sensitive_payload" : "high_risk_tool" };
    }
    return {
      risk: asRiskByAction(this.policy.defaultAction),
      action: this.policy.defaultAction,
      reason: "default_policy",
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
          params_preview TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_ts ON guardian_audit(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_run_id ON guardian_audit(run_id);
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_agent_id ON guardian_audit(agent_id);
        CREATE INDEX IF NOT EXISTS idx_guardian_audit_session_key ON guardian_audit(session_key);
      `);
    })();
    await this.auditDbReady;
  }

  private async appendAudit(event: GuardAuditEvent): Promise<void> {
    try {
      await this.ensureAuditDbReady();
      const stmt = this.auditDb.prepare(`
        INSERT INTO guardian_audit (
          ts, trace_id, run_id, session_key, agent_id, tool_name, risk, action, decision, duration_ms, result, params_preview
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
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
      );
    } catch (error) {
      this.api.logger.warn?.(`[guardian] 写审计失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async beforeToolCall(event: BeforeToolEvent, ctx: ToolContext): Promise<{ block: boolean; blockReason: string } | void> {
    const now = Date.now();
    const traceId = `${event.runId ?? "run"}:${event.toolCallId ?? "tool"}:${sha256(`${event.toolName}:${now}`).slice(0, 8)}`;
    const paramsPreview = buildParamsPreview(event.params);
    const { risk, action, reason } = this.evaluatePolicy(event, ctx);
    const traceKey = computeTraceKey(event, ctx);

    if (action === "allow") {
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
      });
      return;
    }

    if (action === "deny") {
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
        ts: now,
      });
      return { block: true, blockReason: `Guardian blocked: ${reason}` };
    }

    const manager = this.resolveApprovalManager();
    if (!manager) {
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
    };

    const record = manager.create(requestPayload, this.policy.approvalTimeoutMs, null);
    const decisionPromise = manager.register(record, this.policy.approvalTimeoutMs);

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

    const rawDecision = await decisionPromise;
    const decision = normalizeDecision(rawDecision) ?? "deny";
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

    if (decision === "allow-always") {
      const key = `${ctx.sessionKey ?? "global"}::${ctx.agentId ?? "agent"}::${normalizeToolName(event.toolName)}`;
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
      ts: Date.now(),
    });
    return { block: true, blockReason: "Guardian blocked: approval denied" };
  }

  async afterToolCall(event: AfterToolEvent, ctx: ToolContext): Promise<void> {
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
    const result = event.error ? "error" : "ok";
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
      ts: Date.now(),
    });
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
        params_preview as paramsPreview
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
    }));
    return { page, pageSize, total, items };
  }
}

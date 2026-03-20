import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { TaskStore, TaskStoreError, type Task } from "./task-store.js";
import { createBeforeAgentStartHandler } from "./hooks/before-agent-start.js";
import { assessTaskComplexity } from "./trigger-detector.js";

const PLUGIN_ID = "task-manager";
const DEFAULT_WEBHOOK_TTL_SECONDS = 900;
const LOCALHOST_FALLBACK_GATEWAY_PORT = 18789;
const TASK_MANAGER_TRIGGER_HEADER = "## Task Manager 触发建议";
const TASK_MANAGER_DYNAMIC_SWITCH_HEADER = "## Task Manager 动态切换建议";
const TASK_MANAGER_CONTEXT_START_MARKER = "<!-- task-manager:context:start -->";
const TASK_MANAGER_CONTEXT_END_MARKER = "<!-- task-manager:context:end -->";
const TASK_MANAGER_LEGACY_HEADER_RE = /##\s*Task Manager(?:\s*(?:恢复提示|动态切换建议|触发建议|Task Packet))?/i;
const TASK_MANAGER_TIMESTAMP_BOUNDARY_RE = /\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i;
const TASK_MANAGER_ARM_TTL_MS = 5 * 60 * 1000;
const TASK_MANAGER_GUARD_STATE_FILE = "task-manager-guard-state.json";
const TASK_MANAGER_LOADED_PROBE_FILE = "task-manager-plugin-loaded.json";
const TASK_MANAGER_WORKFLOW_TOOLS = new Set<string>([
  "task_create",
  "task_set_plan_markdown",
  "task_bind_session",
  "task_request_user_input",
  "task_wait_approval",
  "task_mark_failed",
  "sessions_spawn",
]);
let defaultWorkspaceDir = process.cwd();
let guardStatePath = path.resolve(TASK_MANAGER_GUARD_STATE_FILE);
type LoggerLike = Partial<Pick<OpenClawPluginApi["logger"], "info" | "warn">>;
type TaskDecision = "approve" | "reject";

const createTaskParameters = {
  type: "object",
  additionalProperties: false,
  required: ["goal"],
  properties: {
    goal: { type: "string" },
  },
} as const;

const setPlanParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "markdown"],
  properties: {
    taskId: { type: "string" },
    markdown: { type: "string" },
  },
} as const;

const bindSessionParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "string" },
    sessionKey: { type: "string" },
  },
} as const;

const requestUserInputParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "question"],
  properties: {
    taskId: { type: "string" },
    question: { type: "string" },
    inputMode: { type: "string", enum: ["decision", "free_text"] },
  },
} as const;

const waitApprovalParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "description"],
  properties: {
    taskId: { type: "string" },
    description: { type: "string" },
    ttlSec: { type: "number" },
  },
} as const;

const markFailedParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "reason"],
  properties: {
    taskId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const storeCache = new Map<string, TaskStore>();
const triggerArmedSessions = new Map<string, number>();
let eventPublisher: ((event: string, payload: Record<string, unknown>) => void) | null = null;

type TriggerGuardState = {
  version: 1;
  sessions: Record<string, number>;
};

function createEmptyGuardState(): TriggerGuardState {
  return {
    version: 1,
    sessions: {},
  };
}

function resolveGuardStatePath(): string {
  const stateDirFromEnv = typeof process.env.OPENCLAW_STATE_DIR === "string" ? process.env.OPENCLAW_STATE_DIR.trim() : "";
  if (stateDirFromEnv) {
    return path.join(stateDirFromEnv, TASK_MANAGER_GUARD_STATE_FILE);
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    return path.join(home, ".openclaw", TASK_MANAGER_GUARD_STATE_FILE);
  }
  return path.resolve(TASK_MANAGER_GUARD_STATE_FILE);
}

function resolveLoadedProbePath(): string {
  const stateDirFromEnv = typeof process.env.OPENCLAW_STATE_DIR === "string" ? process.env.OPENCLAW_STATE_DIR.trim() : "";
  if (stateDirFromEnv) {
    return path.join(stateDirFromEnv, TASK_MANAGER_LOADED_PROBE_FILE);
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    return path.join(home, ".openclaw", TASK_MANAGER_LOADED_PROBE_FILE);
  }
  return path.resolve(TASK_MANAGER_LOADED_PROBE_FILE);
}

async function writeLoadedProbe(
  logger: LoggerLike,
  info: { workspaceDir: string; guardStatePath: string },
): Promise<void> {
  try {
    const probePath = resolveLoadedProbePath();
    await mkdir(path.dirname(probePath), { recursive: true });
    await writeFile(
      probePath,
      JSON.stringify(
        {
          plugin: PLUGIN_ID,
          loadedAt: new Date().toISOString(),
          pid: process.pid,
          cwd: process.cwd(),
          workspaceDir: info.workspaceDir,
          guardStatePath: info.guardStatePath,
          envStateDir: process.env.OPENCLAW_STATE_DIR ?? null,
        },
        null,
        2,
      ),
      "utf8",
    );
    safeLogInfo(logger, `[task-manager] loaded probe written: ${probePath}`);
  } catch (error) {
    safeLogWarn(
      logger,
      `[task-manager] failed to write loaded probe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function safeLogInfo(logger: LoggerLike | undefined, message: string): void {
  try {
    logger?.info?.(message);
  } catch {
    // 测试桩或宿主异常时忽略日志错误，避免影响主流程。
  }
}

function safeLogWarn(logger: LoggerLike | undefined, message: string): void {
  try {
    logger?.warn?.(message);
  } catch {
    // 测试桩或宿主异常时忽略日志错误，避免影响主流程。
  }
}

function normalizeGuardState(raw: unknown): TriggerGuardState {
  if (!raw || typeof raw !== "object") {
    return createEmptyGuardState();
  }
  const record = raw as Record<string, unknown>;
  const normalizeBucket = (bucket: unknown): Record<string, number> => {
    if (!bucket || typeof bucket !== "object") {
      return {};
    }
    const input = bucket as Record<string, unknown>;
    const output: Record<string, number> = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        output[key] = value;
      }
    }
    return output;
  };
  return {
    version: 1,
    sessions: normalizeBucket(record.sessions),
  };
}

async function readGuardState(): Promise<TriggerGuardState> {
  try {
    const raw = await readFile(guardStatePath, "utf8");
    return normalizeGuardState(JSON.parse(raw));
  } catch {
    return createEmptyGuardState();
  }
}

async function writeGuardState(state: TriggerGuardState): Promise<void> {
  await mkdir(path.dirname(guardStatePath), { recursive: true });
  await writeFile(guardStatePath, JSON.stringify(state, null, 2), "utf8");
}

function cleanupExpiredGuards(state: TriggerGuardState, now = Date.now()): boolean {
  let changed = false;
  for (const [sessionKey, armedAt] of Object.entries(state.sessions)) {
    if (now - armedAt > TASK_MANAGER_ARM_TTL_MS) {
      delete state.sessions[sessionKey];
      changed = true;
    }
  }
  return changed;
}

async function armPersistentGuard(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    return;
  }
  const state = await readGuardState();
  cleanupExpiredGuards(state);
  const now = Date.now();
  state.sessions[sessionKey] = now;
  await writeGuardState(state);
}

async function disarmPersistentGuard(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    return;
  }
  const state = await readGuardState();
  const changedByCleanup = cleanupExpiredGuards(state);
  let changed = changedByCleanup;
  if (sessionKey && state.sessions[sessionKey] !== undefined) {
    delete state.sessions[sessionKey];
    changed = true;
  }
  if (changed) {
    await writeGuardState(state);
  }
}

async function hasPersistentGuard(sessionKey?: string): Promise<boolean> {
  if (!sessionKey) {
    return false;
  }
  const state = await readGuardState();
  const changed = cleanupExpiredGuards(state);
  const armed = state.sessions[sessionKey] !== undefined;
  if (changed) {
    await writeGuardState(state);
  }
  return armed;
}

function resolveWorkspaceDir(candidate?: unknown): string {
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return path.resolve(candidate.trim());
  }
  return defaultWorkspaceDir;
}

function isWorkerSession(sessionKey?: string): boolean {
  if (!sessionKey) {
    return false;
  }
  const lowered = sessionKey.toLowerCase();
  return lowered.includes("spawn") || lowered.includes("subagent") || lowered.includes("worker");
}

function cleanupTriggerArmedSessions(now = Date.now()): void {
  for (const [sessionKey, armedAt] of triggerArmedSessions.entries()) {
    if (now - armedAt > TASK_MANAGER_ARM_TTL_MS) {
      triggerArmedSessions.delete(sessionKey);
    }
  }
}

function resolveStore(workspaceDir?: unknown): TaskStore {
  const normalized = resolveWorkspaceDir(workspaceDir);
  const existed = storeCache.get(normalized);
  if (existed) {
    return existed;
  }
  const created = new TaskStore(normalized);
  storeCache.set(normalized, created);
  return created;
}

function resolveGatewayPort(api: OpenClawPluginApi): number {
  const maybePort = (api.config as { gateway?: { port?: unknown } })?.gateway?.port;
  return typeof maybePort === "number" && Number.isFinite(maybePort) ? maybePort : LOCALHOST_FALLBACK_GATEWAY_PORT;
}

function getToolStore(ctx: { workspaceDir?: string }): TaskStore {
  return resolveStore(ctx.workspaceDir);
}

function publishTaskEvent(event: string, payload: Record<string, unknown>): void {
  if (eventPublisher) {
    eventPublisher(event, payload);
  }
}

function updateEventPublisher(options: GatewayRequestHandlerOptions): void {
  eventPublisher = (event, payload) => {
    try {
      options.context.broadcast(event, payload, { dropIfSlow: true });
    } catch {}
  };
}

function asTaskPayload(task: Task, workspaceDir: string): Record<string, unknown> {
  return {
    ...task,
    workspaceDir,
  };
}

function normalizeDecision(value: unknown): TaskDecision | "" {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const approveHints = new Set([
    "approve",
    "approved",
    "accept",
    "accepted",
    "yes",
    "y",
    "ok",
    "confirm",
    "confirmed",
    "同意",
    "批准",
    "确认",
    "通过",
    "是",
  ]);
  const rejectHints = new Set([
    "reject",
    "rejected",
    "deny",
    "denied",
    "no",
    "n",
    "拒绝",
    "驳回",
    "否",
    "不通过",
  ]);
  if (approveHints.has(normalized)) {
    return "approve";
  }
  if (rejectHints.has(normalized)) {
    return "reject";
  }
  return "";
}

function mapTaskStoreError(error: unknown): { code: string; message: string; statusCode: number } {
  if (error instanceof TaskStoreError) {
    if (error.code === "task_not_found") {
      return { code: "not_found", message: error.message, statusCode: 404 };
    }
    if (error.code === "invalid_confirm_id") {
      return { code: "conflict", message: error.message, statusCode: 409 };
    }
    if (error.code === "resume_conflict") {
      return { code: "conflict", message: error.message, statusCode: 409 };
    }
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message, statusCode: 500 };
  }
  return { code: "internal_error", message: String(error), statusCode: 500 };
}

function jsonResponse(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveQuery(urlValue: string | undefined): URL {
  return new URL(urlValue ?? "/", "http://127.0.0.1");
}

async function publishStatusChange(store: TaskStore, before: Task | null, after: Task, reason?: string): Promise<void> {
  if (!before || before.status !== after.status) {
    publishTaskEvent("task_status_changed", {
      taskId: after.id,
      from: before?.status ?? null,
      to: after.status,
      ...(reason ? { reason } : {}),
      task: asTaskPayload(after, store.getWorkspaceDir()),
    });
  }
}

function buildDynamicSwitchHint(): string {
  return [
    TASK_MANAGER_DYNAMIC_SWITCH_HEADER,
    "- 系统检测到你在上一轮输出中已经进入多步骤执行结构。",
    "- 允许现在“中途反悔”并切换为任务模式，不需要等待当前普通流程结束。",
    "- 建议立刻执行：task_create -> task_set_plan_markdown -> sessions_spawn(mode=\"run\", cleanup=\"delete\") -> task_bind_session。",
  ].join("\n");
}

function shouldArmFromAssistantOutput(text: string): boolean {
  const assessment = assessTaskComplexity({
    promptText: "",
    assistantText: text,
    skipWhenTaskIdInPrompt: false,
  });
  if (!assessment.shouldSuggestTaskMode) {
    return false;
  }
  const signals = assessment.signals;
  return signals.stepLabelCount > 0 || signals.listCount >= 3 || signals.sequenceCount >= 2;
}

function wrapTaskManagerPrependContext(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.includes(TASK_MANAGER_CONTEXT_START_MARKER) && normalized.includes(TASK_MANAGER_CONTEXT_END_MARKER)) {
    return normalized;
  }
  return [TASK_MANAGER_CONTEXT_START_MARKER, normalized, TASK_MANAGER_CONTEXT_END_MARKER].join("\n");
}

function stripTaskManagerMarkerBlocks(text: string): string {
  const pattern = new RegExp(
    `${TASK_MANAGER_CONTEXT_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${TASK_MANAGER_CONTEXT_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
    "gi",
  );
  return text.replace(pattern, "");
}

function stripLegacyTaskManagerNotice(text: string): string {
  const headerMatch = TASK_MANAGER_LEGACY_HEADER_RE.exec(text);
  if (!headerMatch || headerMatch.index == null || headerMatch.index > 4) {
    return text;
  }
  const start = headerMatch.index;
  const tail = text.slice(start);
  const boundaryIndex = tail.search(TASK_MANAGER_TIMESTAMP_BOUNDARY_RE);
  if (boundaryIndex >= 0) {
    const end = start + boundaryIndex;
    return `${text.slice(0, start)}${text.slice(end)}`;
  }
  const splitIndex = tail.indexOf("\n\n");
  if (splitIndex >= 0) {
    const end = start + splitIndex + 2;
    return `${text.slice(0, start)}${text.slice(end)}`;
  }
  return text;
}

function sanitizeTaskManagerInjectedText(text: string): string {
  const withoutMarkers = stripTaskManagerMarkerBlocks(text);
  const withoutLegacy = stripLegacyTaskManagerNotice(withoutMarkers);
  if (withoutMarkers === text && withoutLegacy === withoutMarkers) {
    return text;
  }
  return withoutLegacy.replace(/^\s+/, "");
}

function sanitizeTaskManagerInjectedMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "user") {
    return message;
  }

  let changed = false;
  const nextMessage: Record<string, unknown> = { ...record };
  const content = record.content;
  if (typeof content === "string") {
    const cleaned = sanitizeTaskManagerInjectedText(content);
    if (cleaned !== content) {
      nextMessage.content = cleaned;
      changed = true;
    }
  } else if (Array.isArray(content)) {
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type !== "text" || typeof blockRecord.text !== "string") {
        return block;
      }
      const cleaned = sanitizeTaskManagerInjectedText(blockRecord.text);
      if (cleaned === blockRecord.text) {
        return block;
      }
      changed = true;
      return { ...blockRecord, text: cleaned };
    });
    if (changed) {
      nextMessage.content = nextContent;
    }
  }

  if (typeof record.text === "string") {
    const cleaned = sanitizeTaskManagerInjectedText(record.text);
    if (cleaned !== record.text) {
      nextMessage.text = cleaned;
      changed = true;
    }
  }

  return changed ? nextMessage : message;
}

const plugin = {
  id: PLUGIN_ID,
  name: "Task Manager",
  description: "Production-grade markdown task planning plugin.",
  register(api: OpenClawPluginApi) {
    defaultWorkspaceDir = resolveWorkspaceDir((api.config as { workspaceDir?: unknown })?.workspaceDir);
    guardStatePath = resolveGuardStatePath();
    void writeLoadedProbe(api.logger, { workspaceDir: defaultWorkspaceDir, guardStatePath });

    api.registerTool((toolCtx) => ({
      name: "task_create",
      label: "Task Create",
      description: "创建新的任务。",
      parameters: createTaskParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const goal = typeof params.goal === "string" ? params.goal.trim() : "";
        if (!goal) {
          throw new Error("goal is required");
        }
        const store = getToolStore(toolCtx);
        const task = await store.createTask(goal);
        const payload = asTaskPayload(task, store.getWorkspaceDir());
        publishTaskEvent("task_status_changed", {
          taskId: task.id,
          from: null,
          to: task.status,
          task: payload,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_set_plan_markdown",
      label: "Task Set Plan Markdown",
      description: "写入任务 Markdown 计划并更新进度。",
      parameters: setPlanParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const markdown = typeof params.markdown === "string" ? params.markdown : "";
        if (!taskId) {
          throw new Error("taskId is required");
        }
        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);
        const task = await store.setPlanMarkdown(taskId, markdown);
        await publishStatusChange(store, before, task, "plan_updated");

        publishTaskEvent("task_progress_update", {
          taskId: task.id,
          progress: task.progress,
          status: task.status,
          task: asTaskPayload(task, store.getWorkspaceDir()),
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(asTaskPayload(task, store.getWorkspaceDir()), null, 2) }],
          details: asTaskPayload(task, store.getWorkspaceDir()),
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_bind_session",
      label: "Task Bind Session",
      description: "绑定任务到当前执行会话。",
      parameters: bindSessionParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const sessionKeyParam = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
        const sessionKey = sessionKeyParam || toolCtx.sessionKey || "";
        if (!taskId) {
          throw new Error("taskId is required");
        }
        if (!sessionKey) {
          throw new Error("sessionKey is required");
        }

        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);
        const task = await store.bindSession(taskId, sessionKey);
        await publishStatusChange(store, before, task, "session_bound");

        return {
          content: [{ type: "text" as const, text: JSON.stringify(asTaskPayload(task, store.getWorkspaceDir()), null, 2) }],
          details: asTaskPayload(task, store.getWorkspaceDir()),
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_request_user_input",
      label: "Task Request User Input",
      description: "将任务置为等待用户确认状态。",
      parameters: requestUserInputParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const question = typeof params.question === "string" ? params.question.trim() : "";
        const inputModeRaw = typeof params.inputMode === "string" ? params.inputMode.trim() : "";
        const inputMode = inputModeRaw === "decision" || inputModeRaw === "free_text"
          ? inputModeRaw
          : undefined;
        if (!taskId || !question) {
          throw new Error("taskId and question are required");
        }

        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);
        const task = await store.blockForUserInput(taskId, question, inputMode);
        await publishStatusChange(store, before, task, "need_user_input");

        publishTaskEvent("task_blocked", {
          taskId: task.id,
          type: "waiting_for_input",
          confirmId: task.blocked_info?.confirm_id,
          inputMode: task.blocked_info?.input_mode,
          question,
          task: asTaskPayload(task, store.getWorkspaceDir()),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "pause_session",
                  message: "任务已挂起，等待用户确认。",
                  confirmId: task.blocked_info?.confirm_id,
                  inputMode: task.blocked_info?.input_mode,
                  task: asTaskPayload(task, store.getWorkspaceDir()),
                },
                null,
                2,
              ),
            },
          ],
          details: {
            action: "pause_session",
            confirmId: task.blocked_info?.confirm_id,
            inputMode: task.blocked_info?.input_mode,
            task: asTaskPayload(task, store.getWorkspaceDir()),
          },
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_wait_approval",
      label: "Task Wait Approval",
      description: "将任务置为等待外部审批状态，并返回回调地址。",
      parameters: waitApprovalParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const description = typeof params.description === "string" ? params.description.trim() : "";
        const ttlSecRaw = typeof params.ttlSec === "number" ? params.ttlSec : DEFAULT_WEBHOOK_TTL_SECONDS;
        const ttlSec = Number.isFinite(ttlSecRaw) && ttlSecRaw > 0 ? Math.floor(ttlSecRaw) : DEFAULT_WEBHOOK_TTL_SECONDS;
        if (!taskId || !description) {
          throw new Error("taskId and description are required");
        }

        const store = getToolStore(toolCtx);
        const webhookToken = randomUUID().replace(/-/g, "");
        const expiresAt = Date.now() + ttlSec * 1000;
        const before = await store.getTask(taskId);
        const task = await store.blockForApproval(taskId, description, webhookToken, expiresAt);
        await publishStatusChange(store, before, task, "waiting_approval");

        const port = resolveGatewayPort(api);
        const webhookUrl = `http://127.0.0.1:${port}/task-manager/webhook?token=${encodeURIComponent(webhookToken)}&taskId=${encodeURIComponent(task.id)}&workspace=${encodeURIComponent(store.getWorkspaceDir())}`;

        publishTaskEvent("task_blocked", {
          taskId: task.id,
          type: "waiting_approval",
          confirmId: task.blocked_info?.confirm_id,
          description,
          webhookToken: webhookToken,
          expiresAt,
          task: asTaskPayload(task, store.getWorkspaceDir()),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "pause_session",
                  webhookUrl,
                  expiresAt,
                  confirmId: task.blocked_info?.confirm_id,
                  task: asTaskPayload(task, store.getWorkspaceDir()),
                },
                null,
                2,
              ),
            },
          ],
          details: {
            action: "pause_session",
            webhookUrl,
            expiresAt,
            confirmId: task.blocked_info?.confirm_id,
            task: asTaskPayload(task, store.getWorkspaceDir()),
          },
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_mark_failed",
      label: "Task Mark Failed",
      description: "将任务标记为失败并记录原因。",
      parameters: markFailedParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!taskId || !reason) {
          throw new Error("taskId and reason are required");
        }
        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);
        const task = await store.failTask(taskId, reason);
        await publishStatusChange(store, before, task, "failed");

        return {
          content: [{ type: "text" as const, text: JSON.stringify(asTaskPayload(task, store.getWorkspaceDir()), null, 2) }],
          details: asTaskPayload(task, store.getWorkspaceDir()),
        };
      },
    }));

    api.registerGatewayMethod("task_list", async (options: GatewayRequestHandlerOptions) => {
      updateEventPublisher(options);
      const workspaceDir = resolveWorkspaceDir(options.params.workspaceDir);
      const store = resolveStore(workspaceDir);
      const tasks = await store.listTasks();
      options.respond(true, { tasks });
    });

    api.registerGatewayMethod("task_get", async (options: GatewayRequestHandlerOptions) => {
      updateEventPublisher(options);
      const workspaceDir = resolveWorkspaceDir(options.params.workspaceDir);
      const taskId = typeof options.params.taskId === "string" ? options.params.taskId.trim() : "";
      if (!taskId) {
        options.respond(false, undefined, { code: "invalid_params", message: "taskId is required" });
        return;
      }
      const store = resolveStore(workspaceDir);
      const task = await store.getTask(taskId);
      options.respond(true, { task });
    });

    api.registerGatewayMethod("task_resume", async (options: GatewayRequestHandlerOptions) => {
      updateEventPublisher(options);
      const workspaceDir = resolveWorkspaceDir(options.params.workspaceDir);
      const taskId = typeof options.params.taskId === "string" ? options.params.taskId.trim() : "";
      const confirmId = typeof options.params.confirmId === "string" ? options.params.confirmId.trim() : "";
      const userInput = typeof options.params.userInput === "string" ? options.params.userInput.trim() : "";
      const decisionParam = typeof options.params.decision === "string" ? options.params.decision.trim() : "";
      const normalizedDecision = normalizeDecision(decisionParam);
      if (!taskId) {
        options.respond(false, undefined, { code: "invalid_params", message: "taskId is required" });
        return;
      }
      if (!confirmId) {
        options.respond(false, undefined, { code: "invalid_params", message: "confirmId is required" });
        return;
      }
      if (decisionParam && !normalizedDecision) {
        options.respond(false, undefined, { code: "invalid_params", message: "decision is invalid" });
        return;
      }

      const store = resolveStore(workspaceDir);
      try {
        const before = await store.getTask(taskId);
        const task = await store.resumeTask(taskId, { confirmId });
        await publishStatusChange(store, before, task, "resumed");

        publishTaskEvent("task_needs_resume", {
          taskId: task.id,
          confirmId,
          resumeReason: normalizedDecision || userInput ? "user_input" : "manual_resume",
          ...(normalizedDecision ? { decision: normalizedDecision } : {}),
          ...(userInput ? { userInput } : {}),
          task: asTaskPayload(task, store.getWorkspaceDir()),
        });

        options.respond(true, { task });
      } catch (error) {
        const mapped = mapTaskStoreError(error);
        options.respond(false, undefined, {
          code: mapped.code,
          message: mapped.message,
        });
      }
    });

    api.registerHttpRoute({
      path: "/task-manager/webhook",
      auth: "plugin",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = resolveQuery(req.url);
          const token = url.searchParams.get("token")?.trim() ?? "";
          const taskId = url.searchParams.get("taskId")?.trim() ?? "";
          const workspace = resolveWorkspaceDir(url.searchParams.get("workspace"));
          if (!token || !taskId) {
            jsonResponse(res, 400, { success: false, error: "token and taskId are required" });
            return;
          }

          const store = resolveStore(workspace);
          const matched = await store.findApprovalTaskByToken(token);
          if (!matched || matched.id !== taskId) {
            jsonResponse(res, 403, { success: false, error: "invalid or expired token" });
            return;
          }

          const before = await store.getTask(taskId);
          const confirmId = matched.blocked_info?.confirm_id?.trim() ?? "";
          if (!confirmId) {
            jsonResponse(res, 409, { success: false, error: "missing confirmId in blocked state" });
            return;
          }
          const task = await store.resumeTask(taskId, { confirmId });
          await publishStatusChange(store, before, task, "approval_webhook");

          publishTaskEvent("task_needs_resume", {
            taskId: task.id,
            confirmId,
            resumeReason: "approval_webhook",
            decision: "approve",
            task: asTaskPayload(task, store.getWorkspaceDir()),
          });

          jsonResponse(res, 200, { success: true, taskId: task.id });
        } catch (error) {
          const mapped = mapTaskStoreError(error);
          jsonResponse(res, mapped.statusCode, {
            success: false,
            error: mapped.message,
          });
        }
      },
    });

    const beforeAgentStartHandler = createBeforeAgentStartHandler(resolveStore);
    api.on("before_agent_start", async (event, ctx) => {
      cleanupTriggerArmedSessions();
      const result = await beforeAgentStartHandler(event, ctx);
      const persistentArmed = await hasPersistentGuard(ctx.sessionKey);
      let prepend = result?.prependContext ?? "";

      if (persistentArmed && !prepend.includes(TASK_MANAGER_TRIGGER_HEADER) && !prepend.includes(TASK_MANAGER_DYNAMIC_SWITCH_HEADER)) {
        prepend = [prepend, buildDynamicSwitchHint()].filter((chunk) => chunk.trim().length > 0).join("\n\n");
      }

      if (prepend.trim().length > 0) {
        prepend = wrapTaskManagerPrependContext(prepend);
      }

      if (prepend.includes(TASK_MANAGER_TRIGGER_HEADER)) {
        const armedAt = Date.now();
        if (ctx.sessionKey) {
          triggerArmedSessions.set(ctx.sessionKey, armedAt);
        }
        await armPersistentGuard(ctx.sessionKey);
        safeLogInfo(
          api.logger,
          `[task-manager] guard armed: session=${ctx.sessionKey ?? "none"}`,
        );
      }
      if (prepend !== (result?.prependContext ?? "")) {
        return {
          ...(result ?? {}),
          prependContext: prepend,
        };
      }
      return result;
    });

    api.on("before_message_write", (event) => {
      const sanitized = sanitizeTaskManagerInjectedMessage(event.message);
      if (sanitized !== event.message) {
        return { message: sanitized as typeof event.message };
      }
      return undefined;
    });

    api.on("llm_output", async (event, ctx) => {
      if (isWorkerSession(ctx.sessionKey)) {
        return;
      }
      const assistantText = Array.isArray(event.assistantTexts)
        ? event.assistantTexts.filter((line): line is string => typeof line === "string").join("\n")
        : "";
      if (!assistantText.trim()) {
        return;
      }
      if (!shouldArmFromAssistantOutput(assistantText)) {
        return;
      }
      const armedAt = Date.now();
      if (ctx.sessionKey) {
        triggerArmedSessions.set(ctx.sessionKey, armedAt);
      }
      await armPersistentGuard(ctx.sessionKey);
      safeLogInfo(
        api.logger,
        `[task-manager] dynamic switch armed from llm_output: session=${ctx.sessionKey ?? "none"}`,
      );
    });

    api.on("before_tool_call", async (event, ctx) => {
      cleanupTriggerArmedSessions();
      const sessionKey = ctx.sessionKey;
      const armedBySession = sessionKey ? triggerArmedSessions.get(sessionKey) : undefined;
      const armedByPersistent = await hasPersistentGuard(sessionKey);
      if (armedBySession || armedByPersistent) {
        const toolName = event.toolName;
        if (TASK_MANAGER_WORKFLOW_TOOLS.has(toolName)) {
          if (sessionKey) {
            triggerArmedSessions.delete(sessionKey);
          }
          await disarmPersistentGuard(sessionKey);
          safeLogInfo(
            api.logger,
            `[task-manager] guard disarmed by workflow tool: tool=${toolName}, session=${sessionKey ?? "none"}`,
          );
        } else {
          safeLogInfo(
            api.logger,
            `[task-manager] guard observed non-workflow tool: tool=${toolName}, session=${sessionKey ?? "none"}`,
          );
        }
      }
    });
  },
};

export default plugin;

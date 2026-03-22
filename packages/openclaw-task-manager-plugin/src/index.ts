import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { TaskStore, TaskStoreError, type Task, type TaskStepInput } from "./task-store.js";

const PLUGIN_ID = "task-manager";
const DEFAULT_WEBHOOK_TTL_SECONDS = 900;
const DEFAULT_GRACE_WINDOW_MS = 120_000;
const LOCALHOST_FALLBACK_GATEWAY_PORT = 18789;
const DEFAULT_SESSION_STATE_KEY = "__default__";

const TASK_MODE_PROTOCOL = [
  "当前处于路由阶段，你正常回答的同时，还需要判定当前是direct还是draft",
  "你必须优先结合 [TASK_RUNTIME_FACTS] 判定是否与已有任务重复。",
  "",
  "判定规则（命中任一即为 draft，否则为 direct）：",
  "- 预估需要大于5次tool call工具调用",
  "- 涉及多文件修改或项目结构变更",
  "- 需要分阶段执行的复杂逻辑",
  "- 用户明确提出多步骤需求",
  "",
  "不确定时策略：",
  "- 若不确定，默认判定为 direct",
  "",
  "动作约束：",
  "- 路由阶段一律不调用任何 task_* 工具",
  "- decision=direct：正常回答",
  "- decision=draft：给出任务草案（goal+steps，且 steps 至少 1 项）",
  "- 若与已有任务重复且用户未明确要求重复创建：复用已有任务并直接告知用户",
  "",
  "输出协议：",
  "```task_router_decision_json",
  "{\"decision\":\"direct|draft\",\"reuseExisting\":false,\"existingTaskId\":\"\",\"allowDuplicate\":false,\"confidence\":0.00}",
  "```",
  "",
  "协议约束：",
  "- 仅允许字段 decision/reuseExisting/existingTaskId/allowDuplicate/confidence",
  "- confidence 为 0~1 数字，保留两位小数",
  "- 决策块只能输出 1 个，且必须放在回复末尾",
].join("\n");

const TASK_DRAFT_CONTEXT = [
  "当前处于 task 草案阶段（task_draft）。请严格按“决策-动作协议”执行。",
  "请基于当前会话里的最近草案与用户本轮输入完成判定，并执行对应动作。",
  "",
  "可选决策：",
  "- revise_draft：用户要改草案",
  "- approve_create：用户确认草案并允许创建任务",
  "- reject_draft：用户拒绝草案",
  "- new_task：用户提出新任务",
  "- fallback_direct：回到普通 direct 对话",
  "",
  "决策-动作协议（严格）：",
  "- 仅当 decision=approve_create 时允许调用 task_create；其余决策均禁止调用 task_create。",
  "- decision=approve_create：必须在同回合立即调用 task_create，参数必须包含 draftId、draftVersion、goal、steps。",
  "- decision=approve_create：steps 必须为非空数组（至少 1 个步骤），且每个步骤必须包含 title。",
  "- decision=approve_create：禁止只输出 JSON 决策块而不调用 task_create。",
  "- decision=revise_draft / reject_draft / new_task / fallback_direct：禁止调用 task_create，只输出决策块。",
  "",
  "失败与降级策略：",
  "- 若你无法构造满足约束的 task_create 参数（例如 steps 不完整），不得输出 approve_create。",
  "- 此时必须改为 decision=revise_draft，并明确告诉用户缺少哪些信息。",
  "- 禁止空回复。每次回复都要先给用户可见文本，再附决策块（approve_create 触发 tool call 时除外）。",
  "",
  "输出协议：",
  "```task_draft_decision_json",
  "{\"decision\":\"revise_draft|approve_create|reject_draft|new_task|fallback_direct\",\"confidence\":0.00}",
  "```",
  "",
  "协议约束：",
  "- 仅允许字段 decision、confidence；禁止输出其他字段",
  "- confidence 必须是 0~1 的数字（建议两位小数）",
  "- 决策块只能输出 1 个，且必须放在回复末尾（approve_create 且已成功调用 task_create 时可省略）",
  "- 若无法判断，decision 统一输出 fallback_direct",
].join("\n");

const TASK_EXECUTION_PROTOCOL = [
  "当前处于任务执行子会话，请严格围绕 [TASK_ACTIVE_CONTEXT] 执行，不要回到路由/草案判定。",
  "执行要求：",
  "- 优先按 activeTask.goal、activeTask.currentStep、activeTask.steps 推进。",
  "- 如需用户输入或审批，调用 task_block。",
  "- 任务完成时调用 task_finish(status=completed, resultSummary=...)。",
  "- 任务失败时调用 task_finish(status=failed, reason=...)。",
  "- 禁止在执行子会话调用 task_create，避免重复创建任务。",
].join("\n");
const DECISION_BLOCK_PATTERN = /```(?:task_router_decision_json|task_draft_decision_json)\s*[\r\n]+[\s\S]*?```/gim;
const TASK_ROUTER_DECISION_PATTERN = /```task_router_decision_json\s*[\r\n]+([\s\S]*?)```/im;
const TASK_DRAFT_DECISION_PATTERN = /```task_draft_decision_json\s*[\r\n]+([\s\S]*?)```/im;
const DECISION_BLOCK_OPEN_PATTERN = /```(?:task_router_decision_json|task_draft_decision_json)\s*[\r\n]*/im;
const MESSAGE_SENDING_DECISION_STATE_TTL_MS = 10 * 60 * 1000;
const MESSAGE_SENDING_DECISION_STATE_MAX_SIZE = 512;
const DECISION_JSON_ALLOWED_KEYS = new Set([
  "decision",
  "confidence",
  "reuseExisting",
  "existingTaskId",
  "allowDuplicate",
]);
const DECISION_VALUES = new Set([
  "direct",
  "draft",
  "revise_draft",
  "approve_create",
  "reject_draft",
  "new_task",
  "fallback_direct",
]);
type MessageSendingDecisionState = {
  inDecisionBlock: boolean;
  updatedAt: number;
};
const messageSendingDecisionState = new Map<string, MessageSendingDecisionState>();

function normalizeDecisionStateKeyPart(value: unknown): string {
  if (typeof value !== "string") {
    return "_";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "_";
  }
  return trimmed;
}

function buildMessageSendingDecisionStateKey(params: {
  event: { to?: unknown };
  ctx?: { channelId?: unknown; accountId?: unknown; conversationId?: unknown };
}): string {
  const channelId = normalizeDecisionStateKeyPart(params.ctx?.channelId);
  const accountId = normalizeDecisionStateKeyPart(params.ctx?.accountId);
  const conversationId = normalizeDecisionStateKeyPart(params.ctx?.conversationId);
  const target = normalizeDecisionStateKeyPart(params.event?.to);
  return `${channelId}|${accountId}|${conversationId}|${target}`;
}

function cleanupMessageSendingDecisionState(now: number): void {
  if (messageSendingDecisionState.size === 0) {
    return;
  }
  for (const [key, state] of messageSendingDecisionState.entries()) {
    if (now - state.updatedAt > MESSAGE_SENDING_DECISION_STATE_TTL_MS) {
      messageSendingDecisionState.delete(key);
    }
  }
  const overflow = messageSendingDecisionState.size - MESSAGE_SENDING_DECISION_STATE_MAX_SIZE;
  if (overflow <= 0) {
    return;
  }
  const ordered = [...messageSendingDecisionState.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  for (let index = 0; index < overflow; index += 1) {
    messageSendingDecisionState.delete(ordered[index][0]);
  }
}

function stripDecisionArtifactsFromStreamingText(params: {
  text: string;
  inDecisionBlock: boolean;
}): { text: string; changed: boolean; inDecisionBlock: boolean } {
  let working = params.text;
  let changed = false;
  let inDecisionBlock = params.inDecisionBlock;

  while (working.length > 0) {
    if (inDecisionBlock) {
      const closingFenceIndex = working.indexOf("```");
      changed = true;
      if (closingFenceIndex < 0) {
        return { text: "", changed: true, inDecisionBlock: true };
      }
      working = working.slice(closingFenceIndex + 3);
      inDecisionBlock = false;
      continue;
    }

    const openMatch = DECISION_BLOCK_OPEN_PATTERN.exec(working);
    if (!openMatch || openMatch.index == null) {
      break;
    }
    const openStart = openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    const closingFenceIndex = working.indexOf("```", openEnd);
    if (closingFenceIndex < 0) {
      working = working.slice(0, openStart);
      changed = true;
      inDecisionBlock = true;
      break;
    }
    working = `${working.slice(0, openStart)}${working.slice(closingFenceIndex + 3)}`;
    changed = true;
  }

  const stripped = stripDecisionArtifactsFromText(working);
  return {
    text: stripped.text,
    changed: changed || stripped.changed,
    inDecisionBlock,
  };
}

function stripDecisionBlocksFromText(text: string): { text: string; changed: boolean } {
  const removed = text.replace(DECISION_BLOCK_PATTERN, "");
  const compacted = removed.replace(/\n{3,}/g, "\n\n").trimEnd();
  return {
    text: compacted,
    changed: compacted !== text,
  };
}

function isDecisionJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length < 2 || !keys.every((key) => DECISION_JSON_ALLOWED_KEYS.has(key))) {
      return false;
    }
    if (typeof parsed.decision !== "string" || !DECISION_VALUES.has(parsed.decision)) {
      return false;
    }
    if (typeof parsed.confidence !== "number") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function stripDecisionJsonLinesFromText(text: string): { text: string; changed: boolean } {
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !isDecisionJsonLine(line));
  const changed = filtered.length !== lines.length;
  if (!changed) {
    return { text, changed: false };
  }
  return {
    text: filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
    changed: true,
  };
}

function stripDecisionArtifactsFromText(text: string): { text: string; changed: boolean } {
  const strippedBlocks = stripDecisionBlocksFromText(text);
  const strippedJsonLines = stripDecisionJsonLinesFromText(strippedBlocks.text);
  return {
    text: strippedJsonLines.text,
    changed: strippedBlocks.changed || strippedJsonLines.changed,
  };
}

function sanitizeAssistantMessageBeforeWrite(message: unknown): {
  changed: boolean;
  empty: boolean;
  message: unknown;
} {
  if (!message || typeof message !== "object") {
    return { changed: false, empty: false, message };
  }
  const raw = message as Record<string, unknown>;
  if (raw.role !== "assistant") {
    return { changed: false, empty: false, message };
  }

  const content = raw.content;
  if (typeof content === "string") {
    const stripped = stripDecisionArtifactsFromText(content);
    if (!stripped.changed) {
      return { changed: false, empty: false, message };
    }
    const nextMessage = { ...raw, content: stripped.text };
    return { changed: true, empty: stripped.text.trim().length === 0, message: nextMessage };
  }

  if (!Array.isArray(content)) {
    return { changed: false, empty: false, message };
  }

  let changed = false;
  const nextContent: unknown[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      nextContent.push(item);
      continue;
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      const stripped = stripDecisionArtifactsFromText(block.text);
      changed = changed || stripped.changed;
      if (stripped.text.trim().length > 0) {
        nextContent.push({ ...block, text: stripped.text });
      }
      continue;
    }
    nextContent.push(item);
  }

  if (!changed) {
    return { changed: false, empty: false, message };
  }

  const hasRenderableContent = nextContent.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text") {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    return true;
  });

  return {
    changed: true,
    empty: !hasRenderableContent,
    message: { ...raw, content: nextContent },
  };
}

const createTaskParameters = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "draftId", "draftVersion", "steps"],
  properties: {
    goal: { type: "string" },
    draftId: { type: "string" },
    draftVersion: { type: "number" },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          dependsOn: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    checkpointSummary: { type: "string" },
  },
} as const;

const taskBlockParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "blockType"],
  properties: {
    taskId: { type: "string" },
    blockType: { type: "string", enum: ["user_input", "approval"] },
    question: { type: "string" },
    description: { type: "string" },
    inputMode: { type: "string", enum: ["decision", "free_text"] },
    ttlSec: { type: "number" },
    graceWindowMs: { type: "number" },
    checkpointSummary: { type: "string" },
  },
} as const;

const taskResumeParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "confirmId"],
  properties: {
    taskId: { type: "string" },
    confirmId: { type: "string" },
    decision: { type: "string", enum: ["approve", "reject"] },
    userInput: { type: "string" },
  },
} as const;

const taskFinishParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "status"],
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: ["completed", "failed"] },
    resultSummary: { type: "string" },
    reason: { type: "string" },
    checkpointSummary: { type: "string" },
  },
} as const;

const taskDeleteParameters = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const storeCache = new Map<string, TaskStore>();
let eventPublisher: ((event: string, payload: Record<string, unknown>) => void) | null = null;
let defaultWorkspaceDir = process.cwd();

type TaskDecision = "approve" | "reject";
type SessionMode = "direct" | "task_draft";
type DraftDecision = "revise_draft" | "approve_create" | "reject_draft" | "new_task" | "fallback_direct";

interface RouterDecisionPayload {
  decision: "direct" | "draft";
  confidence: number;
  reuseExisting: boolean;
  existingTaskId: string;
  allowDuplicate: boolean;
}

interface DraftDecisionPayload {
  decision: DraftDecision;
  confidence: number;
}

type DraftLifecycleStatus = "pending" | "approved" | "consumed";

interface SessionDraftState {
  id: string;
  version: number;
  status: DraftLifecycleStatus;
  approvedVersion?: number;
  consumedVersion?: number;
  consumedTaskId?: string;
}

interface SessionTaskState {
  mode: SessionMode;
  activeTaskId?: string;
  draft?: SessionDraftState;
  updatedAt: number;
}

const sessionState = new Map<string, SessionTaskState>();

interface RunningTaskFact {
  id: string;
  goal: string;
  status: string;
  progress: number;
  stepCount: number;
  currentStepId?: string;
  currentStepTitle?: string;
  blockedReason?: string;
  waitingQuestion?: string;
  waitingDescription?: string;
  latestCheckpointSummary?: string;
}

interface ActiveTaskFact {
  id: string;
  goal: string;
  status: string;
  progress: number;
  assignedSession?: string;
  currentStepId?: string;
  currentStepTitle?: string;
  currentStepDescription?: string;
  blockedReason?: string;
  waitingQuestion?: string;
  waitingDescription?: string;
  steps: Array<{
    id: string;
    title: string;
    status: string;
    description?: string;
  }>;
  checkpointsTail: Array<{
    id: string;
    kind: string;
    summary: string;
    createdAt: number;
  }>;
}

type ResumeMeta = {
  confirmId: string;
  decision?: TaskDecision;
  userInput?: string;
  resumeReason: string;
};

function resolveWorkspaceDir(candidate?: unknown): string {
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return path.resolve(candidate.trim());
  }
  return defaultWorkspaceDir;
}

function resolveStateKey(sessionKey?: string): string {
  if (typeof sessionKey !== "string" || !sessionKey.trim()) {
    return DEFAULT_SESSION_STATE_KEY;
  }
  return sessionKey.trim();
}

function readSessionState(sessionKey?: string): SessionTaskState {
  const key = resolveStateKey(sessionKey);
  const existed = sessionState.get(key);
  if (existed) {
    return existed;
  }
  const created: SessionTaskState = { mode: "direct", updatedAt: Date.now() };
  sessionState.set(key, created);
  return created;
}

function writeSessionState(
  sessionKey: string | undefined,
  patch: Partial<SessionTaskState>,
  modeOverride?: SessionMode,
): SessionTaskState {
  const key = resolveStateKey(sessionKey);
  const prev = readSessionState(key);
  const next: SessionTaskState = {
    ...prev,
    ...patch,
    ...(modeOverride ? { mode: modeOverride } : {}),
    updatedAt: Date.now(),
  };
  sessionState.set(key, next);
  return next;
}

function normalizeSessionKey(sessionKey?: unknown): string {
  if (typeof sessionKey !== "string") {
    return "";
  }
  return sessionKey.trim();
}

function bindTaskToAssignedSession(task: Task): void {
  const assignedSessionKey = normalizeSessionKey(task.assigned_session);
  if (!assignedSessionKey) {
    return;
  }
  writeSessionState(
    assignedSessionKey,
    { activeTaskId: task.id },
    "direct",
  );
}

function clearTaskFromActiveSessions(taskId: string): void {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    return;
  }
  for (const [sessionKey, state] of sessionState.entries()) {
    if (state.activeTaskId === normalizedTaskId) {
      writeSessionState(sessionKey, { activeTaskId: undefined }, "direct");
    }
  }
}

function clearDeletedTaskFromSessionStates(taskId: string): void {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    return;
  }
  for (const [sessionKey, state] of sessionState.entries()) {
    let changed = false;
    let nextMode: SessionMode = state.mode;
    let nextActiveTaskId = state.activeTaskId;
    let nextDraft = state.draft;

    if (state.activeTaskId === normalizedTaskId) {
      nextActiveTaskId = undefined;
      changed = true;
    }

    if (state.draft?.consumedTaskId === normalizedTaskId) {
      nextDraft = undefined;
      if (state.mode === "task_draft") {
        nextMode = "direct";
      }
      changed = true;
    }

    if (changed) {
      writeSessionState(
        sessionKey,
        {
          activeTaskId: nextActiveTaskId,
          draft: nextDraft,
        },
        nextMode,
      );
    }
  }
}

function safeParseJsonBlock(text: string, pattern: RegExp): Record<string, unknown> | null {
  const matched = text.match(pattern);
  if (!matched?.[1]) {
    return null;
  }
  const raw = matched[1].trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function parseAgentIdFromSessionKey(sessionKey?: string): string {
  if (!sessionKey) {
    return "main";
  }
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1]?.trim() || "main";
}

function buildTaskWorkerSessionKey(sessionKey: string | undefined, taskId: string): string {
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  return `agent:${agentId}:task:${taskId}`;
}

function createNewDraftState(): SessionDraftState {
  return {
    id: `draft-${Date.now()}-${randomUUID().slice(0, 8)}`,
    version: 1,
    status: "pending",
  };
}

function bumpDraftVersion(draft: SessionDraftState): SessionDraftState {
  return {
    ...draft,
    version: draft.version + 1,
    status: "pending",
    approvedVersion: undefined,
    consumedVersion: undefined,
    consumedTaskId: undefined,
  };
}

function parseRouterDecision(text: string): RouterDecisionPayload | null {
  const parsed = safeParseJsonBlock(text, TASK_ROUTER_DECISION_PATTERN);
  if (!parsed) {
    return null;
  }
  const decision = typeof parsed.decision === "string" ? parsed.decision.trim() : "";
  if (decision !== "direct" && decision !== "draft") {
    return null;
  }
  const existingTaskId = typeof parsed.existingTaskId === "string" ? parsed.existingTaskId.trim() : "";
  return {
    decision,
    confidence: normalizeConfidence(parsed.confidence),
    reuseExisting: parsed.reuseExisting === true,
    existingTaskId,
    allowDuplicate: parsed.allowDuplicate === true,
  };
}

function parseDraftDecision(text: string): DraftDecisionPayload | null {
  const parsed = safeParseJsonBlock(text, TASK_DRAFT_DECISION_PATTERN);
  if (!parsed) {
    return null;
  }
  const decisionRaw = typeof parsed.decision === "string" ? parsed.decision.trim() : "";
  const allowed = new Set<DraftDecision>(["revise_draft", "approve_create", "reject_draft", "new_task", "fallback_direct"]);
  if (!allowed.has(decisionRaw as DraftDecision)) {
    return null;
  }
  return {
    decision: decisionRaw as DraftDecision,
    confidence: normalizeConfidence(parsed.confidence),
  };
}

function applyRouterDecision(sessionKey: string | undefined, decision: RouterDecisionPayload): void {
  if (decision.decision === "direct") {
    writeSessionState(sessionKey, { activeTaskId: decision.existingTaskId || undefined }, "direct");
    return;
  }
  if (decision.reuseExisting && !decision.allowDuplicate && decision.existingTaskId) {
    writeSessionState(sessionKey, { activeTaskId: decision.existingTaskId }, "direct");
    return;
  }
  writeSessionState(sessionKey, { activeTaskId: undefined, draft: createNewDraftState() }, "task_draft");
}

function applyDraftDecision(sessionKey: string | undefined, decision: DraftDecisionPayload): void {
  const current = readSessionState(sessionKey);
  const currentDraft = current.draft ?? createNewDraftState();
  if (decision.decision === "approve_create") {
    writeSessionState(
      sessionKey,
      {
        draft: {
          ...currentDraft,
          status: "approved",
          approvedVersion: currentDraft.version,
        },
      },
      "task_draft",
    );
    return;
  }
  if (decision.decision === "revise_draft") {
    writeSessionState(sessionKey, { draft: bumpDraftVersion(currentDraft) }, "task_draft");
    return;
  }
  if (decision.decision === "new_task") {
    writeSessionState(sessionKey, { draft: createNewDraftState() }, "task_draft");
    return;
  }
  writeSessionState(sessionKey, { activeTaskId: undefined, draft: undefined }, "direct");
}

function buildPromptContextByState(state: SessionTaskState): string {
  if (state.mode === "task_draft") {
    const draft = state.draft ?? createNewDraftState();
    return [
      TASK_DRAFT_CONTEXT,
      "",
      "[DRAFT_CONTEXT]",
      `draftId=${draft.id}`,
      `draftVersion=${draft.version}`,
      `draftStatus=${draft.status}`,
    ].join("\n");
  }
  return TASK_MODE_PROTOCOL;
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

function getToolStore(ctx: { workspaceDir?: string }): TaskStore {
  return resolveStore(ctx.workspaceDir);
}

function resolveGatewayPort(api: OpenClawPluginApi): number {
  const maybePort = (api.config as { gateway?: { port?: unknown } })?.gateway?.port;
  return typeof maybePort === "number" && Number.isFinite(maybePort) ? maybePort : LOCALHOST_FALLBACK_GATEWAY_PORT;
}

function updateEventPublisher(options: GatewayRequestHandlerOptions): void {
  eventPublisher = (event, payload) => {
    try {
      options.context.broadcast(event, payload, { dropIfSlow: true });
    } catch {
      // ignore broadcast failure
    }
  };
}

function publishTaskEvent(event: string, payload: Record<string, unknown>): void {
  if (eventPublisher) {
    eventPublisher(event, payload);
  }
}

function asTaskPayload(task: Task, workspaceDir: string): Record<string, unknown> {
  return {
    ...task,
    workspaceDir,
  };
}

function isTaskOpen(task: Task): boolean {
  return task.status === "running" || task.status === "waiting_for_input" || task.status === "waiting_approval";
}

function toRunningTaskFacts(tasks: Task[]): RunningTaskFact[] {
  return tasks
    .filter((task) => isTaskOpen(task))
    .map((task) => {
      const latestCheckpoint = task.checkpoints[task.checkpoints.length - 1];
      const currentStep = task.steps.find((step) => step.id === task.current_step_id);
      return {
        id: task.id,
        goal: task.goal,
        status: task.status,
        progress: task.progress,
        stepCount: task.steps.length,
        ...(task.current_step_id ? { currentStepId: task.current_step_id } : {}),
        ...(currentStep?.title ? { currentStepTitle: currentStep.title } : {}),
        ...(task.blocked_info?.reason ? { blockedReason: task.blocked_info.reason } : {}),
        ...(task.blocked_info?.question ? { waitingQuestion: task.blocked_info.question } : {}),
        ...(task.blocked_info?.description ? { waitingDescription: task.blocked_info.description } : {}),
        ...(latestCheckpoint?.summary ? { latestCheckpointSummary: latestCheckpoint.summary } : {}),
      };
    });
}

function pickTaskAssignedToSession(tasks: Task[], sessionKey: string): Task | null {
  if (!sessionKey) {
    return null;
  }
  const candidates = tasks
    .filter((task) => isTaskOpen(task) && normalizeSessionKey(task.assigned_session) === sessionKey)
    .sort((left, right) => right.updated_at - left.updated_at);
  return candidates[0] ?? null;
}

function toActiveTaskFact(task: Task): ActiveTaskFact {
  const currentStep = task.steps.find((step) => step.id === task.current_step_id);
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    progress: task.progress,
    ...(task.assigned_session ? { assignedSession: task.assigned_session } : {}),
    ...(task.current_step_id ? { currentStepId: task.current_step_id } : {}),
    ...(currentStep?.title ? { currentStepTitle: currentStep.title } : {}),
    ...(currentStep?.description ? { currentStepDescription: currentStep.description } : {}),
    ...(task.blocked_info?.reason ? { blockedReason: task.blocked_info.reason } : {}),
    ...(task.blocked_info?.question ? { waitingQuestion: task.blocked_info.question } : {}),
    ...(task.blocked_info?.description ? { waitingDescription: task.blocked_info.description } : {}),
    steps: task.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      ...(step.description ? { description: step.description } : {}),
    })),
    checkpointsTail: task.checkpoints.slice(-5).map((checkpoint) => ({
      id: checkpoint.id,
      kind: checkpoint.kind,
      summary: checkpoint.summary,
      createdAt: checkpoint.created_at,
    })),
  };
}

function buildTaskActiveContext(activeTask: ActiveTaskFact): string {
  return [
    "[TASK_ACTIVE_CONTEXT]",
    `activeTask=${JSON.stringify(activeTask)}`,
  ].join("\n");
}

function resolvePromptActiveTask(input: {
  tasks: Task[];
  sessionKey?: string;
  state: SessionTaskState;
}): Task | null {
  const normalizedSessionKey = normalizeSessionKey(input.sessionKey);
  if (normalizedSessionKey) {
    const sessionTask = pickTaskAssignedToSession(input.tasks, normalizedSessionKey);
    if (sessionTask) {
      return sessionTask;
    }
  }
  const activeTaskId = typeof input.state.activeTaskId === "string" ? input.state.activeTaskId.trim() : "";
  if (activeTaskId) {
    return input.tasks.find((task) => task.id === activeTaskId && isTaskOpen(task)) ?? null;
  }
  return null;
}

function isExecutionSession(params: { sessionKey?: string; activeTask: Task | null }): boolean {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  const assignedSession = normalizeSessionKey(params.activeTask?.assigned_session);
  return Boolean(params.activeTask && sessionKey && assignedSession && assignedSession === sessionKey);
}

function syncExecutionSessionState(sessionKey: string | undefined, taskId: string): void {
  const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
  if (!normalizedTaskId) {
    return;
  }
  writeSessionState(
    sessionKey,
    {
      activeTaskId: normalizedTaskId,
      draft: undefined,
    },
    "direct",
  );
}

function buildTaskRuntimeFacts(input: {
  runningTasks: RunningTaskFact[];
}): string {
  return [
    "[TASK_RUNTIME_FACTS]",
    `runningTasks=${JSON.stringify(input.runningTasks)}`,
  ].join("\n");
}

function extractStepInputs(value: unknown): TaskStepInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rows = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const row = item as Record<string, unknown>;
      const title = typeof row.title === "string" ? row.title.trim() : "";
      if (!title) {
        return null;
      }
      const next: TaskStepInput = { title };
      if (typeof row.description === "string" && row.description.trim()) {
        next.description = row.description.trim();
      }
      if (Array.isArray(row.dependsOn)) {
        next.dependsOn = row.dependsOn.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0);
      }
      return next;
    })
    .filter((row): row is TaskStepInput => row !== null);

  return rows.length > 0 ? rows : undefined;
}

function normalizeDecision(value: unknown): TaskDecision | "" {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (["approve", "approved", "accept", "accepted", "yes", "y", "ok", "confirm", "confirmed", "同意", "批准", "确认", "通过", "是"].includes(normalized)) {
    return "approve";
  }
  if (["reject", "rejected", "deny", "denied", "no", "n", "拒绝", "驳回", "否", "不通过"].includes(normalized)) {
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
    if (error.code === "resume_conflict" || error.code === "invalid_transition") {
      return { code: "conflict", message: error.message, statusCode: 409 };
    }
    if (error.code === "invalid_params") {
      return { code: "invalid_params", message: error.message, statusCode: 400 };
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

function buildResumePacket(task: Task): Record<string, unknown> {
  return {
    taskId: task.id,
    goal: task.goal,
    status: task.status,
    currentStepId: task.current_step_id ?? null,
    blockedInfo: task.blocked_info ?? null,
    latestCheckpoint: task.checkpoints[task.checkpoints.length - 1] ?? null,
    checkpoints: task.checkpoints.slice(-5),
    progress: task.progress,
  };
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

async function resumeByStore(
  store: TaskStore,
  input: { taskId: string; confirmId: string; decision?: TaskDecision; userInput?: string; sessionKey?: string },
): Promise<Task> {
  const task = await store.resumeTask({
    taskId: input.taskId,
    confirmId: input.confirmId,
    ...(input.decision ? { decision: input.decision } : {}),
    ...(input.userInput ? { userInput: input.userInput } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  });
  return task;
}

async function publishResumeEvent(store: TaskStore, task: Task, meta: ResumeMeta): Promise<void> {
  publishTaskEvent("task_needs_resume", {
    taskId: task.id,
    confirmId: meta.confirmId,
    resumeReason: meta.resumeReason,
    ...(meta.decision ? { decision: meta.decision } : {}),
    ...(meta.userInput ? { userInput: meta.userInput } : {}),
    resumePacket: buildResumePacket(task),
    task: asTaskPayload(task, store.getWorkspaceDir()),
  });
}

const plugin = {
  id: PLUGIN_ID,
  name: "Task Manager",
  description: "Structured task runtime with checkpoint-based resume.",
  register(api: OpenClawPluginApi) {
    defaultWorkspaceDir = resolveWorkspaceDir((api.config as { workspaceDir?: unknown })?.workspaceDir);

    api.registerTool((toolCtx) => ({
      name: "task_create",
      label: "Task Create",
      description: "创建结构化任务。",
      parameters: createTaskParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const goal = typeof params.goal === "string" ? params.goal.trim() : "";
        const draftId = typeof params.draftId === "string" ? params.draftId.trim() : "";
        const draftVersionRaw = typeof params.draftVersion === "number" ? params.draftVersion : NaN;
        const draftVersion = Number.isFinite(draftVersionRaw) ? Math.floor(draftVersionRaw) : NaN;
        if (!goal) {
          throw new Error("goal is required");
        }
        if (!draftId) {
          throw new Error("draftId is required");
        }
        if (!Number.isFinite(draftVersion) || draftVersion <= 0) {
          throw new Error("draftVersion must be a positive integer");
        }
        const state = readSessionState(toolCtx.sessionKey);
        const draft = state.draft;
        if (!draft) {
          throw new Error("no active draft in current session");
        }
        if (draft.id !== draftId || draft.version !== draftVersion) {
          throw new Error("draft mismatch: stale or invalid draftId/draftVersion");
        }
        if (draft.status === "consumed" && draft.consumedVersion === draftVersion && draft.consumedTaskId) {
          const existingStore = getToolStore(toolCtx);
          const existedTask = await existingStore.getTask(draft.consumedTaskId);
          if (existedTask) {
            const existedPayload = asTaskPayload(existedTask, existingStore.getWorkspaceDir());
            return {
              content: [{ type: "text" as const, text: JSON.stringify(existedPayload, null, 2) }],
              details: existedPayload,
            };
          }
        }
        const approvedForVersion = draft.status === "approved" && draft.approvedVersion === draftVersion;
        const implicitApprovalInSameTurn = draft.status === "pending";
        if (!approvedForVersion && !implicitApprovalInSameTurn) {
          throw new Error("draft is not approved for creation");
        }
        const steps = extractStepInputs(params.steps);
        if (!steps || steps.length === 0) {
          throw new Error("steps is required and must contain at least one step");
        }
        const checkpointSummary = typeof params.checkpointSummary === "string" ? params.checkpointSummary.trim() : "";
        const store = getToolStore(toolCtx);
        const workerSessionKey = buildTaskWorkerSessionKey(toolCtx.sessionKey, randomUUID().slice(0, 12));
        const task = await store.createTask({
          goal,
          steps,
          sessionKey: workerSessionKey,
          ...(checkpointSummary ? { initialCheckpointSummary: checkpointSummary } : {}),
        });

        const payload = asTaskPayload(task, store.getWorkspaceDir());
        writeSessionState(
          toolCtx.sessionKey,
          {
            activeTaskId: task.id,
            draft: {
              ...draft,
              status: "consumed",
              consumedVersion: draftVersion,
              consumedTaskId: task.id,
            },
          },
          "direct",
        );
        bindTaskToAssignedSession(task);
        publishTaskEvent("task_status_changed", {
          taskId: task.id,
          from: null,
          to: task.status,
          task: payload,
        });
        publishTaskEvent("task_progress_update", {
          taskId: task.id,
          progress: task.progress,
          status: task.status,
          task: payload,
        });
        publishTaskEvent("task_needs_resume", {
          taskId: task.id,
          resumeReason: "task_created",
          resumePacket: buildResumePacket(task),
          task: payload,
        });

        const pausePayload = {
          action: "pause_session",
          message: "任务已创建，主会话已暂停。系统将转到任务子会话继续执行。",
          resumeTargetSession: task.assigned_session ?? null,
          task: payload,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(pausePayload, null, 2) }],
          details: pausePayload,
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_block",
      label: "Task Block",
      description: "将任务置为阻塞状态，支持用户输入或审批等待。",
      parameters: taskBlockParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const blockType = typeof params.blockType === "string" ? params.blockType.trim() : "";
        if (!taskId) {
          throw new Error("taskId is required");
        }
        if (blockType !== "user_input" && blockType !== "approval") {
          throw new Error("blockType must be user_input or approval");
        }

        const inputModeRaw = typeof params.inputMode === "string" ? params.inputMode.trim() : "";
        const inputMode = inputModeRaw === "decision" || inputModeRaw === "free_text" ? inputModeRaw : undefined;
        const graceWindowMsRaw = typeof params.graceWindowMs === "number" ? params.graceWindowMs : DEFAULT_GRACE_WINDOW_MS;
        const graceWindowMs = Number.isFinite(graceWindowMsRaw) && graceWindowMsRaw >= 0
          ? Math.floor(graceWindowMsRaw)
          : DEFAULT_GRACE_WINDOW_MS;
        const checkpointSummary = typeof params.checkpointSummary === "string" ? params.checkpointSummary.trim() : "";

        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);

        if (blockType === "user_input") {
          const question = typeof params.question === "string" ? params.question.trim() : "";
          if (!question) {
            throw new Error("question is required when blockType=user_input");
          }
          const task = await store.blockTask({
            taskId,
            blockType: "user_input",
            question,
            ...(inputMode ? { inputMode } : {}),
            graceWindowMs,
            ...(checkpointSummary ? { checkpointSummary } : {}),
          });
          await publishStatusChange(store, before, task, "need_user_input");

          publishTaskEvent("task_blocked", {
            taskId: task.id,
            type: "waiting_for_input",
            confirmId: task.blocked_info?.confirm_id,
            inputMode: task.blocked_info?.input_mode,
            question,
            graceUntil: task.blocked_info?.grace_until,
            task: asTaskPayload(task, store.getWorkspaceDir()),
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                action: "pause_session",
                message: "任务已挂起，等待用户输入。",
                confirmId: task.blocked_info?.confirm_id,
                inputMode: task.blocked_info?.input_mode,
                graceUntil: task.blocked_info?.grace_until,
                task: asTaskPayload(task, store.getWorkspaceDir()),
              }, null, 2),
            }],
            details: {
              action: "pause_session",
              confirmId: task.blocked_info?.confirm_id,
              inputMode: task.blocked_info?.input_mode,
              graceUntil: task.blocked_info?.grace_until,
              task: asTaskPayload(task, store.getWorkspaceDir()),
            },
          };
        }

        const description = typeof params.description === "string" ? params.description.trim() : "";
        if (!description) {
          throw new Error("description is required when blockType=approval");
        }
        const ttlSecRaw = typeof params.ttlSec === "number" ? params.ttlSec : DEFAULT_WEBHOOK_TTL_SECONDS;
        const ttlSec = Number.isFinite(ttlSecRaw) && ttlSecRaw > 0 ? Math.floor(ttlSecRaw) : DEFAULT_WEBHOOK_TTL_SECONDS;
        const webhookToken = randomUUID().replace(/-/g, "");
        const expiresAt = Date.now() + ttlSec * 1000;

        const task = await store.blockTask({
          taskId,
          blockType: "approval",
          description,
          webhookToken,
          expiresAt,
          graceWindowMs,
          ...(checkpointSummary ? { checkpointSummary } : {}),
        });
        await publishStatusChange(store, before, task, "waiting_approval");

        const port = resolveGatewayPort(api);
        const webhookUrl = `http://127.0.0.1:${port}/task-manager/webhook?token=${encodeURIComponent(webhookToken)}&taskId=${encodeURIComponent(task.id)}&workspace=${encodeURIComponent(store.getWorkspaceDir())}`;

        publishTaskEvent("task_blocked", {
          taskId: task.id,
          type: "waiting_approval",
          confirmId: task.blocked_info?.confirm_id,
          description,
          webhookToken,
          expiresAt,
          graceUntil: task.blocked_info?.grace_until,
          task: asTaskPayload(task, store.getWorkspaceDir()),
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              action: "pause_session",
              webhookUrl,
              expiresAt,
              confirmId: task.blocked_info?.confirm_id,
              graceUntil: task.blocked_info?.grace_until,
              task: asTaskPayload(task, store.getWorkspaceDir()),
            }, null, 2),
          }],
          details: {
            action: "pause_session",
            webhookUrl,
            expiresAt,
            confirmId: task.blocked_info?.confirm_id,
            graceUntil: task.blocked_info?.grace_until,
            task: asTaskPayload(task, store.getWorkspaceDir()),
          },
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_resume",
      label: "Task Resume",
      description: "恢复阻塞任务。",
      parameters: taskResumeParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const confirmId = typeof params.confirmId === "string" ? params.confirmId.trim() : "";
        const userInput = typeof params.userInput === "string" ? params.userInput.trim() : "";
        const decisionRaw = typeof params.decision === "string" ? params.decision.trim() : "";
        const decision = normalizeDecision(decisionRaw);

        if (!taskId || !confirmId) {
          throw new Error("taskId and confirmId are required");
        }
        if (decisionRaw && !decision) {
          throw new Error("decision is invalid");
        }

        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);
        const task = await resumeByStore(store, {
          taskId,
          confirmId,
          ...(decision ? { decision } : {}),
          ...(userInput ? { userInput } : {}),
          ...(toolCtx.sessionKey ? { sessionKey: toolCtx.sessionKey } : {}),
        });
        bindTaskToAssignedSession(task);
        await publishStatusChange(store, before, task, "resumed");
        await publishResumeEvent(store, task, {
          confirmId,
          ...(decision ? { decision } : {}),
          ...(userInput ? { userInput } : {}),
          resumeReason: "tool_resume",
        });

        const payload = asTaskPayload(task, store.getWorkspaceDir());
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: {
            ...payload,
            resumePacket: buildResumePacket(task),
          },
        };
      },
    }));

    api.registerTool((toolCtx) => ({
      name: "task_finish",
      label: "Task Finish",
      description: "将任务收口为完成或失败。",
      parameters: taskFinishParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const status = typeof params.status === "string" ? params.status.trim() : "";
        const resultSummary = typeof params.resultSummary === "string" ? params.resultSummary.trim() : "";
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        const checkpointSummary = typeof params.checkpointSummary === "string" ? params.checkpointSummary.trim() : "";

        if (!taskId) {
          throw new Error("taskId is required");
        }
        if (status !== "completed" && status !== "failed") {
          throw new Error("status must be completed or failed");
        }
        if (status === "failed" && !reason) {
          throw new Error("reason is required when status=failed");
        }

        const store = getToolStore(toolCtx);
        const before = await store.getTask(taskId);
        const task = await store.finishTask({
          taskId,
          status,
          ...(resultSummary ? { resultSummary } : {}),
          ...(reason ? { reason } : {}),
          ...(checkpointSummary ? { checkpointSummary } : {}),
        });
        await publishStatusChange(store, before, task, "finished");
        clearTaskFromActiveSessions(task.id);

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
      name: "task_delete",
      label: "Task Delete",
      description: "删除任务（用于清理失效或历史任务）。",
      parameters: taskDeleteParameters,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!taskId) {
          throw new Error("taskId is required");
        }
        const store = getToolStore(toolCtx);
        const deletedTask = await store.deleteTask({ taskId });
        clearDeletedTaskFromSessionStates(deletedTask.id);
        const payload = asTaskPayload(deletedTask, store.getWorkspaceDir());
        publishTaskEvent("task_deleted", {
          taskId: deletedTask.id,
          ...(reason ? { reason } : {}),
          task: payload,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              deleted: true,
              taskId: deletedTask.id,
              ...(reason ? { reason } : {}),
            }, null, 2),
          }],
          details: {
            deleted: true,
            taskId: deletedTask.id,
            ...(reason ? { reason } : {}),
          },
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
      const decision = normalizeDecision(decisionParam);

      if (!taskId) {
        options.respond(false, undefined, { code: "invalid_params", message: "taskId is required" });
        return;
      }
      if (!confirmId) {
        options.respond(false, undefined, { code: "invalid_params", message: "confirmId is required" });
        return;
      }
      if (decisionParam && !decision) {
        options.respond(false, undefined, { code: "invalid_params", message: "decision is invalid" });
        return;
      }

      const store = resolveStore(workspaceDir);
      try {
        const before = await store.getTask(taskId);
        const task = await resumeByStore(store, {
          taskId,
          confirmId,
          ...(decision ? { decision } : {}),
          ...(userInput ? { userInput } : {}),
        });
        bindTaskToAssignedSession(task);
        await publishStatusChange(store, before, task, "resumed");
        await publishResumeEvent(store, task, {
          confirmId,
          ...(decision ? { decision } : {}),
          ...(userInput ? { userInput } : {}),
          resumeReason: decision || userInput ? "user_input" : "manual_resume",
        });

        options.respond(true, {
          task,
          resumePacket: buildResumePacket(task),
        });
      } catch (error) {
        const mapped = mapTaskStoreError(error);
        options.respond(false, undefined, {
          code: mapped.code,
          message: mapped.message,
        });
      }
    });

    api.registerGatewayMethod("task_delete", async (options: GatewayRequestHandlerOptions) => {
      updateEventPublisher(options);
      const workspaceDir = resolveWorkspaceDir(options.params.workspaceDir);
      const taskId = typeof options.params.taskId === "string" ? options.params.taskId.trim() : "";
      const reason = typeof options.params.reason === "string" ? options.params.reason.trim() : "";
      if (!taskId) {
        options.respond(false, undefined, { code: "invalid_params", message: "taskId is required" });
        return;
      }
      const store = resolveStore(workspaceDir);
      try {
        const deletedTask = await store.deleteTask({ taskId });
        clearDeletedTaskFromSessionStates(deletedTask.id);
        const payload = asTaskPayload(deletedTask, store.getWorkspaceDir());
        publishTaskEvent("task_deleted", {
          taskId: deletedTask.id,
          ...(reason ? { reason } : {}),
          task: payload,
        });
        options.respond(true, {
          deleted: true,
          taskId: deletedTask.id,
          ...(reason ? { reason } : {}),
        });
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

          const confirmId = matched.blocked_info?.confirm_id?.trim() ?? "";
          if (!confirmId) {
            jsonResponse(res, 409, { success: false, error: "missing confirmId in blocked state" });
            return;
          }

          const before = await store.getTask(taskId);
          const task = await resumeByStore(store, {
            taskId,
            confirmId,
            decision: "approve",
          });
          bindTaskToAssignedSession(task);
          await publishStatusChange(store, before, task, "approval_webhook");
          await publishResumeEvent(store, task, {
            confirmId,
            decision: "approve",
            resumeReason: "approval_webhook",
          });

          jsonResponse(res, 200, {
            success: true,
            taskId: task.id,
            resumePacket: buildResumePacket(task),
          });
        } catch (error) {
          const mapped = mapTaskStoreError(error);
          jsonResponse(res, mapped.statusCode, {
            success: false,
            error: mapped.message,
          });
        }
      },
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      const state = readSessionState(ctx?.sessionKey);
      const workspaceDir = resolveWorkspaceDir(ctx?.workspaceDir);
      const store = resolveStore(workspaceDir);
      const tasks = await store.listTasks();
      const activeTask = resolvePromptActiveTask({
        tasks,
        sessionKey: ctx?.sessionKey,
        state,
      });
      const useExecutionProtocol = isExecutionSession({
        sessionKey: ctx?.sessionKey,
        activeTask,
      });
      if (useExecutionProtocol && activeTask) {
        syncExecutionSessionState(ctx?.sessionKey, activeTask.id);
        return {
          prependSystemContext: `${TASK_EXECUTION_PROTOCOL}\n\n${buildTaskActiveContext(toActiveTaskFact(activeTask))}`,
        };
      }
      if (state.mode === "task_draft") {
        return { prependSystemContext: buildPromptContextByState(state) };
      }

      const runningTasks = toRunningTaskFacts(tasks);
      const runtimeFacts = buildTaskRuntimeFacts({ runningTasks });

      return {
        prependSystemContext: `${buildPromptContextByState(state)}\n\n${runtimeFacts}`,
      };
    });

    api.on("llm_output", async (event, ctx) => {
      const joined = Array.isArray(event.assistantTexts) ? event.assistantTexts.join("\n\n") : "";
      if (!joined.trim()) {
        return;
      }
      const state = readSessionState(ctx.sessionKey);
      const workspaceDir = resolveWorkspaceDir(ctx?.workspaceDir);
      const store = resolveStore(workspaceDir);
      const tasks = await store.listTasks();
      const activeTask = resolvePromptActiveTask({
        tasks,
        sessionKey: ctx?.sessionKey,
        state,
      });
      if (activeTask && isExecutionSession({ sessionKey: ctx?.sessionKey, activeTask })) {
        syncExecutionSessionState(ctx?.sessionKey, activeTask.id);
        return;
      }
      if (state.mode === "task_draft") {
        const draftDecision = parseDraftDecision(joined);
        if (draftDecision) {
          applyDraftDecision(ctx.sessionKey, draftDecision);
        }
        return;
      }
      const routerDecision = parseRouterDecision(joined);
      if (routerDecision) {
        applyRouterDecision(ctx.sessionKey, routerDecision);
      }
    });

    api.on("before_message_write", (event, ctx) => {
      if (ctx?.sessionKey) {
        readSessionState(ctx.sessionKey);
      }
      const sanitized = sanitizeAssistantMessageBeforeWrite(event.message);
      if (!sanitized.changed) {
        return undefined;
      }
      if (sanitized.empty) {
        return { block: true };
      }
      return { message: sanitized.message as typeof event.message };
    });

    api.on("message_sending", (event, ctx) => {
      const content = typeof event.content === "string" ? event.content : "";
      if (!content.trim()) {
        return undefined;
      }
      const now = Date.now();
      cleanupMessageSendingDecisionState(now);
      const stateKey = buildMessageSendingDecisionStateKey({ event, ctx });
      const previousState = messageSendingDecisionState.get(stateKey);
      const stripped = stripDecisionArtifactsFromStreamingText({
        text: content,
        inDecisionBlock: previousState?.inDecisionBlock === true,
      });
      if (stripped.inDecisionBlock) {
        messageSendingDecisionState.set(stateKey, { inDecisionBlock: true, updatedAt: now });
      } else {
        messageSendingDecisionState.delete(stateKey);
      }
      if (!stripped.changed) {
        return undefined;
      }
      if (!stripped.text.trim()) {
        return { cancel: true };
      }
      return { content: stripped.text };
    });
  },
};

export default plugin;

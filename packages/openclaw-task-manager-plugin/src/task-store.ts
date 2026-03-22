import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_input"
  | "waiting_approval"
  | "completed"
  | "failed";

export type TaskStepStatus = "pending" | "running" | "blocked" | "completed" | "failed";

export type TaskCheckpointKind = "checkpoint" | "block" | "resume" | "finish";

export interface TaskStep {
  id: string;
  title: string;
  description?: string;
  depends_on: string[];
  status: TaskStepStatus;
  created_at: number;
  updated_at: number;
  started_at?: number;
  finished_at?: number;
}

export interface TaskCheckpoint {
  id: string;
  kind: TaskCheckpointKind;
  summary: string;
  created_at: number;
  payload?: Record<string, unknown>;
}

export interface TaskBlockedInfo {
  reason: "need_user_confirm" | "waiting_external_approval";
  confirm_id: string;
  grace_until: number;
  input_mode?: "decision" | "free_text";
  question?: string;
  description?: string;
  webhook_token?: string;
  expires_at?: number;
}

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  progress: number;
  steps: TaskStep[];
  current_step_id?: string;
  checkpoints: TaskCheckpoint[];
  assigned_session?: string;
  blocked_info?: TaskBlockedInfo;
  result_summary?: string;
  failure_reason?: string;
  finished_at?: number;
  created_at: number;
  updated_at: number;
}

export interface TaskStepInput {
  title: string;
  description?: string;
  dependsOn?: string[];
}

export type TaskStoreErrorCode =
  | "task_not_found"
  | "resume_conflict"
  | "invalid_confirm_id"
  | "invalid_transition"
  | "invalid_params";

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface TaskFileV2 {
  schema_version: 2;
  tasks: Task[];
}

const SCHEMA_VERSION = 2;
const DEFAULT_GRACE_WINDOW_MS = 120_000;
const MAX_CHECKPOINTS = 80;

const LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 8,
    factor: 1.6,
    minTimeout: 15,
    maxTimeout: 300,
    randomize: true,
  },
  stale: 30_000,
};

function createEmptyTaskFile(): TaskFileV2 {
  return {
    schema_version: 2,
    tasks: [],
  };
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowTs(): number {
  return Date.now();
}

function createTaskId(): string {
  return `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function createStepId(): string {
  return `step-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function createCheckpointId(): string {
  return `cp-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function createConfirmId(): string {
  return `confirm-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending"
    || value === "running"
    || value === "waiting_for_input"
    || value === "waiting_approval"
    || value === "completed"
    || value === "failed";
}

function isStepStatus(value: unknown): value is TaskStepStatus {
  return value === "pending"
    || value === "running"
    || value === "blocked"
    || value === "completed"
    || value === "failed";
}

function normalizeDependsOn(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeStep(raw: unknown): TaskStep | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!id || !title) {
    return null;
  }
  const createdAt = typeof raw.created_at === "number" && Number.isFinite(raw.created_at) ? raw.created_at : nowTs();
  const updatedAt = typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at) ? raw.updated_at : createdAt;
  const status: TaskStepStatus = isStepStatus(raw.status) ? raw.status : "pending";
  const step: TaskStep = {
    id,
    title,
    status,
    depends_on: normalizeDependsOn(raw.depends_on),
    created_at: createdAt,
    updated_at: updatedAt,
  };
  if (typeof raw.description === "string" && raw.description.trim()) {
    step.description = raw.description.trim();
  }
  if (typeof raw.started_at === "number" && Number.isFinite(raw.started_at)) {
    step.started_at = raw.started_at;
  }
  if (typeof raw.finished_at === "number" && Number.isFinite(raw.finished_at)) {
    step.finished_at = raw.finished_at;
  }
  return step;
}

function normalizeCheckpoint(raw: unknown): TaskCheckpoint | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const kindValue = raw.kind;
  const kind: TaskCheckpointKind = kindValue === "block" || kindValue === "resume" || kindValue === "finish"
    ? kindValue
    : "checkpoint";
  const createdAt = typeof raw.created_at === "number" && Number.isFinite(raw.created_at) ? raw.created_at : nowTs();
  if (!id || !summary) {
    return null;
  }
  const checkpoint: TaskCheckpoint = {
    id,
    kind,
    summary,
    created_at: createdAt,
  };
  if (isObject(raw.payload)) {
    checkpoint.payload = raw.payload;
  }
  return checkpoint;
}

function deriveProgress(task: Pick<Task, "status" | "steps">): number {
  if (task.status === "completed") {
    return 1;
  }
  if (task.steps.length === 0) {
    return 0;
  }
  const completed = task.steps.filter((step) => step.status === "completed").length;
  return normalizeProgress(completed / task.steps.length);
}

function sanitizeTask(raw: unknown): Task | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (!id || !goal) {
    return null;
  }

  const createdAt = typeof raw.created_at === "number" && Number.isFinite(raw.created_at) ? raw.created_at : nowTs();
  const updatedAt = typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at) ? raw.updated_at : createdAt;
  const status: TaskStatus = isTaskStatus(raw.status) ? raw.status : "pending";
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((step) => normalizeStep(step)).filter((step): step is TaskStep => step !== null)
    : [];
  const checkpoints = Array.isArray(raw.checkpoints)
    ? raw.checkpoints.map((cp) => normalizeCheckpoint(cp)).filter((cp): cp is TaskCheckpoint => cp !== null)
    : [];

  const task: Task = {
    id,
    goal,
    status,
    progress: normalizeProgress(typeof raw.progress === "number" ? raw.progress : deriveProgress({ status, steps })),
    steps,
    checkpoints,
    created_at: createdAt,
    updated_at: updatedAt,
  };

  if (typeof raw.current_step_id === "string" && raw.current_step_id.trim()) {
    task.current_step_id = raw.current_step_id.trim();
  }
  if (typeof raw.assigned_session === "string" && raw.assigned_session.trim()) {
    task.assigned_session = raw.assigned_session.trim();
  }
  if (typeof raw.result_summary === "string" && raw.result_summary.trim()) {
    task.result_summary = raw.result_summary.trim();
  }
  if (typeof raw.failure_reason === "string" && raw.failure_reason.trim()) {
    task.failure_reason = raw.failure_reason.trim();
  }
  if (typeof raw.finished_at === "number" && Number.isFinite(raw.finished_at)) {
    task.finished_at = raw.finished_at;
  }

  const blockedInfo = isObject(raw.blocked_info) ? raw.blocked_info : undefined;
  const blockedReason =
    blockedInfo?.reason === "need_user_confirm" || blockedInfo?.reason === "waiting_external_approval"
      ? blockedInfo.reason
      : undefined;
  const confirmId = typeof blockedInfo?.confirm_id === "string" ? blockedInfo.confirm_id.trim() : "";
  const graceUntil = typeof blockedInfo?.grace_until === "number" && Number.isFinite(blockedInfo.grace_until)
    ? blockedInfo.grace_until
    : undefined;
  if (blockedReason && confirmId && graceUntil) {
    task.blocked_info = {
      reason: blockedReason,
      confirm_id: confirmId,
      grace_until: graceUntil,
      ...(blockedInfo?.input_mode === "decision" || blockedInfo?.input_mode === "free_text"
        ? { input_mode: blockedInfo.input_mode }
        : {}),
      ...(typeof blockedInfo?.question === "string" ? { question: blockedInfo.question } : {}),
      ...(typeof blockedInfo?.description === "string" ? { description: blockedInfo.description } : {}),
      ...(typeof blockedInfo?.webhook_token === "string" ? { webhook_token: blockedInfo.webhook_token } : {}),
      ...(typeof blockedInfo?.expires_at === "number" ? { expires_at: blockedInfo.expires_at } : {}),
    };
  }

  task.progress = deriveProgress(task);
  return task;
}

function normalizeStepInputs(inputs: TaskStepInput[] | undefined, ts: number): TaskStep[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return [];
  }
  return inputs
    .map((step) => {
      const title = typeof step.title === "string" ? step.title.trim() : "";
      if (!title) {
        return null;
      }
      const row: TaskStep = {
        id: createStepId(),
        title,
        status: "pending",
        depends_on: normalizeDependsOn(step.dependsOn),
        created_at: ts,
        updated_at: ts,
      };
      if (typeof step.description === "string" && step.description.trim()) {
        row.description = step.description.trim();
      }
      return row;
    })
    .filter((step): step is TaskStep => step !== null);
}

function appendCheckpoint(
  task: Task,
  checkpoint: Omit<TaskCheckpoint, "id" | "created_at"> & { payload?: Record<string, unknown> },
  ts: number,
): TaskCheckpoint {
  const created: TaskCheckpoint = {
    id: createCheckpointId(),
    kind: checkpoint.kind,
    summary: checkpoint.summary.trim(),
    created_at: ts,
    ...(checkpoint.payload ? { payload: checkpoint.payload } : {}),
  };
  task.checkpoints.push(created);
  if (task.checkpoints.length > MAX_CHECKPOINTS) {
    task.checkpoints.splice(0, task.checkpoints.length - MAX_CHECKPOINTS);
  }
  return created;
}

function getCurrentStep(task: Task): TaskStep | undefined {
  if (!task.current_step_id) {
    return undefined;
  }
  return task.steps.find((step) => step.id === task.current_step_id);
}

function setTaskUpdated(task: Task, ts: number): void {
  task.updated_at = ts;
  task.progress = deriveProgress(task);
}

export class TaskStore {
  private readonly workspaceDir: string;
  private readonly rootDir: string;
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.rootDir = path.join(this.workspaceDir, ".task-manager");
    this.filePath = path.join(this.rootDir, "tasks.json");
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  getFilePath(): string {
    return this.filePath;
  }

  async listTasks(): Promise<Task[]> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      return [...fileData.tasks].sort((a, b) => b.created_at - a.created_at);
    });
  }

  async getTask(taskId: string): Promise<Task | null> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      return fileData.tasks.find((task) => task.id === taskId) ?? null;
    });
  }

  async createTask(input: {
    goal: string;
    steps?: TaskStepInput[];
    sessionKey?: string;
    initialCheckpointSummary?: string;
  }): Promise<Task> {
    return this.mutate((fileData) => {
      const ts = nowTs();
      const steps = normalizeStepInputs(input.steps, ts);
      if (steps.length > 0) {
        steps[0].status = "running";
        steps[0].started_at = ts;
      }
      const task: Task = {
        id: createTaskId(),
        goal: input.goal.trim(),
        status: "running",
        progress: 0,
        steps,
        current_step_id: steps[0]?.id,
        checkpoints: [],
        created_at: ts,
        updated_at: ts,
      };
      if (input.sessionKey?.trim()) {
        task.assigned_session = input.sessionKey.trim();
      }
      appendCheckpoint(task, {
        kind: "checkpoint",
        summary: input.initialCheckpointSummary?.trim() || "任务已创建，等待执行。",
      }, ts);
      setTaskUpdated(task, ts);
      fileData.tasks.unshift(task);
      return task;
    });
  }

  async blockTask(input: {
    taskId: string;
    blockType: "user_input" | "approval";
    question?: string;
    description?: string;
    inputMode?: "decision" | "free_text";
    webhookToken?: string;
    expiresAt?: number;
    graceWindowMs?: number;
    checkpointSummary?: string;
  }): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, input.taskId);
      if (task.status === "completed" || task.status === "failed") {
        throw new TaskStoreError("invalid_transition", `Task already finished: ${task.status}`);
      }

      const ts = nowTs();
      const graceWindowMs = typeof input.graceWindowMs === "number" && Number.isFinite(input.graceWindowMs)
        ? Math.max(0, Math.floor(input.graceWindowMs))
        : DEFAULT_GRACE_WINDOW_MS;
      const graceUntil = ts + graceWindowMs;
      const currentStep = getCurrentStep(task);
      if (currentStep && currentStep.status === "running") {
        currentStep.status = "blocked";
        currentStep.updated_at = ts;
      }

      if (input.blockType === "user_input") {
        const question = input.question?.trim() ?? "";
        if (!question) {
          throw new TaskStoreError("invalid_params", "question is required for user_input block");
        }
        task.status = "waiting_for_input";
        task.blocked_info = {
          reason: "need_user_confirm",
          confirm_id: createConfirmId(),
          grace_until: graceUntil,
          ...(input.inputMode ? { input_mode: input.inputMode } : {}),
          question,
        };
      } else {
        const description = input.description?.trim() ?? "";
        if (!description) {
          throw new TaskStoreError("invalid_params", "description is required for approval block");
        }
        if (!input.webhookToken || typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt)) {
          throw new TaskStoreError("invalid_params", "approval block requires webhookToken and expiresAt");
        }
        task.status = "waiting_approval";
        task.blocked_info = {
          reason: "waiting_external_approval",
          confirm_id: createConfirmId(),
          grace_until: graceUntil,
          description,
          webhook_token: input.webhookToken,
          expires_at: input.expiresAt,
        };
      }

      appendCheckpoint(task, {
        kind: "block",
        summary: input.checkpointSummary?.trim() || "任务进入阻塞状态，已写入检查点。",
        payload: {
          blockType: input.blockType,
          graceUntil,
        },
      }, ts);
      setTaskUpdated(task, ts);
      return task;
    });
  }

  async resumeTask(input: {
    taskId: string;
    confirmId: string;
    decision?: "approve" | "reject";
    userInput?: string;
    sessionKey?: string;
  }): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, input.taskId);
      const isWaiting = task.status === "waiting_for_input" || task.status === "waiting_approval";
      if (!isWaiting) {
        throw new TaskStoreError("resume_conflict", `Task is not waiting for resume: ${task.status}`);
      }
      const expectedConfirmId = task.blocked_info?.confirm_id?.trim() ?? "";
      const providedConfirmId = input.confirmId.trim();
      if (!providedConfirmId) {
        throw new TaskStoreError("invalid_confirm_id", "confirmId is required");
      }
      if (!expectedConfirmId || providedConfirmId !== expectedConfirmId) {
        throw new TaskStoreError("invalid_confirm_id", "confirmId does not match current blocked state");
      }

      const ts = nowTs();
      task.blocked_info = undefined;
      task.status = "running";
      if (input.sessionKey?.trim()) {
        task.assigned_session = input.sessionKey.trim();
      }

      const currentStep = getCurrentStep(task);
      if (currentStep && currentStep.status === "blocked") {
        currentStep.status = "running";
        currentStep.updated_at = ts;
      }

      appendCheckpoint(task, {
        kind: "resume",
        summary: "任务已恢复执行。",
        payload: {
          ...(input.decision ? { decision: input.decision } : {}),
          ...(input.userInput?.trim() ? { userInput: input.userInput.trim() } : {}),
        },
      }, ts);
      setTaskUpdated(task, ts);
      return task;
    });
  }

  async finishTask(input: {
    taskId: string;
    status: "completed" | "failed";
    resultSummary?: string;
    reason?: string;
    checkpointSummary?: string;
  }): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, input.taskId);
      const ts = nowTs();

      if (task.status === input.status && task.finished_at) {
        return task;
      }
      if (task.status === "completed" || task.status === "failed") {
        throw new TaskStoreError("invalid_transition", `Task already finished: ${task.status}`);
      }

      task.status = input.status;
      task.blocked_info = undefined;
      task.finished_at = ts;
      task.current_step_id = undefined;

      for (const step of task.steps) {
        if (input.status === "completed") {
          if (step.status !== "completed") {
            step.status = "completed";
            step.finished_at = ts;
            step.updated_at = ts;
          }
        } else if (step.status === "running" || step.status === "blocked") {
          step.status = "failed";
          step.finished_at = ts;
          step.updated_at = ts;
        }
      }

      if (input.resultSummary?.trim()) {
        task.result_summary = input.resultSummary.trim();
      }
      if (input.status === "failed") {
        task.failure_reason = input.reason?.trim() || "任务执行失败";
      } else {
        task.failure_reason = undefined;
      }

      appendCheckpoint(task, {
        kind: "finish",
        summary: input.checkpointSummary?.trim() || (input.status === "completed" ? "任务已完成。" : "任务已失败并结束。"),
        payload: {
          status: input.status,
          ...(task.result_summary ? { resultSummary: task.result_summary } : {}),
          ...(task.failure_reason ? { reason: task.failure_reason } : {}),
        },
      }, ts);

      setTaskUpdated(task, ts);
      if (input.status === "completed") {
        task.progress = 1;
      }
      return task;
    });
  }

  async deleteTask(input: {
    taskId: string;
  }): Promise<Task> {
    return this.mutate((fileData) => {
      const index = fileData.tasks.findIndex((row) => row.id === input.taskId);
      if (index < 0) {
        throw new TaskStoreError("task_not_found", `Task not found: ${input.taskId}`);
      }
      const [deleted] = fileData.tasks.splice(index, 1);
      return deleted;
    });
  }

  async findApprovalTaskByToken(token: string): Promise<Task | null> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      const ts = nowTs();
      const task = fileData.tasks.find((row) => {
        const blocked = row.blocked_info;
        if (!blocked || blocked.reason !== "waiting_external_approval") {
          return false;
        }
        if (blocked.webhook_token !== token) {
          return false;
        }
        if (typeof blocked.expires_at === "number" && blocked.expires_at < ts) {
          return false;
        }
        return true;
      });
      return task ?? null;
    });
  }

  async listRunningTasks(): Promise<Task[]> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      return fileData.tasks.filter((task) => task.status === "running");
    });
  }

  async listWaitingTasks(): Promise<Task[]> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      return fileData.tasks.filter((task) => task.status === "waiting_for_input" || task.status === "waiting_approval");
    });
  }

  private async mutate<T>(updater: (fileData: TaskFileV2) => Promise<T> | T): Promise<T> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      const result = await updater(fileData);
      await this.writeAtomically(fileData);
      return result;
    });
  }

  private requireTask(fileData: TaskFileV2, taskId: string): Task {
    const task = fileData.tasks.find((row) => row.id === taskId);
    if (!task) {
      throw new TaskStoreError("task_not_found", `Task not found: ${taskId}`);
    }
    return task;
  }

  private async readOrRepair(): Promise<TaskFileV2> {
    await mkdir(this.rootDir, { recursive: true });
    const exists = await this.fileExists(this.filePath);
    if (!exists) {
      const empty = createEmptyTaskFile();
      await this.writeAtomically(empty);
      return empty;
    }

    let rawText = "";
    try {
      rawText = await readFile(this.filePath, "utf-8");
    } catch {
      await this.backupThenReset(rawText);
      return createEmptyTaskFile();
    }

    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      if (parsed?.schema_version !== SCHEMA_VERSION || !Array.isArray(parsed?.tasks)) {
        await this.backupThenReset(rawText);
        return createEmptyTaskFile();
      }
      const sanitizedTasks = parsed.tasks
        .map((row) => sanitizeTask(row))
        .filter((row): row is Task => row !== null);
      return {
        schema_version: SCHEMA_VERSION,
        tasks: sanitizedTasks,
      };
    } catch {
      await this.backupThenReset(rawText);
      return createEmptyTaskFile();
    }
  }

  private async backupThenReset(rawText: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.rootDir, `tasks.bak.${stamp}.json`);
    if (rawText) {
      await writeFile(backupPath, rawText, "utf-8");
    } else if (await this.fileExists(this.filePath)) {
      await copyFile(this.filePath, backupPath);
    }
    await this.writeAtomically(createEmptyTaskFile());
  }

  private async writeAtomically(fileData: TaskFileV2): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = JSON.stringify(fileData, null, 2);
    await writeFile(tempPath, payload, "utf-8");
    await rename(tempPath, this.filePath);
    await rm(tempPath, { force: true });
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk";
import { calculateMarkdownProgress } from "./progress-parser.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_input"
  | "waiting_approval"
  | "completed"
  | "failed";

export interface TaskBlockedInfo {
  reason: "need_user_confirm" | "waiting_external_approval";
  confirm_id?: string;
  input_mode?: "decision" | "free_text";
  question?: string;
  description?: string;
  webhook_token?: string;
  expires_at?: number;
}

export type TaskStoreErrorCode =
  | "task_not_found"
  | "resume_conflict"
  | "invalid_confirm_id";

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  progress: number;
  plan_markdown: string;
  assigned_session?: string;
  blocked_info?: TaskBlockedInfo;
  created_at: number;
  updated_at: number;
}

interface TaskFileV1 {
  schema_version: 1;
  tasks: Task[];
}

const SCHEMA_VERSION = 1;
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

function createEmptyTaskFile(): TaskFileV1 {
  return {
    schema_version: 1,
    tasks: [],
  };
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function createConfirmId(): string {
  return `confirm-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTask(raw: unknown): Task | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const goal = typeof raw.goal === "string" ? raw.goal : "";
  const planMarkdown = typeof raw.plan_markdown === "string" ? raw.plan_markdown : "";
  const createdAt = typeof raw.created_at === "number" ? raw.created_at : Date.now();
  const updatedAt = typeof raw.updated_at === "number" ? raw.updated_at : Date.now();
  const status = typeof raw.status === "string" ? raw.status : "pending";
  if (!id || !goal) {
    return null;
  }

  const normalizedStatus: TaskStatus = (
    [
      "pending",
      "running",
      "waiting_for_input",
      "waiting_approval",
      "completed",
      "failed",
    ] as TaskStatus[]
  ).includes(status as TaskStatus)
    ? (status as TaskStatus)
    : "pending";

  const blockedInfo = isObject(raw.blocked_info) ? raw.blocked_info : undefined;
  const blockedReason =
    blockedInfo?.reason === "need_user_confirm" || blockedInfo?.reason === "waiting_external_approval"
      ? blockedInfo.reason
      : undefined;

  const task: Task = {
    id,
    goal,
    status: normalizedStatus,
    progress: normalizeProgress(typeof raw.progress === "number" ? raw.progress : 0),
    plan_markdown: planMarkdown,
    created_at: createdAt,
    updated_at: updatedAt,
  };

  if (typeof raw.assigned_session === "string" && raw.assigned_session.trim()) {
    task.assigned_session = raw.assigned_session.trim();
  }

  if (blockedReason) {
    task.blocked_info = {
      reason: blockedReason,
      ...(typeof blockedInfo?.confirm_id === "string" ? { confirm_id: blockedInfo.confirm_id } : {}),
      ...(blockedInfo?.input_mode === "decision" || blockedInfo?.input_mode === "free_text"
        ? { input_mode: blockedInfo.input_mode }
        : {}),
      ...(typeof blockedInfo?.question === "string" ? { question: blockedInfo.question } : {}),
      ...(typeof blockedInfo?.description === "string" ? { description: blockedInfo.description } : {}),
      ...(typeof blockedInfo?.webhook_token === "string" ? { webhook_token: blockedInfo.webhook_token } : {}),
      ...(typeof blockedInfo?.expires_at === "number" ? { expires_at: blockedInfo.expires_at } : {}),
    };
  }

  return task;
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

  async createTask(goal: string): Promise<Task> {
    return this.mutate((fileData) => {
      const now = Date.now();
      const task: Task = {
        id: `task-${now}-${randomUUID().slice(0, 8)}`,
        goal,
        status: "pending",
        progress: 0,
        plan_markdown: "",
        created_at: now,
        updated_at: now,
      };
      fileData.tasks.unshift(task);
      return task;
    });
  }

  async setPlanMarkdown(taskId: string, markdown: string): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, taskId);
      const progressResult = calculateMarkdownProgress(markdown);
      task.plan_markdown = markdown;
      task.progress = normalizeProgress(progressResult.progress);
      task.updated_at = Date.now();

      if (task.progress >= 1) {
        task.status = "completed";
        task.blocked_info = undefined;
      } else if (task.status !== "failed") {
        task.status = "running";
      }

      return task;
    });
  }

  async bindSession(taskId: string, sessionKey: string): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, taskId);
      task.assigned_session = sessionKey;
      task.status = task.status === "completed" ? "completed" : "running";
      task.updated_at = Date.now();
      return task;
    });
  }

  async blockForUserInput(taskId: string, question: string, inputMode?: "decision" | "free_text"): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, taskId);
      task.status = "waiting_for_input";
      task.blocked_info = {
        reason: "need_user_confirm",
        confirm_id: createConfirmId(),
        ...(inputMode ? { input_mode: inputMode } : {}),
        question,
      };
      task.updated_at = Date.now();
      return task;
    });
  }

  async blockForApproval(
    taskId: string,
    description: string,
    webhookToken: string,
    expiresAt: number,
  ): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, taskId);
      task.status = "waiting_approval";
      task.blocked_info = {
        reason: "waiting_external_approval",
        confirm_id: createConfirmId(),
        description,
        webhook_token: webhookToken,
        expires_at: expiresAt,
      };
      task.updated_at = Date.now();
      return task;
    });
  }

  async resumeTask(taskId: string, input?: { confirmId?: string }): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, taskId);
      const isWaiting = task.status === "waiting_for_input" || task.status === "waiting_approval";
      if (!isWaiting) {
        throw new TaskStoreError("resume_conflict", `Task is not waiting for resume: ${task.status}`);
      }
      const expectedConfirmId = task.blocked_info?.confirm_id?.trim() ?? "";
      if (!expectedConfirmId) {
        throw new TaskStoreError("resume_conflict", "Task blocked state is missing confirmId");
      }
      const providedConfirmId = input?.confirmId?.trim() ?? "";
      if (!providedConfirmId) {
        throw new TaskStoreError("invalid_confirm_id", "confirmId is required");
      }
      if (providedConfirmId !== expectedConfirmId) {
        throw new TaskStoreError("invalid_confirm_id", "confirmId does not match current blocked state");
      }
      task.status = task.progress >= 1 ? "completed" : "running";
      task.blocked_info = undefined;
      task.updated_at = Date.now();
      return task;
    });
  }

  async failTask(taskId: string, reason: string): Promise<Task> {
    return this.mutate((fileData) => {
      const task = this.requireTask(fileData, taskId);
      task.status = "failed";
      task.blocked_info = undefined;
      task.updated_at = Date.now();
      task.plan_markdown = task.plan_markdown
        ? `${task.plan_markdown}\n\n---\n失败原因：${reason}`
        : `失败原因：${reason}`;
      return task;
    });
  }

  async findApprovalTaskByToken(token: string): Promise<Task | null> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      const now = Date.now();
      const task = fileData.tasks.find((row) => {
        const blocked = row.blocked_info;
        if (!blocked) {
          return false;
        }
        if (blocked.reason !== "waiting_external_approval") {
          return false;
        }
        if (blocked.webhook_token !== token) {
          return false;
        }
        if (typeof blocked.expires_at === "number" && blocked.expires_at < now) {
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

  private async mutate<T>(updater: (fileData: TaskFileV1) => Promise<T> | T): Promise<T> {
    return withFileLock(this.filePath, LOCK_OPTIONS, async () => {
      const fileData = await this.readOrRepair();
      const result = await updater(fileData);
      await this.writeAtomically(fileData);
      return result;
    });
  }

  private requireTask(fileData: TaskFileV1, taskId: string): Task {
    const task = fileData.tasks.find((row) => row.id === taskId);
    if (!task) {
      throw new TaskStoreError("task_not_found", `Task not found: ${taskId}`);
    }
    return task;
  }

  private async readOrRepair(): Promise<TaskFileV1> {
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
      const empty = createEmptyTaskFile();
      await this.backupThenReset(rawText);
      return empty;
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
        schema_version: 1,
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

  private async writeAtomically(fileData: TaskFileV1): Promise<void> {
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

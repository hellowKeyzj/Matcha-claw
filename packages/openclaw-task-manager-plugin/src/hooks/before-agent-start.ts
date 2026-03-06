import type { TaskStore } from "../task-store.js";
import { calculateMarkdownProgress } from "../progress-parser.js";
import { assessTaskComplexity, parseTaskIdFromText, type TaskComplexityAssessment } from "../trigger-detector.js";

const TOP_LEVEL_CHECKBOX_REGEX = /^-\s+\[([ xX])\]\s+(.*)$/;

type BeforeAgentStartEvent = {
  prompt?: string;
  history?: unknown;
  messages?: unknown;
};

type BeforeAgentStartContext = {
  workspaceDir?: string;
  sessionKey?: string;
  history?: unknown;
  messages?: unknown;
  session?: {
    history?: unknown;
    messages?: unknown;
  };
};

type BeforeAgentStartResult = {
  prependContext?: string;
} | void;

type StoreResolver = (workspaceDir?: unknown) => TaskStore;
type HistoryRole = "assistant" | "user" | "system" | "tool" | "unknown";
type HistoryEntry = {
  role: HistoryRole;
  text: string;
};

function parseTaskIdFromPrompt(prompt: string): string | null {
  return parseTaskIdFromText(prompt);
}

function normalizeInlineMarkdown(text: string): string {
  return text
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTopLevelSteps(markdown: string): Array<{ checked: boolean; text: string }> {
  const steps: Array<{ checked: boolean; text: string }> = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^\s/.test(trimmed)) {
      continue;
    }
    const matched = trimmed.match(TOP_LEVEL_CHECKBOX_REGEX);
    if (!matched) {
      continue;
    }
    steps.push({
      checked: matched[1].toLowerCase() === "x",
      text: normalizeInlineMarkdown(matched[2]),
    });
  }
  return steps;
}

function parseResumeHint(prompt: string): string | null {
  if (!prompt) {
    return null;
  }
  const matched = prompt.match(/附加信息[:：]\s*([^\n\r]+)/);
  if (matched && matched[1].trim()) {
    return matched[1].trim();
  }
  const userFeedbackMatched = prompt.match(/用户反馈[:：]\s*([^\n\r]+)/);
  if (userFeedbackMatched && userFeedbackMatched[1].trim()) {
    return userFeedbackMatched[1].trim();
  }
  return null;
}

function normalizeRole(role: unknown): HistoryRole {
  if (typeof role !== "string") {
    return "unknown";
  }
  const normalized = role.trim().toLowerCase();
  if (normalized === "assistant" || normalized === "user" || normalized === "system" || normalized === "tool") {
    return normalized;
  }
  return "unknown";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextFromContent(item))
      .filter((item) => item.length > 0)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const textFields = [record.text, record.content, record.value, record.message];
    for (const field of textFields) {
      const extracted = extractTextFromContent(field);
      if (extracted) {
        return extracted;
      }
    }
  }
  return "";
}

function extractHistoryEntries(source: unknown): HistoryEntry[] {
  if (!Array.isArray(source)) {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const nestedMessage = (record.message && typeof record.message === "object")
      ? record.message as Record<string, unknown>
      : null;
    const role = normalizeRole(record.role ?? nestedMessage?.role);
    const text = extractTextFromContent(
      record.content
      ?? record.text
      ?? nestedMessage?.content
      ?? nestedMessage?.text
      ?? record.message,
    );
    if (!text) {
      continue;
    }
    entries.push({ role, text });
  }
  return entries;
}

function buildTriggerProbeText(event: BeforeAgentStartEvent, context: BeforeAgentStartContext): string {
  const historySources = [
    event.history,
    event.messages,
    context.history,
    context.messages,
    context.session?.history,
    context.session?.messages,
  ];
  const history = historySources.flatMap((source) => extractHistoryEntries(source));
  const recent = history.slice(-8);
  const assistantRecent = recent
    .filter((entry) => entry.role === "assistant")
    .slice(-3)
    .map((entry) => entry.text.trim())
    .filter((text) => text.length > 0);

  return assistantRecent.join("\n\n").trim();
}

function buildTaskTriggerHint(assessment: TaskComplexityAssessment): string[] {
  if (!assessment.shouldSuggestTaskMode) {
    return [];
  }

  const reasons = assessment.reasons.length > 0 ? assessment.reasons : ["检测到潜在多步骤复杂任务"];
  const signals = assessment.signals;

  return [
    "## Task Manager 触发建议",
    ...reasons.map((reason) => `- ${reason}`),
    "",
    "## 复杂度评估框架",
    "- 评估维度：步骤规模 / 依赖顺序 / 中断恢复成本",
    `- 评分结果：${assessment.score}（步骤信号=${signals.stepLabelCount}，顺序信号=${signals.sequenceCount}，列表项=${signals.listCount}，动作动词=${signals.verbCount}）`,
    "- 判定规则：复杂度分数 >= 4 或命中显式 Task Manager 指令，建议进入任务模式。",
    "",
    "## 建议执行路径",
    "- 先输出计划草案并与用户确认。",
    "- 确认后调用：task_create -> task_set_plan_markdown -> sessions_spawn(mode=\"run\", cleanup=\"delete\") -> task_bind_session。",
    "- 执行中若步骤膨胀，可中途切换到任务模式；无需等本轮完成。",
  ];
}

function formatBlockedInfo(storeTask: Awaited<ReturnType<TaskStore["getTask"]>>): string {
  if (!storeTask?.blocked_info) {
    return "无";
  }
  if (storeTask.blocked_info.reason === "need_user_confirm") {
    return `等待用户确认：${storeTask.blocked_info.question ?? "（未提供问题）"}`;
  }
  return `等待外部审批：${storeTask.blocked_info.description ?? "（未提供描述）"}`;
}

function isWorkerSession(sessionKey?: string): boolean {
  if (!sessionKey) {
    return false;
  }
  const lowered = sessionKey.toLowerCase();
  return lowered.includes("spawn") || lowered.includes("subagent") || lowered.includes("worker");
}

export function createBeforeAgentStartHandler(resolveStore: StoreResolver) {
  return async (
    event: BeforeAgentStartEvent,
    context: BeforeAgentStartContext,
  ): Promise<BeforeAgentStartResult> => {
    const store = resolveStore(context.workspaceDir);
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const assistantProbeText = buildTriggerProbeText(event, context);
    const triggerAssessment = assessTaskComplexity({
      promptText: prompt,
      assistantText: assistantProbeText,
      skipWhenTaskIdInPrompt: true,
    });
    const taskTriggerHintLines = buildTaskTriggerHint(triggerAssessment);

    if (isWorkerSession(context.sessionKey)) {
      const taskId = parseTaskIdFromPrompt(prompt);
      if (taskId) {
        const task = await store.getTask(taskId);
        if (!task) {
          return;
        }
        if (context.sessionKey) {
          await store.bindSession(task.id, context.sessionKey);
        }
        const progress = calculateMarkdownProgress(task.plan_markdown || "");
        const topLevelSteps = parseTopLevelSteps(task.plan_markdown || "");
        const nextPendingStep = topLevelSteps.find((row) => !row.checked)?.text ?? "无（可能已完成）";
        const resumeHint = parseResumeHint(prompt);
        const blockedInfoSummary = formatBlockedInfo(task);
        return {
          prependContext: [
            "## Task Manager Task Packet",
            `- 任务 ID: ${task.id}`,
            `- 任务目标: ${task.goal}`,
            `- 工作区: ${store.getWorkspaceDir()}`,
            `- 任务绑定会话: ${task.assigned_session ?? "（未绑定）"}`,
            `- 当前会话: ${context.sessionKey ?? "（未知）"}`,
            `- 当前状态: ${task.status}`,
            `- 进度摘要: ${Math.round(task.progress * 100)}%（${progress.completed}/${progress.total}）`,
            `- 下一顶层步骤: ${nextPendingStep}`,
            `- 阻塞信息: ${blockedInfoSummary}`,
            ...(resumeHint ? [`- 恢复附加信息: ${resumeHint}`] : []),
            "",
            "### 执行边界",
            "- 只在当前工作区内操作，禁止跨目录写入。",
            "- 按计划推进；每完成一项即调用 task_set_plan_markdown（提交完整文档）。",
            "- 若需要人工确认，调用 task_request_user_input 并结束当前回合。",
            "- 若需要外部审批，调用 task_wait_approval 并结束当前回合。",
            "- 执行决策以 Task Packet 字段为准，Markdown 仅作为参考附件。",
            "",
            "### 参考附件：当前计划（Markdown 原文）",
            "以下内容仅用于补充理解，不是主执行依据：",
            "",
            task.plan_markdown || "(暂无计划内容)",
          ].join("\n"),
        };
      }
    }

    const runningTasks = await store.listRunningTasks();
    const waitingTasks = await store.listWaitingTasks();
    if (runningTasks.length === 0 && waitingTasks.length === 0 && taskTriggerHintLines.length === 0) {
      return;
    }

    const lines: string[] = [];
    if (runningTasks.length > 0 || waitingTasks.length > 0) {
      lines.push("## Task Manager 恢复提示");
    }
    if (runningTasks.length > 0) {
      lines.push("以下任务处于 running，请优先恢复：");
      for (const task of runningTasks) {
        lines.push(`- ${task.id}: ${task.goal}`);
      }
    }
    if (waitingTasks.length > 0) {
      lines.push("以下任务处于等待状态，暂不自动恢复：");
      for (const task of waitingTasks) {
        lines.push(`- ${task.id}: ${task.goal} (${task.status})`);
      }
    }
    if (runningTasks.length > 0 || waitingTasks.length > 0) {
      lines.push(
        "如需恢复任务，请执行 sessions_spawn 并在消息中明确任务 ID，且参数必须包含 mode=\"run\"、cleanup=\"delete\"，避免子会话常驻。",
      );
    }
    if (taskTriggerHintLines.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(...taskTriggerHintLines);
    }

    return { prependContext: lines.join("\n") };
  };
}

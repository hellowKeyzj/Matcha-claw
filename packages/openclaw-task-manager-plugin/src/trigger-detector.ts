const TASK_ID_REGEX = /\btask-[\w-]+\b/i;

const EXPLICIT_TASK_MANAGER_HINTS = [
  /task manager/i,
  /\btask_create\b/i,
  /\btask_set_plan_markdown\b/i,
  /\bsessions_spawn\b/i,
  /长任务/i,
  /任务中心/i,
];

const STEP_LABEL_HINTS = [
  /步骤\s*\d+/i,
  /第[一二三四五六七八九十]+步/i,
  /阶段\s*\d+/i,
  /\bstep\s*\d+\b/i,
  /\bphase\s*\d+\b/i,
];

const SEQUENCE_HINTS = [
  /先.*再/i,
  /然后/i,
  /之后/i,
  /最后/i,
  /接着/i,
  /\bthen\b/i,
  /\bnext\b/i,
  /\bfinally\b/i,
];

const WORKFLOW_INTENT_HINTS = [
  /执行[\s\S]{0,12}流程/i,
  /启动[\s\S]{0,12}流程/i,
  /推进[\s\S]{0,12}流程/i,
  /跑[\s\S]{0,12}流程/i,
  /\bworkflow\b/i,
  /\bprocess\b/i,
];

const CORE_COMPLEXITY_VERBS = [
  /规划/i,
  /拆解/i,
  /执行/i,
  /推进/i,
  /处理/i,
  /跟进/i,
  /重构/i,
  /迁移/i,
  /调研/i,
  /分析/i,
  /排查/i,
  /验证/i,
  /交付/i,
  /编排/i,
  /落地/i,
  /implement/i,
  /refactor/i,
  /migrate/i,
  /investigate/i,
  /analyze/i,
  /execute/i,
];

const LIST_ITEM_REGEX = /^\s*(?:[-*]\s+|\d+\.\s+)/;

export type TaskComplexityAssessment = {
  shouldSuggestTaskMode: boolean;
  score: number;
  reasons: string[];
  signals: {
    explicitHint: boolean;
    stepLabelCount: number;
    sequenceCount: number;
    listCount: number;
    workflowIntent: boolean;
    verbCount: number;
  };
};

export function parseTaskIdFromText(text: string): string | null {
  const match = text.match(TASK_ID_REGEX);
  return match?.[0] ?? null;
}

function countMatches(patterns: RegExp[], text: string): number {
  return patterns.reduce((count, pattern) => (pattern.test(text) ? count + 1 : count), 0);
}

function countListItems(text: string): number {
  return text
    .split(/\r?\n/)
    .filter((line) => LIST_ITEM_REGEX.test(line))
    .length;
}

export function assessTaskComplexity(input: {
  promptText?: string;
  assistantText?: string;
  skipWhenTaskIdInPrompt?: boolean;
}): TaskComplexityAssessment {
  const promptText = (input.promptText ?? "").trim();
  const assistantText = (input.assistantText ?? "").trim();
  const composite = [assistantText, promptText].filter((text) => text.length > 0).join("\n\n");

  if (!composite) {
    return {
      shouldSuggestTaskMode: false,
      score: 0,
      reasons: [],
      signals: {
        explicitHint: false,
        stepLabelCount: 0,
        sequenceCount: 0,
        listCount: 0,
        workflowIntent: false,
        verbCount: 0,
      },
    };
  }

  if (input.skipWhenTaskIdInPrompt && parseTaskIdFromText(promptText)) {
    return {
      shouldSuggestTaskMode: false,
      score: 0,
      reasons: [],
      signals: {
        explicitHint: false,
        stepLabelCount: 0,
        sequenceCount: 0,
        listCount: 0,
        workflowIntent: false,
        verbCount: 0,
      },
    };
  }

  const explicitHint = EXPLICIT_TASK_MANAGER_HINTS.some((pattern) => pattern.test(composite));
  const stepLabelCount = countMatches(STEP_LABEL_HINTS, composite);
  const sequenceCount = countMatches(SEQUENCE_HINTS, composite);
  const workflowIntent = WORKFLOW_INTENT_HINTS.some((pattern) => pattern.test(promptText || composite));
  const verbCount = countMatches(CORE_COMPLEXITY_VERBS, composite);
  const listCount = countListItems(composite);

  let score = 0;
  if (explicitHint) score += 4;
  if (stepLabelCount > 0) score += 3;
  if (sequenceCount >= 1) score += 1;
  if (sequenceCount >= 2) score += 1;
  if (listCount >= 3) score += 2;
  if (listCount >= 5) score += 1;
  if (workflowIntent) score += 2;
  if (verbCount >= 1) score += 1;
  if (verbCount >= 2) score += 1;
  if (verbCount >= 4) score += 1;

  const structuralMultiStep = stepLabelCount > 0 || listCount >= 3 || sequenceCount >= 2;
  const workflowDriven = workflowIntent && (verbCount >= 1 || listCount >= 2);
  const shouldSuggestTaskMode = explicitHint || structuralMultiStep || workflowDriven || score >= 4;
  const reasons: string[] = [];

  if (stepLabelCount > 0) {
    reasons.push(`检测到步骤化表达（步骤信号 ${stepLabelCount} 处）`);
  }
  if (sequenceCount >= 2) {
    reasons.push(`检测到顺序依赖表达（时序信号 ${sequenceCount} 处）`);
  }
  if (listCount >= 3) {
    reasons.push(`检测到多项执行清单（列表项 ${listCount} 条）`);
  }
  if (workflowIntent) {
    reasons.push("检测到流程/工作流执行意图");
  }
  if (explicitHint) {
    reasons.push("检测到显式 Task Manager 指令");
  }
  if (reasons.length === 0 && shouldSuggestTaskMode) {
    reasons.push("检测到潜在多步骤复杂任务");
  }

  return {
    shouldSuggestTaskMode,
    score,
    reasons,
    signals: {
      explicitHint,
      stepLabelCount,
      sequenceCount,
      listCount,
      workflowIntent,
      verbCount,
    },
  };
}

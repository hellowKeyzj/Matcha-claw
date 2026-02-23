import type { TeamPlan, TeamPlanTask, TeamTaskRuntime } from '@/types/team';

function extractBalancedJson(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function pickCandidateJsonStrings(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    const candidate = extractBalancedJson(trimmed, 0);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const planPrefix = /PLAN(?:_JSON)?\s*:\s*/ig;
  for (const match of trimmed.matchAll(planPrefix)) {
    if (match.index == null) {
      continue;
    }
    const start = trimmed.indexOf('{', match.index + match[0].length);
    if (start < 0) {
      continue;
    }
    const candidate = extractBalancedJson(trimmed, start);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/ig;
  for (const match of trimmed.matchAll(fenced)) {
    const block = (match[1] ?? '').trim();
    const start = block.indexOf('{');
    if (start < 0) {
      continue;
    }
    const candidate = extractBalancedJson(block, start);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const genericStart = trimmed.indexOf('{');
  if (genericStart >= 0) {
    const candidate = extractBalancedJson(trimmed, genericStart);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizePlanTask(value: unknown, index: number): TeamPlanTask | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  const taskId = normalizeString(row.taskId ?? row.task_id) || `task-${index + 1}`;
  const instruction = normalizeString(row.instruction ?? row.task ?? row.description ?? row.task_description);
  if (!instruction) {
    return null;
  }

  const agentId = normalizeString(row.agentId ?? row.agent_id) || undefined;
  const role = normalizeString(row.role ?? row.agent_role) || undefined;
  if (!agentId && !role) {
    return null;
  }

  const acceptance = normalizeStringArray(row.acceptance ?? row.acceptance_criteria);
  const dependsOn = normalizeStringArray(row.dependsOn ?? row.depends_on);

  return {
    taskId,
    agentId,
    role,
    instruction,
    acceptance,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function normalizeParsedPlan(value: unknown): TeamPlan | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const tasksRaw = payload.tasks ?? payload.assignments ?? payload.memberAssignments;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    return null;
  }

  const tasks: TeamPlanTask[] = [];
  tasksRaw.forEach((task, index) => {
    const normalized = normalizePlanTask(task, index);
    if (normalized) {
      tasks.push(normalized);
    }
  });

  if (tasks.length === 0) {
    return null;
  }

  const objective = normalizeString(payload.objective ?? payload.goal ?? payload.target) || '未命名目标';
  const scope = normalizeStringArray(payload.scope ?? payload.inScope);
  const risks = normalizeStringArray(payload.risks ?? payload.riskList);

  return {
    objective,
    ...(scope.length > 0 ? { scope } : {}),
    tasks,
    ...(risks.length > 0 ? { risks } : {}),
  };
}

export function parseTeamPlanFromText(text: string): TeamPlan | null {
  const candidates = pickCandidateJsonStrings(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const normalized = normalizeParsedPlan(parsed);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Continue scanning.
    }
  }
  return null;
}

export function buildPlanFormatRetryMessage(): string {
  return [
    '上一条 PLAN 无法被系统解析。请只返回一个 JSON 对象，不要 Markdown 代码块。',
    '严格格式：',
    '{',
    '  "objective": "目标",',
    '  "tasks": [',
    '    {',
    '      "taskId": "task-1",',
    '      "agentId": "agent-id(可选)",',
    '      "role": "角色名(当 agentId 缺失时必填)",',
    '      "instruction": "执行指令",',
    '      "acceptance": ["验收标准1", "验收标准2"]',
    '    }',
    '  ],',
    '  "risks": ["风险1"]',
    '}',
  ].join('\n');
}

export function looksLikePlanIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('plan')
    || normalized.includes('任务分工')
    || normalized.includes('执行计划')
    || normalized.includes('"tasks"')
  );
}

export function buildTeamTaskRuntime(input: {
  plan: TeamPlan;
  resolvedAgentByTaskId: Record<string, string>;
  now?: number;
}): TeamTaskRuntime[] {
  const now = input.now ?? Date.now();
  return input.plan.tasks
    .filter((task) => input.resolvedAgentByTaskId[task.taskId])
    .map((task) => ({
      taskId: task.taskId,
      agentId: input.resolvedAgentByTaskId[task.taskId],
      instruction: task.instruction,
      acceptance: task.acceptance,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));
}

import type { TeamPlan, TeamReport } from '@/types/team';

export type ControllerDecisionAction = 'keep_research' | 'ask_user' | 'ready_for_planning' | 'ready_for_convergence';
export type ReviewVerdict = 'approve' | 'revise' | 'blocked';
export type ExecutionBlueprintAction = 'revise_plan' | 'ready_to_execute' | 'ask_user';
export type ConvergenceDigestStatus = 'continue' | 'ready';

export interface RequiredDecision {
  key: string;
  question: string;
  defaultValue?: string;
  options: string[];
}

export interface ControllerDecision {
  action: ControllerDecisionAction;
  reply: string;
  reason?: string;
  questions?: string[];
  missingInfo?: string[];
  readyReason?: string;
}

export interface TeamReviewJson {
  agentId: string;
  verdict: ReviewVerdict;
  summary: string;
  blockers: string[];
  requiredDecisions: RequiredDecision[];
  suggestions: string[];
}

export interface ExecutionBlueprint {
  action: ExecutionBlueprintAction;
  reply: string;
  reason?: string;
  mustFix: string[];
  requiredDecisionsResolved: boolean;
  assumptions: string[];
}

export interface ConvergenceDigest {
  status: ConvergenceDigestStatus;
  summary: string;
  agreements: string[];
  conflicts: string[];
  openQuestions: string[];
}

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

function pickCandidateJsonStrings(text: string, labelPrefixes: string[]): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return candidates;
  }

  for (const label of labelPrefixes) {
    const matcher = new RegExp(`${label}\\s*:\\s*`, 'ig');
    for (const match of trimmed.matchAll(matcher)) {
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

function toDecisionKey(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'decision';
}

function normalizeRequiredDecisionArray(value: unknown): RequiredDecision[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: RequiredDecision[] = [];
  value.forEach((item, index) => {
    if (typeof item === 'string') {
      const question = item.trim();
      if (!question) {
        return;
      }
      const key = `${toDecisionKey(question)}-${index + 1}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      result.push({
        key,
        question,
        options: [],
      });
      return;
    }
    if (!item || typeof item !== 'object') {
      return;
    }
    const row = item as Record<string, unknown>;
    const question = normalizeString(row.question ?? row.prompt ?? row.title ?? row.summary);
    if (!question) {
      return;
    }
    const key = normalizeString(row.key ?? row.id ?? row.name) || toDecisionKey(question);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const defaultValue = normalizeString(row.default_value ?? row.defaultValue ?? row.default) || undefined;
    result.push({
      key,
      question,
      ...(defaultValue ? { defaultValue } : {}),
      options: normalizeStringArray(row.options ?? row.choices),
    });
  });
  return result;
}

function parseJsonCandidates<T>(text: string, labels: string[], normalize: (input: unknown) => T | null): T | null {
  const candidates = pickCandidateJsonStrings(text, labels);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const direct = normalize(parsed);
      if (direct) {
        return direct;
      }
      if (parsed && typeof parsed === 'object') {
        const row = parsed as Record<string, unknown>;
        const nested = normalize(row.payload ?? row.data ?? row.result);
        if (nested) {
          return nested;
        }
      }
    } catch {
      // continue scanning
    }
  }
  return null;
}

function normalizeControllerDecision(raw: unknown): ControllerDecision | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const action = normalizeString(row.action).toLowerCase();
  if (
    action !== 'keep_research'
    && action !== 'ask_user'
    && action !== 'ready_for_planning'
    && action !== 'ready_for_convergence'
  ) {
    return null;
  }
  const reply = normalizeString(row.reply || row.user_message || row.message || row.question || row.summary);
  if (!reply) {
    return null;
  }
  const reason = normalizeString(row.reason) || undefined;
  const questions = normalizeStringArray(row.questions ?? row.open_questions ?? row.openQuestions);
  const missingInfo = normalizeStringArray(row.missing_info ?? row.missingInfo);
  const readyReason = normalizeString(row.ready_reason ?? row.readyReason) || undefined;
  return {
    action,
    reply,
    reason,
    ...(questions.length > 0 ? { questions } : {}),
    ...(missingInfo.length > 0 ? { missingInfo } : {}),
    ...(readyReason ? { readyReason } : {}),
  };
}

function normalizeReviewJson(raw: unknown): TeamReviewJson | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const agentId = normalizeString(row.agent_id ?? row.agentId);
  const verdict = normalizeString(row.verdict).toLowerCase();
  if (!agentId) {
    return null;
  }
  if (verdict !== 'approve' && verdict !== 'revise' && verdict !== 'blocked') {
    return null;
  }
  const summary = normalizeString(row.summary || row.reply || row.comment);
  if (!summary) {
    return null;
  }
  const blockers = normalizeStringArray(row.blockers ?? row.issues);
  const requiredDecisions = normalizeRequiredDecisionArray(
    row.required_decisions ?? row.requiredDecisions ?? row.questions,
  );
  if (verdict === 'approve' && (blockers.length > 0 || requiredDecisions.length > 0)) {
    return null;
  }
  return {
    agentId,
    verdict,
    summary,
    blockers,
    requiredDecisions,
    suggestions: normalizeStringArray(row.suggestions),
  };
}

function normalizeExecutionBlueprint(raw: unknown): ExecutionBlueprint | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const action = normalizeString(row.action).toLowerCase();
  if (action !== 'revise_plan' && action !== 'ready_to_execute' && action !== 'ask_user') {
    return null;
  }
  const reply = normalizeString(row.reply || row.user_message || row.message || row.summary);
  if (!reply) {
    return null;
  }
  const reason = normalizeString(row.reason) || undefined;
  const mustFix = normalizeStringArray(row.must_fix ?? row.mustFix);
  const requiredDecisionsResolvedRaw = row.required_decisions_resolved ?? row.requiredDecisionsResolved;
  if (typeof requiredDecisionsResolvedRaw !== 'boolean') {
    return null;
  }
  const assumptions = normalizeStringArray(row.assumptions);
  return {
    action,
    reply,
    reason,
    mustFix,
    requiredDecisionsResolved: requiredDecisionsResolvedRaw,
    assumptions,
  };
}

function normalizeConvergenceDigest(raw: unknown): ConvergenceDigest | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const status = normalizeString(row.status).toLowerCase();
  if (status !== 'continue' && status !== 'ready') {
    return null;
  }
  const summary = normalizeString(row.summary || row.reply || row.message);
  if (!summary) {
    return null;
  }
  return {
    status,
    summary,
    agreements: normalizeStringArray(row.agreements),
    conflicts: normalizeStringArray(row.conflicts),
    openQuestions: normalizeStringArray(row.open_questions ?? row.openQuestions),
  };
}

export function validateTeamPlanProtocol(plan: TeamPlan | null): { ok: true } | { ok: false; error: string } {
  if (!plan) {
    return { ok: false, error: 'PLAN is empty' };
  }
  if (!normalizeString(plan.objective)) {
    return { ok: false, error: 'PLAN.objective is required' };
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return { ok: false, error: 'PLAN.tasks is required' };
  }
  for (const task of plan.tasks) {
    if (!normalizeString(task.taskId)) {
      return { ok: false, error: 'PLAN.tasks[].taskId is required' };
    }
    if (!normalizeString(task.instruction)) {
      return { ok: false, error: `PLAN.tasks[${task.taskId}].instruction is required` };
    }
    if (!normalizeString(task.agentId ?? task.role)) {
      return { ok: false, error: `PLAN.tasks[${task.taskId}] requires agentId or role` };
    }
    if (!Array.isArray(task.acceptance)) {
      return { ok: false, error: `PLAN.tasks[${task.taskId}].acceptance must be array` };
    }
  }
  return { ok: true };
}

export function validateTeamReportProtocol(
  report: TeamReport | null,
): { ok: true } | { ok: false; error: string } {
  if (!report) {
    return { ok: false, error: 'REPORT missing or unparsable' };
  }
  if (!normalizeString(report.reportId)) {
    return { ok: false, error: 'REPORT.reportId is required' };
  }
  if (!normalizeString(report.task_id)) {
    return { ok: false, error: 'REPORT.task_id is required' };
  }
  if (!normalizeString(report.agent_id)) {
    return { ok: false, error: 'REPORT.agent_id is required' };
  }
  if (report.status !== 'done' && report.status !== 'partial' && report.status !== 'blocked') {
    return { ok: false, error: 'REPORT.status is invalid' };
  }
  if (!Array.isArray(report.result)) {
    return { ok: false, error: 'REPORT.result must be array' };
  }
  return { ok: true };
}

export function parseControllerDecisionFromText(text: string): ControllerDecision | null {
  return parseJsonCandidates(text, ['CONTROLLER_DECISION'], normalizeControllerDecision);
}

export function parseTeamReviewJsonFromText(text: string): TeamReviewJson | null {
  return parseJsonCandidates(text, ['REVIEW_JSON', 'REVIEW'], normalizeReviewJson);
}

export function parseExecutionBlueprintFromText(text: string): ExecutionBlueprint | null {
  return parseJsonCandidates(text, ['EXECUTION_BLUEPRINT', 'BLUEPRINT'], normalizeExecutionBlueprint);
}

export function parseConvergenceDigestFromText(text: string): ConvergenceDigest | null {
  return parseJsonCandidates(text, ['CONVERGENCE_DIGEST_JSON', 'CONVERGENCE_DIGEST', 'DIGEST'], normalizeConvergenceDigest);
}

export function buildControllerDecisionRetryMessage(): string {
  return [
    'Previous output failed CONTROLLER_DECISION validation.',
    'Return exactly one JSON object only. No markdown, no extra text.',
    'Semantics:',
    '- ask_user: use when user input is required; include questions and no phase jump.',
    '- keep_research: use for internal research only; do not ask user questions.',
    '- ready_for_planning: only when information is sufficient; reply must not contain questions.',
    '- ready_for_convergence: only when plan is ready for member review; reply must not contain questions.',
    'Format:',
    '{',
    '  "action": "keep_research | ask_user | ready_for_planning | ready_for_convergence",',
    '  "reply": "one sentence for user",',
    '  "reason": "optional decision rationale",',
    '  "questions": ["optional question to user"],',
    '  "missing_info": ["optional missing item"],',
    '  "ready_reason": "optional readiness evidence"',
    '}',
  ].join('\n');
}

export function buildReviewRetryMessage(agentId: string): string {
  return [
    'Previous output failed REVIEW_JSON validation.',
    'Return exactly one JSON object only. No markdown, no extra text.',
    'Rules:',
    '- blockers: hard blockers that must be fixed before execution.',
    '- required_decisions: user decisions needed before execution; include default values when possible.',
    '- suggestions: optional improvements, non-blocking.',
    '- verdict=approve ONLY when blockers=[] and required_decisions=[].',
    'Format:',
    '{',
    `  "agent_id": "${agentId}",`,
    '  "verdict": "approve | revise | blocked",',
    '  "summary": "one sentence review conclusion",',
    '  "blockers": ["blocking issue 1"],',
    '  "required_decisions": [{"key":"api-provider","question":"Choose default AI provider","default_value":"openai","options":["openai","claude"]}],',
    '  "suggestions": ["optional suggestion 1"]',
    '}',
  ].join('\n');
}

export function buildExecutionBlueprintRetryMessage(): string {
  return [
    'Previous output failed EXECUTION_BLUEPRINT validation.',
    'Return exactly one JSON object only. No markdown, no extra text.',
    'Format:',
    '{',
    '  "action": "revise_plan | ready_to_execute | ask_user",',
    '  "reply": "one sentence for user",',
    '  "reason": "optional decision rationale",',
    '  "must_fix": ["blocking issue 1"],',
    '  "required_decisions_resolved": true,',
    '  "assumptions": ["use default decision X"]',
    '}',
  ].join('\n');
}

export function buildConvergenceDigestRetryMessage(): string {
  return [
    'Previous output failed CONVERGENCE_DIGEST_JSON validation.',
    'Return exactly one JSON object only. No markdown, no extra text.',
    'Format:',
    '{',
    '  "status": "continue | ready",',
    '  "summary": "one sentence digest",',
    '  "agreements": ["agreement 1"],',
    '  "conflicts": ["conflict 1"],',
    '  "open_questions": ["open question 1"]',
    '}',
  ].join('\n');
}

export function buildReportRetryMessage(input: {
  taskId: string;
  agentId: string;
}): string {
  return [
    'Previous output failed REPORT validation.',
    'Return exactly one JSON object prefixed with "REPORT: ".',
    'No markdown, no extra text.',
    'Required fields:',
    '{',
    `  "task_id": "${input.taskId}",`,
    `  "agent_id": "${input.agentId}",`,
    '  "status": "done | partial | blocked",',
    '  "result": ["short bullet 1"]',
    '}',
  ].join('\n');
}

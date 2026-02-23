import type { TeamReport } from '@/types/team';

const REPORT_PREFIX = /REPORT\s*:\s*/i;

export interface ParseReportDefaults {
  defaultTaskId?: string;
  defaultAgentId?: string;
  defaultReportId?: string;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim();
      }
      if (item == null) {
        return '';
      }
      try {
        return JSON.stringify(item);
      } catch {
        return '';
      }
    })
    .filter((item) => item.length > 0);
}

function normalizeReportStatus(value: unknown): TeamReport['status'] | null {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === 'done' || raw === 'completed' || raw === 'complete' || raw === 'success') {
    return 'done';
  }
  if (raw === 'blocked' || raw === 'failed' || raw === 'error') {
    return 'blocked';
  }
  if (raw === 'partial' || raw === 'in_progress' || raw === 'in-progress') {
    return 'partial';
  }
  return null;
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

function pickReportCandidateJsonStrings(text: string): string[] {
  const match = REPORT_PREFIX.exec(text);
  if (!match || match.index == null) {
    return [];
  }

  const tail = text.slice(match.index + match[0].length).trim();
  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/ig;
  for (const fencedMatch of tail.matchAll(fenced)) {
    const block = (fencedMatch[1] ?? '').trim();
    const start = block.indexOf('{');
    if (start < 0) {
      continue;
    }
    const candidate = extractBalancedJson(block, start);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const firstJsonStart = tail.indexOf('{');
  if (firstJsonStart >= 0) {
    const candidate = extractBalancedJson(tail, firstJsonStart);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function normalizeParsedReport(payload: unknown, defaults?: ParseReportDefaults): TeamReport | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const row = payload as Record<string, unknown>;
  const taskId = normalizeString(row.task_id ?? row.taskId) || normalizeString(defaults?.defaultTaskId);
  const agentId = normalizeString(row.agent_id ?? row.agentId) || normalizeString(defaults?.defaultAgentId);
  const status = normalizeReportStatus(row.status ?? row.state);

  if (!taskId || !agentId || !status) {
    return null;
  }

  const reportId = normalizeString(row.reportId ?? row.report_id)
    || normalizeString(defaults?.defaultReportId)
    || `${taskId}:${agentId}:generated`;
  const result = normalizeStringArray(row.result ?? row.results ?? row.output);
  const summary = normalizeString(row.summary);
  const normalizedResult = result.length > 0
    ? result
    : summary
      ? [summary]
      : [];

  const evidence = normalizeStringArray(row.evidence);
  const nextSteps = normalizeStringArray(row.next_steps ?? row.nextSteps);
  const risks = normalizeStringArray(row.risks);

  return {
    reportId,
    task_id: taskId,
    agent_id: agentId,
    status,
    result: normalizedResult,
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(nextSteps.length > 0 ? { next_steps: nextSteps } : {}),
    ...(risks.length > 0 ? { risks } : {}),
  };
}

export function parseReportFromText(text: string, defaults?: ParseReportDefaults): TeamReport | null {
  const candidates = pickReportCandidateJsonStrings(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const normalized = normalizeParsedReport(parsed, defaults);
      if (normalized) {
        return normalized;
      }
      if (parsed && typeof parsed === 'object') {
        const nested = normalizeParsedReport((parsed as Record<string, unknown>).report, defaults);
        if (nested) {
          return nested;
        }
      }
    } catch {
      // Continue scanning next candidate.
    }
  }
  return null;
}

import {
  normalizeAssistantFinalText,
  sanitizeCanonicalUserContent as sanitizeCanonicalUserContentShared,
  sanitizeCanonicalUserText as sanitizeCanonicalUserTextShared,
} from '../../../runtime-host/shared/chat-message-normalization';
import type { SessionMessageRow, SessionRenderRow } from '../../../runtime-host/shared/session-adapter-types';

const SESSION_LABEL_MAX_LENGTH = 50;
const ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS: RegExp[] = [
  /^a new session was started via\b/i,
  /^##\s*task manager\b/i,
  /^task manager.*(恢复提示|动态切换建议)/i,
  /^检测到多个待确认任务/i,
];

function normalizeSessionLabelText(text: string): string {
  const cleaned = text
    .replace(/\[media attached:[^\]]+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '(file attached)') {
    return '';
  }
  if (cleaned.length <= SESSION_LABEL_MAX_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, SESSION_LABEL_MAX_LENGTH)}…`;
}

function shouldIgnoreAssistantSessionLabel(text: string): boolean {
  if (!text) {
    return true;
  }
  return ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

export const sanitizeCanonicalUserText = sanitizeCanonicalUserTextShared;
export const sanitizeCanonicalUserContent = sanitizeCanonicalUserContentShared;

function resolveSessionLabelCandidateFromUserRow(row: SessionMessageRow): string {
  return normalizeSessionLabelText(sanitizeCanonicalUserTextShared(row.text));
}

function resolveSessionLabelCandidateFromAssistantRow(row: SessionMessageRow): string {
  return normalizeSessionLabelText(normalizeAssistantFinalText(row.text));
}

export function resolveSessionLabelFromRows(rows: SessionRenderRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind !== 'message' || row.role !== 'user') {
      continue;
    }
    const candidate = resolveSessionLabelCandidateFromUserRow(row);
    if (candidate) {
      return candidate;
    }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind !== 'message' || row.role !== 'assistant') {
      continue;
    }
    const candidate = resolveSessionLabelCandidateFromAssistantRow(row);
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return candidate;
    }
  }
  return null;
}

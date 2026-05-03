import {
  extractMessageText,
  normalizeAssistantFinalText,
  sanitizeCanonicalUserContent as sanitizeCanonicalUserContentShared,
  sanitizeCanonicalUserText as sanitizeCanonicalUserTextShared,
} from '../../../runtime-host/shared/chat-message-normalization';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

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

export function getMessageText(content: unknown): string {
  return extractMessageText(content);
}

export const sanitizeCanonicalUserText = sanitizeCanonicalUserTextShared;
export const sanitizeCanonicalUserContent = sanitizeCanonicalUserContentShared;

function resolveSessionLabelCandidateFromUserEntry(entry: SessionTimelineEntry): string {
  const text = entry.text || getMessageText(entry.message.content);
  return normalizeSessionLabelText(sanitizeCanonicalUserTextShared(text));
}

function resolveSessionLabelCandidateFromAssistantEntry(entry: SessionTimelineEntry): string {
  return normalizeSessionLabelText(normalizeAssistantFinalText(entry.text || entry.message.content));
}

export function resolveSessionLabelFromTimelineEntries(
  entries: SessionTimelineEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'user') {
      continue;
    }
    const candidate = resolveSessionLabelCandidateFromUserEntry(entry);
    if (candidate) {
      return candidate;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant') {
      continue;
    }
    const candidate = resolveSessionLabelCandidateFromAssistantEntry(entry);
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return candidate;
    }
  }
  return null;
}

import {
  extractMessageText,
  normalizeAssistantFinalText as normalizeAssistantFinalTextShared,
  sanitizeCanonicalUserText,
} from '../../shared/chat-message-normalization';
import type {
  SessionCatalogTitleSource,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';

const SESSION_LABEL_MAX_LENGTH = 50;
const ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS: RegExp[] = [
  /^a new session was started via\b/i,
  /^##\s*task manager\b/i,
  /^task manager.*(恢复提示|动态切换建议)/i,
  /^检测到多个待确认任务/i,
];

export interface SessionResolvedLabel {
  label: string | null;
  titleSource: SessionCatalogTitleSource;
}

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
  return `${cleaned.slice(0, SESSION_LABEL_MAX_LENGTH)}...`;
}

function resolveUserLabelCandidate(content: unknown): string {
  return normalizeSessionLabelText(sanitizeCanonicalUserText(extractMessageText(content)));
}

function resolveAssistantLabelCandidate(content: unknown): string {
  return normalizeSessionLabelText(normalizeAssistantFinalTextShared(content));
}

function shouldIgnoreAssistantSessionLabel(text: string): boolean {
  if (!text) {
    return true;
  }
  return ASSISTANT_SESSION_LABEL_TEMPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

export function resolveSessionLabelFromTimelineEntries(entries: SessionTimelineEntry[]): string | null {
  return resolveSessionLabelDetailsFromTimelineEntries(entries).label;
}

export function resolveSessionLabelDetailsFromTimelineEntries(entries: SessionTimelineEntry[]): SessionResolvedLabel {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'message' || entry.role !== 'user') {
      continue;
    }
    const candidate = resolveUserLabelCandidate(entry.text);
    if (candidate) {
      return {
        label: candidate,
        titleSource: 'user',
      };
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'message' || entry.role !== 'assistant') {
      continue;
    }
    const candidate = resolveAssistantLabelCandidate(entry.text);
    if (candidate && !shouldIgnoreAssistantSessionLabel(candidate)) {
      return {
        label: candidate,
        titleSource: 'assistant',
      };
    }
  }

  return {
    label: null,
    titleSource: 'none',
  };
}

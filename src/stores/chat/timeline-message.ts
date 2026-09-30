import type {
  SessionAssistantTurnSegment,
} from '../../types/session/tool-card';
import type {
  SessionAssistantTurnItem,
  SessionRenderItem,
} from '../../types/session/render-item';

function isAssistantTurnItem(item: SessionRenderItem): item is SessionAssistantTurnItem {
  return item.kind === 'assistant-turn';
}

function readTurnMessageText(item: SessionAssistantTurnItem): string {
  return item.segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message')
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function findLatestAssistantTextFromItems(
  items: SessionRenderItem[],
): string {
  const latestAssistant = findLatestAssistantTurnTextFromItems(items);
  if (latestAssistant) {
    return latestAssistant;
  }

  for (const item of items) {
    if (item.kind !== 'user-message' && item.kind !== 'system') {
      continue;
    }
    const text = 'text' in item && typeof item.text === 'string'
      ? item.text.trim()
      : '';
    if (text) {
      return text;
    }
  }
  return '';
}

export function findLatestAssistantTurnTextFromItems(
  items: SessionRenderItem[],
): string {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }

  let latestAssistant = '';
  for (const item of items) {
    if (!isAssistantTurnItem(item)) {
      continue;
    }
    const text = readTurnMessageText(item);
    if (text) {
      latestAssistant = text;
    }
  }
  if (latestAssistant) {
    return latestAssistant;
  }
  return '';
}

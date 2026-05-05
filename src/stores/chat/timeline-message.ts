import type {
  SessionAssistantTurnSegment,
  SessionAssistantTurnItem,
  SessionRenderItem,
} from '../../../runtime-host/shared/session-adapter-types';

function isAssistantTurnItem(item: SessionRenderItem): item is SessionAssistantTurnItem {
  return item.kind === 'assistant-turn';
}

function readTurnToolNames(item: SessionAssistantTurnItem): string[] {
  return item.segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool')
    .map((segment) => segment.tool.name)
    .filter((name) => typeof name === 'string' && name.trim());
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

  for (const item of items) {
    if (item.kind !== 'user-message' && item.kind !== 'task-completion' && item.kind !== 'system') {
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

export function findLatestAssistantSnapshotFromItems(
  items: SessionRenderItem[],
): { text: string; toolNames: string[] } {
  if (!Array.isArray(items) || items.length === 0) {
    return { text: '', toolNames: [] };
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isAssistantTurnItem(item)) {
      continue;
    }
    const text = readTurnMessageText(item);
    const toolNames = readTurnToolNames(item);
    if (text || toolNames.length > 0) {
      return { text, toolNames };
    }
  }

  return {
    text: findLatestAssistantTextFromItems(items),
    toolNames: [],
  };
}

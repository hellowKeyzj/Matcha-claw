import type {
  SessionMessageRow,
  SessionRenderRow,
  SessionToolActivityRow,
} from '../../../runtime-host/shared/session-adapter-types';

function isAssistantContentRow(
  row: SessionRenderRow,
): row is SessionMessageRow | SessionToolActivityRow {
  return row.role === 'assistant' && (row.kind === 'message' || row.kind === 'tool-activity');
}

function readRowToolNames(row: SessionMessageRow | SessionToolActivityRow): string[] {
  return Array.isArray(row.toolUses)
    ? row.toolUses.map((tool) => tool.name).filter((name) => typeof name === 'string' && name.trim())
    : [];
}

export function findLatestAssistantTextFromRows(
  rows: SessionRenderRow[],
): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  let latestAssistant = '';
  for (const row of rows) {
    if (!isAssistantContentRow(row)) {
      continue;
    }
    const text = row.text.trim();
    if (text) {
      latestAssistant = text;
    }
  }
  if (latestAssistant) {
    return latestAssistant;
  }

  for (const row of rows) {
    const text = row.text.trim();
    if (text) {
      return text;
    }
  }
  return '';
}

export function findLatestAssistantSnapshotFromRows(
  rows: SessionRenderRow[],
): { text: string; toolNames: string[] } {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { text: '', toolNames: [] };
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!isAssistantContentRow(row)) {
      continue;
    }
    const text = row.text.trim();
    const toolNames = readRowToolNames(row);
    if (text || toolNames.length > 0) {
      return { text, toolNames };
    }
  }

  return {
    text: findLatestAssistantTextFromRows(rows),
    toolNames: [],
  };
}

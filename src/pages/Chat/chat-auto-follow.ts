import type { ChatRow } from './chat-row-model';

function resolveTailMessageSignalPart(row: ChatRow | null): string {
  if (!row) {
    return '0||';
  }
  const hasContent = row.kind === 'tool-activity'
    ? (row.toolUses.length > 0 ? '1' : '0')
    : (row.text.trim().length > 0 ? '1' : '0');
  return [row.key, row.kind, row.entryId ?? '', hasContent].join('|');
}

export function buildChatAutoFollowSignal(rows: ChatRow[]): string {
  const tailMessageRow = rows.at(-1) ?? null;
  return `${rows.length}|${resolveTailMessageSignalPart(tailMessageRow)}`;
}

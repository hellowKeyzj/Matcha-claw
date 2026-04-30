import type { ChatRow } from './chat-row-model';

function resolveTailMessageSignalPart(
  row: ChatRow | null,
): string {
  if (!row) {
    return '0||';
  }
  const hasContent = row.text.trim().length > 0 ? '1' : '0';
  return [row.key, typeof row.message.id === 'string' ? row.message.id : '', hasContent].join('|');
}

export function buildChatAutoFollowSignal(rows: ChatRow[]): string {
  const tailMessageRow = rows.at(-1) ?? null;
  return `${rows.length}|${resolveTailMessageSignalPart(tailMessageRow)}`;
}

import type { ChatRow } from './chat-row-model';
import { extractText } from './message-utils';

function resolveTailRowSignalPart(
  row: ChatRow | null,
): string {
  if (!row) {
    return '0||';
  }
  if (row.kind !== 'message') {
    return [row.key, row.kind, '1'].join('|');
  }
  const hasContent = extractText(row.message).trim().length > 0 ? '1' : '0';
  return [row.key, typeof row.message.id === 'string' ? row.message.id : '', hasContent].join('|');
}

export function buildChatAutoFollowSignal(chatRows: ChatRow[]): string {
  let rowCount = 0;
  let tailRow: ChatRow | null = null;

  for (const row of chatRows) {
    rowCount += 1;
    tailRow = row;
  }

  return `${rowCount}|${resolveTailRowSignalPart(tailRow)}`;
}

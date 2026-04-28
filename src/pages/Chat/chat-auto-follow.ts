import type { ViewportListItem } from './viewport-list-items';
import { extractText } from './message-utils';

function resolveTailRowSignalPart(
  item: ViewportListItem | null,
): string {
  if (!item) {
    return '0||';
  }
  if (item.kind === 'execution_graph') {
    return [item.key, item.kind, '1'].join('|');
  }
  if (item.kind !== 'message') {
    return [item.key, item.kind, '1'].join('|');
  }
  const hasContent = extractText(item.row.message).trim().length > 0 ? '1' : '0';
  return [item.key, typeof item.row.message.id === 'string' ? item.row.message.id : '', hasContent].join('|');
}

export function buildChatAutoFollowSignal(items: ViewportListItem[]): string {
  let rowCount = 0;
  let tailItem: ViewportListItem | null = null;

  for (const item of items) {
    rowCount += 1;
    tailItem = item;
  }

  return `${rowCount}|${resolveTailRowSignalPart(tailItem)}`;
}

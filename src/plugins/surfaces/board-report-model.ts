// Data-only schema adapted from OpenClaw src/boards/board-report.ts (MIT).
type ReportMetric = { label: string; value: string; detail?: string };
type ReportLink = { label: string; url: string; detail?: string };
export type BoardReportBlock =
  | { type: 'text'; title?: string; text: string }
  | { type: 'metrics'; items: ReportMetric[] }
  | { type: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { type: 'chart'; title?: string; style?: 'bar' | 'line'; points: { label: string; value: number }[] }
  | { type: 'links'; title?: string; items: ReportLink[] };
export type BoardReport = { blocks: BoardReportBlock[] };
type ReportResult = { report: BoardReport } | { error: string };

const BLOCK_FIELDS = {
  text: ['type', 'title', 'text'],
  metrics: ['type', 'items'],
  table: ['type', 'title', 'columns', 'rows'],
  chart: ['type', 'title', 'style', 'points'],
  links: ['type', 'title', 'items'],
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fields(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function list(value: unknown, min: number, max: number): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max;
}

function invalid(path: string, message: string): ReportResult {
  return { error: `Invalid report at ${path}: ${message}` };
}

export function parseBoardReport(value: unknown): ReportResult {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { return invalid('root', 'Report must be JSON data'); }
  if (new TextEncoder().encode(serialized).byteLength > 8 * 1024) return { error: 'Report exceeds 8KB JSON budget' };
  if (!fields(value, ['blocks'])) return invalid('root', 'Expected only blocks');
  if (!list(value.blocks, 1, 24)) return invalid('blocks', 'Expected 1–24 blocks');

  const blocks: BoardReportBlock[] = [];
  for (const [index, block] of value.blocks.entries()) {
    const path = `blocks.${index}`;
    if (!record(block) || typeof block.type !== 'string' || !Object.hasOwn(BLOCK_FIELDS, block.type)) {
      return invalid(`${path}.type`, 'Expected text, metrics, table, chart or links');
    }
    if (!fields(block, BLOCK_FIELDS[block.type as keyof typeof BLOCK_FIELDS])) return invalid(path, 'Unexpected field');
    if (block.title !== undefined && !text(block.title, 1, 120)) return invalid(`${path}.title`, 'Expected 1–120 characters');

    switch (block.type) {
      case 'text':
        if (!text(block.text, 1, 4_000)) return invalid(`${path}.text`, 'Expected 1–4000 characters');
        break;
      case 'metrics':
        if (!list(block.items, 1, 8)) return invalid(`${path}.items`, 'Expected 1–8 metrics');
        for (const [itemIndex, item] of block.items.entries()) {
          const itemPath = `${path}.items.${itemIndex}`;
          if (!fields(item, ['label', 'value', 'detail'])) return invalid(itemPath, 'Expected label, value and optional detail');
          if (!text(item.label, 1, 160)) return invalid(`${itemPath}.label`, 'Expected 1–160 characters');
          if (!text(item.value, 1, 80)) return invalid(`${itemPath}.value`, 'Expected 1–80 characters');
          if (item.detail !== undefined && !text(item.detail, 0, 240)) return invalid(`${itemPath}.detail`, 'Expected at most 240 characters');
        }
        break;
      case 'table':
        if (!list(block.columns, 1, 8) || !block.columns.every((column) => text(column, 1, 160))) return invalid(`${path}.columns`, 'Expected 1–8 labels of 1–160 characters');
        if (!list(block.rows, 0, 40)) return invalid(`${path}.rows`, 'Expected at most 40 rows');
        for (const [rowIndex, row] of block.rows.entries()) {
          if (!list(row, 0, 8) || !row.every((cell) => text(cell, 0, 500))) return invalid(`${path}.rows.${rowIndex}`, 'Expected at most 8 string cells of at most 500 characters');
          if (row.length !== block.columns.length) return invalid(path, 'Every table row must match the columns');
        }
        break;
      case 'chart':
        if (block.style !== undefined && block.style !== 'bar' && block.style !== 'line') return invalid(`${path}.style`, 'Expected bar or line');
        if (!list(block.points, 1, 40)) return invalid(`${path}.points`, 'Expected 1–40 points');
        for (const [pointIndex, point] of block.points.entries()) {
          const pointPath = `${path}.points.${pointIndex}`;
          if (!fields(point, ['label', 'value'])) return invalid(pointPath, 'Expected only label and value');
          if (!text(point.label, 1, 160)) return invalid(`${pointPath}.label`, 'Expected 1–160 characters');
          if (typeof point.value !== 'number' || !Number.isFinite(point.value) || Math.abs(point.value) > Number.MAX_SAFE_INTEGER) return invalid(`${pointPath}.value`, 'Expected a finite number within the safe integer bounds');
        }
        break;
      case 'links': {
        if (!list(block.items, 1, 20)) return invalid(`${path}.items`, 'Expected 1–20 links');
        const items: ReportLink[] = [];
        for (const [itemIndex, item] of block.items.entries()) {
          const itemPath = `${path}.items.${itemIndex}`;
          if (!fields(item, ['label', 'url', 'detail'])) return invalid(itemPath, 'Expected label, url and optional detail');
          if (!text(item.label, 1, 160)) return invalid(`${itemPath}.label`, 'Expected 1–160 characters');
          if (item.detail !== undefined && !text(item.detail, 0, 240)) return invalid(`${itemPath}.detail`, 'Expected at most 240 characters');
          let url: URL;
          try { url = new URL(typeof item.url === 'string' ? item.url : ''); }
          catch { return invalid(`${itemPath}.url`, 'Expected an HTTP(S) URL'); }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid(`${itemPath}.url`, 'Expected an HTTP(S) URL');
          if (url.href.length > 2_048) return invalid(`${itemPath}.url`, 'Expected at most 2048 characters');
          items.push({ label: item.label, url: url.href, ...(item.detail !== undefined ? { detail: item.detail } : {}) });
        }
        blocks.push({ type: 'links', ...(block.title !== undefined ? { title: block.title as string } : {}), items });
        continue;
      }
    }
    blocks.push(block as BoardReportBlock);
  }
  return { report: { blocks } };
}

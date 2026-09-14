import type { SessionRenderToolCard, SessionRenderToolStatusKind } from '../../../types/session/tool-card';
import type {
  ToolActivityTone,
  ToolActivityTrailingLabel,
  ToolActivityViewModel,
} from '../tool-activity-view-model';
import { extractToolResultContentBlockText, parseToolResultJson } from './result-content';

type SearchToolKind = 'read' | 'grep' | 'glob' | 'list' | 'search' | 'find' | 'ripgrep';

type OutputArrayHint = 'path' | 'line' | 'result' | 'unknown';

interface SearchToolQuery {
  file?: string;
  path?: string;
  pattern?: string;
  query?: string;
  glob?: string;
  type?: string;
  outputMode?: string;
  headLimit?: string;
  offset?: string;
}

interface SearchOutputSummary {
  count: number | null;
  paths: string[];
  hitLines: string[];
  contentLines: string[];
  resultItems: string[];
  hasOutput: boolean;
}

const MAX_LIST_ITEMS = 40;
const MAX_TEXT_LINES = 80;
const MAX_TITLE_VALUE_LENGTH = 80;

const INPUT_WRAPPER_KEYS = ['input', 'arguments', 'args', 'parameters', 'params'];
const COUNT_KEYS = ['count', 'matchCount', 'match_count', 'total', 'totalCount', 'total_count', 'numMatches', 'num_matches'];
const PATH_ARRAY_KEYS = ['paths', 'pathList', 'path_list', 'files', 'filePaths', 'file_paths', 'matchingFiles', 'matching_files'];
const LINE_ARRAY_KEYS = ['lines', 'lineMatches', 'line_matches', 'matches', 'matchLines', 'match_lines'];
const RESULT_ARRAY_KEYS = ['result', 'results', 'items', 'entries'];
const NESTED_OUTPUT_KEYS = ['data', 'output', 'response', 'body'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStructuredText(text: string | null | undefined): unknown {
  return parseToolResultJson(text);
}

function shortText(value: string, maxLength: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function readScalarText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || null;
  }
  if (isFiniteNumber(value) || typeof value === 'boolean') {
    return String(value);
  }
  if (isStringArray(value)) {
    const items = value.map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items.join(', ') : null;
  }
  return null;
}

function addInputCandidate(candidates: unknown[], value: unknown, depth: number): void {
  if (value == null || depth > 2) {
    return;
  }
  candidates.push(value);

  if (typeof value === 'string') {
    const parsed = parseStructuredText(value);
    if (parsed != null) {
      addInputCandidate(candidates, parsed, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of INPUT_WRAPPER_KEYS) {
    if (key in value) {
      addInputCandidate(candidates, value[key], depth + 1);
    }
  }
}

function collectInputCandidates(tool: SessionRenderToolCard): unknown[] {
  const candidates: unknown[] = [];
  addInputCandidate(candidates, tool.input, 0);
  if (tool.inputText) {
    addInputCandidate(candidates, tool.inputText, 0);
  }
  return candidates;
}

function readField(candidates: unknown[], keys: string[]): string | null {
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const key of keys) {
      if (!(key in candidate)) {
        continue;
      }
      const text = readScalarText(candidate[key]);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function readSearchToolQuery(tool: SessionRenderToolCard): SearchToolQuery {
  const candidates = collectInputCandidates(tool);
  return {
    file: readField(candidates, ['file_path', 'filePath', 'file']) ?? undefined,
    path: readField(candidates, ['path', 'cwd', 'root']) ?? undefined,
    pattern: readField(candidates, ['pattern']) ?? undefined,
    query: readField(candidates, ['query']) ?? undefined,
    glob: readField(candidates, ['glob']) ?? undefined,
    type: readField(candidates, ['type']) ?? undefined,
    outputMode: readField(candidates, ['output_mode', 'outputMode']) ?? undefined,
    headLimit: readField(candidates, ['head_limit', 'headLimit']) ?? undefined,
    offset: readField(candidates, ['offset']) ?? undefined,
  };
}

function normalizeToolTokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function resolveSearchToolKind(name: string): SearchToolKind | null {
  const normalized = name.trim().toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  const tokens = normalizeToolTokens(name);
  const lastToken = tokens[tokens.length - 1] ?? '';

  if (compact === 'rg' || tokens.includes('ripgrep') || tokens.includes('rg')) return 'ripgrep';
  if (compact === 'grep' || tokens.includes('grep')) return 'grep';
  if (compact === 'glob' || tokens.includes('glob')) return 'glob';
  if (compact === 'ls' || lastToken === 'ls') return 'list';
  if (compact === 'list' || lastToken === 'list' || (tokens.includes('list') && tokens.includes('directory'))) return 'list';
  if (compact === 'read' || lastToken === 'read' || (tokens.includes('read') && tokens.includes('file'))) return 'read';
  if (compact === 'find' || lastToken === 'find') return 'find';
  if (compact === 'search' || lastToken === 'search') return 'search';

  return null;
}

export function canRenderSearchToolActivity(tool: SessionRenderToolCard): boolean {
  return resolveSearchToolKind(tool.name) != null || resolveSearchToolKind(tool.displayTitle) != null;
}

function resolveToolKind(tool: SessionRenderToolCard): SearchToolKind {
  return resolveSearchToolKind(tool.name) ?? resolveSearchToolKind(tool.displayTitle) ?? 'search';
}

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function resolveTone(status: SessionRenderToolStatusKind): ToolActivityTone {
  if (status === 'running') return 'running';
  if (status === 'error') return 'danger';
  if (status === 'missing_result') return 'muted';
  return 'neutral';
}

function buildTitle(kind: SearchToolKind, query: SearchToolQuery): string {
  const file = query.file ?? query.path;
  const needle = query.pattern ?? query.query ?? query.glob;

  if (kind === 'read') {
    return `读取 ${shortText(file ?? '文件', MAX_TITLE_VALUE_LENGTH)}`;
  }
  if (kind === 'glob') {
    return '列出匹配文件';
  }
  if (kind === 'list') {
    return file ? `列出 ${shortText(file, MAX_TITLE_VALUE_LENGTH)}` : '列出文件';
  }
  return `搜索 ${shortText(needle ?? '内容', MAX_TITLE_VALUE_LENGTH)}`;
}

function appendCondition(lines: string[], label: string, value?: string): void {
  if (value) {
    lines.push(`${label}：${value}`);
  }
}

function formatQueryConditions(query: SearchToolQuery): string {
  const lines: string[] = [];
  appendCondition(lines, '文件', query.file);
  if (query.path !== query.file) appendCondition(lines, '路径', query.path);
  appendCondition(lines, '模式', query.pattern);
  appendCondition(lines, '查询', query.query);
  appendCondition(lines, 'Glob', query.glob);
  appendCondition(lines, '类型', query.type);
  appendCondition(lines, '输出模式', query.outputMode);
  appendCondition(lines, '数量上限', query.headLimit);
  appendCondition(lines, '偏移', query.offset);
  return lines.join('\n');
}

function resultText(tool: SessionRenderToolCard): string {
  const result = tool.result;
  if (result.kind === 'text' || result.kind === 'json') {
    return result.bodyText.trim() || result.collapsedPreview.trim();
  }
  if (result.kind === 'canvas') {
    return result.rawText?.trim() || result.collapsedPreview.trim();
  }
  return '';
}

function looksLikePath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (/^\.\.?[\\/]/.test(trimmed)) return true;
  if (/[\\/]/.test(trimmed)) return true;
  if (/^[^\s]+\.[a-zA-Z0-9_-]{1,12}$/.test(trimmed)) return true;
  return false;
}

function looksLikeHitLine(text: string): boolean {
  return /^.+:\d+(?::\d+)?:/.test(text.trim());
}

function extractPathFromHitLine(text: string): string | null {
  const match = text.trim().match(/^(.+):\d+(?::\d+)?:/);
  return match?.[1]?.trim() || null;
}

function parseCountLine(text: string): { path: string; count: number } | null {
  const match = text.trim().match(/^(.+):(\d+)$/);
  if (!match) {
    return null;
  }
  const path = match[1].trim();
  const count = Number(match[2]);
  if (!looksLikePath(path) || !Number.isFinite(count)) {
    return null;
  }
  return { path, count };
}

function pushUnique(items: string[], value: string | null | undefined): void {
  const text = value?.trim();
  if (!text || items.includes(text)) {
    return;
  }
  items.push(text);
}

function readRecordText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (key in record) {
      const text = readScalarText(record[key]);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function readRecordNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (!(key in record)) {
      continue;
    }
    const value = record[key];
    if (isFiniteNumber(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const number = Number(value.trim());
      if (Number.isFinite(number)) {
        return number;
      }
    }
  }
  return null;
}

function collectDisplayText(summary: SearchOutputSummary, text: string, kind: SearchToolKind, hint: OutputArrayHint): void {
  const line = text.trim();
  if (!line) {
    return;
  }

  const countLine = parseCountLine(line);
  if (countLine) {
    pushUnique(summary.paths, countLine.path);
    pushUnique(summary.resultItems, `${countLine.path}：${countLine.count}`);
    summary.count = (summary.count ?? 0) + countLine.count;
    return;
  }

  if (hint === 'path' || ((kind === 'glob' || kind === 'list') && looksLikePath(line))) {
    pushUnique(summary.paths, line);
    return;
  }

  if (looksLikeHitLine(line)) {
    pushUnique(summary.hitLines, line);
    pushUnique(summary.paths, extractPathFromHitLine(line));
    return;
  }

  if (kind === 'read' || hint === 'line') {
    pushUnique(summary.contentLines, line);
    return;
  }

  if (looksLikePath(line)) {
    pushUnique(summary.paths, line);
    return;
  }

  pushUnique(summary.resultItems, line);
}

function describeRecordItem(record: Record<string, unknown>): { text: string; hint: OutputArrayHint } | null {
  const path = readRecordText(record, ['path', 'file_path', 'filePath', 'file', 'filename', 'name']);
  const lineNumber = readRecordText(record, ['line', 'lineNumber', 'line_number']);
  const columnNumber = readRecordText(record, ['column', 'columnNumber', 'column_number']);
  const text = readRecordText(record, ['text', 'content', 'lineText', 'line_text', 'match', 'preview', 'snippet']);
  const count = readRecordNumber(record, COUNT_KEYS);

  if (path && lineNumber && text) {
    const location = columnNumber ? `${path}:${lineNumber}:${columnNumber}` : `${path}:${lineNumber}`;
    return { text: `${location}: ${text}`, hint: 'line' };
  }
  if (path && count != null) {
    return { text: `${path}：${count}`, hint: 'result' };
  }
  if (path) {
    return { text: path, hint: 'path' };
  }
  if (text) {
    return { text, hint: 'line' };
  }
  return null;
}

function collectArray(summary: SearchOutputSummary, value: unknown[], kind: SearchToolKind, hint: OutputArrayHint): void {
  for (const item of value) {
    if (typeof item === 'string') {
      collectDisplayText(summary, item, kind, hint);
      continue;
    }
    if (isFiniteNumber(item) || typeof item === 'boolean') {
      collectDisplayText(summary, String(item), kind, hint);
      continue;
    }
    if (isRecord(item)) {
      const described = describeRecordItem(item);
      if (described) {
        collectDisplayText(summary, described.text, kind, described.hint === 'unknown' ? hint : described.hint);
      }
    }
  }
}

function collectRecordArrays(summary: SearchOutputSummary, record: Record<string, unknown>, keys: string[], kind: SearchToolKind, hint: OutputArrayHint): void {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      collectArray(summary, value, kind, hint);
    }
  }
}

function collectStructuredOutput(summary: SearchOutputSummary, value: unknown, kind: SearchToolKind, depth = 0): void {
  if (value == null || depth > 2) {
    return;
  }

  summary.hasOutput = true;

  if (typeof value === 'string') {
    const parsed = parseStructuredText(value);
    if (parsed != null) {
      collectStructuredOutput(summary, parsed, kind, depth + 1);
    } else {
      collectTextOutput(summary, value, kind, null);
    }
    return;
  }

  const contentBlockText = extractToolResultContentBlockText(value);
  if (contentBlockText) {
    const parsed = parseStructuredText(contentBlockText);
    if (parsed != null) {
      collectStructuredOutput(summary, parsed, kind, depth + 1);
    } else {
      collectTextOutput(summary, contentBlockText, kind, null);
    }
    return;
  }

  if (Array.isArray(value)) {
    collectArray(summary, value, kind, 'result');
    return;
  }

  if (!isRecord(value)) {
    collectDisplayText(summary, String(value), kind, 'result');
    return;
  }

  const count = readRecordNumber(value, COUNT_KEYS);
  if (count != null) {
    summary.count = count;
  }

  const described = describeRecordItem(value);
  if (described) {
    collectDisplayText(summary, described.text, kind, described.hint);
  }

  collectRecordArrays(summary, value, PATH_ARRAY_KEYS, kind, 'path');
  collectRecordArrays(summary, value, LINE_ARRAY_KEYS, kind, 'line');
  collectRecordArrays(summary, value, RESULT_ARRAY_KEYS, kind, 'result');

  for (const key of NESTED_OUTPUT_KEYS) {
    if (key in value) {
      collectStructuredOutput(summary, value[key], kind, depth + 1);
    }
  }
}

function splitOutputLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function collectTextOutput(summary: SearchOutputSummary, text: string, kind: SearchToolKind, outputMode: string | null): void {
  const lines = splitOutputLines(text);
  if (lines.length === 0) {
    return;
  }

  summary.hasOutput = true;

  if (kind === 'read') {
    for (const line of lines) {
      collectDisplayText(summary, line, kind, 'line');
    }
    return;
  }

  const countRows = lines.map(parseCountLine).filter((item): item is { path: string; count: number } => item != null);
  if (outputMode === 'count' || (countRows.length > 0 && countRows.length === lines.length)) {
    for (const row of countRows) {
      pushUnique(summary.paths, row.path);
      pushUnique(summary.resultItems, `${row.path}：${row.count}`);
    }
    summary.count = countRows.reduce((total, row) => total + row.count, 0);
    return;
  }

  const hitLineCount = lines.filter(looksLikeHitLine).length;
  const pathLineCount = lines.filter(looksLikePath).length;
  const pathOnly = pathLineCount > 0 && pathLineCount >= lines.length * 0.6 && hitLineCount === 0;

  for (const line of lines) {
    if (pathOnly) {
      collectDisplayText(summary, line, kind, 'path');
    } else {
      collectDisplayText(summary, line, kind, 'result');
    }
  }
}

function buildOutputSummary(tool: SessionRenderToolCard, kind: SearchToolKind, query: SearchToolQuery): SearchOutputSummary {
  const summary: SearchOutputSummary = {
    count: null,
    paths: [],
    hitLines: [],
    contentLines: [],
    resultItems: [],
    hasOutput: false,
  };

  collectStructuredOutput(summary, tool.output, kind);

  const text = resultText(tool);
  if (text) {
    const parsed = parseStructuredText(text);
    if (parsed != null) {
      collectStructuredOutput(summary, parsed, kind);
    } else {
      collectTextOutput(summary, text, kind, query.outputMode ?? null);
    }
  }

  return summary;
}

function formatTruncated(items: string[], itemName: string, limit: number): string {
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  if (remaining <= 0) {
    return visible.join('\n');
  }
  return `${visible.join('\n')}\n… 余下 ${remaining} ${itemName}`;
}

function buildTrailingLabels(tool: SessionRenderToolCard, summary: SearchOutputSummary, title: string): ToolActivityTrailingLabel[] {
  const labels: ToolActivityTrailingLabel[] = [];
  if (tool.status === 'running' && title !== '运行中') {
    labels.push({ text: '运行中', tone: 'muted' });
  }
  if (tool.status === 'missing_result' && title !== '无结果') {
    labels.push({ text: '无结果', tone: 'muted' });
  }
  if (summary.count != null) {
    labels.push({ text: `${summary.count} 处命中`, tone: 'muted' });
  } else if (summary.paths.length > 0) {
    labels.push({ text: `${summary.paths.length} 个路径`, tone: 'muted' });
  } else if (summary.hitLines.length > 0) {
    labels.push({ text: `${summary.hitLines.length} 行命中`, tone: 'muted' });
  } else if (summary.contentLines.length > 0) {
    labels.push({ text: `${summary.contentLines.length} 行`, tone: 'muted' });
  }

  const durationLabel = formatDuration(tool.durationMs);
  if (durationLabel) {
    labels.push({ text: durationLabel, tone: 'muted' });
  }
  return labels;
}

function appendOutputBlocks(blocks: ToolActivityViewModel['textBlocks'], kind: SearchToolKind, summary: SearchOutputSummary): void {
  if (summary.paths.length > 0) {
    blocks.push({
      kind: 'output',
      title: '路径列表',
      text: formatTruncated(summary.paths, '项', MAX_LIST_ITEMS),
      copyable: false,
    });
  }

  const hitSummary = [
    summary.count != null ? `命中数：${summary.count}` : null,
    summary.hitLines.length > 0 ? formatTruncated(summary.hitLines, '行', MAX_TEXT_LINES) : null,
    summary.resultItems.length > 0 ? formatTruncated(summary.resultItems, '项', MAX_LIST_ITEMS) : null,
  ].filter((item): item is string => item != null && item.trim().length > 0).join('\n');

  if (hitSummary) {
    blocks.push({
      kind: 'output',
      title: '命中摘要',
      text: hitSummary,
      copyable: false,
    });
  }

  if (summary.contentLines.length > 0) {
    blocks.push({
      kind: 'output',
      title: kind === 'read' ? '读取内容' : '输出',
      text: formatTruncated(summary.contentLines, '行', MAX_TEXT_LINES),
      copyable: false,
    });
  }

  if (summary.hasOutput && summary.paths.length === 0 && !hitSummary && summary.contentLines.length === 0) {
    blocks.push({
      kind: 'notice',
      text: '工具已返回输出，未识别为路径或命中列表。',
      copyable: false,
    });
  }
}

export function renderSearchToolActivity(tool: SessionRenderToolCard): ToolActivityViewModel {
  const kind = resolveToolKind(tool);
  const query = readSearchToolQuery(tool);
  const title = buildTitle(kind, query);
  const summary = buildOutputSummary(tool, kind, query);
  const textBlocks: ToolActivityViewModel['textBlocks'] = [];
  const queryConditions = formatQueryConditions(query);

  if (queryConditions) {
    textBlocks.push({
      kind: 'input',
      title: '查询条件',
      text: queryConditions,
      copyable: false,
    });
  }

  appendOutputBlocks(textBlocks, kind, summary);

  return {
    title,
    tone: resolveTone(tool.status),
    isRunning: tool.status === 'running',
    isError: tool.status === 'error',
    canExpand: textBlocks.length > 0,
    trailingLabels: buildTrailingLabels(tool, summary, title),
    textBlocks,
  };
}

export function searchToolActivityRenderer(tool: SessionRenderToolCard): ToolActivityViewModel | null {
  if (!canRenderSearchToolActivity(tool)) {
    return null;
  }
  return renderSearchToolActivity(tool);
}

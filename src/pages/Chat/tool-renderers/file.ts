import type { SessionRenderToolCard, SessionRenderToolStatusKind } from '../../../types/session/tool-card';
import type { ToolActivityTone, ToolActivityViewModel } from '../tool-activity-view-model';
import { extractToolResultContentBlockText, parseToolResultJson } from './result-content';

type FileOperation = 'create' | 'update';

interface DiffStat {
  additions: number;
  deletions: number;
}

interface DiffScan extends DiffStat {
  fileCount: number;
  filePaths: string[];
}

interface FileToolProjection {
  filePath: string | null;
  operation: FileOperation;
  content: string | null;
  originalContent: string | null;
  diffText: string | null;
  diffScan: DiffScan | null;
  providedDiffStat: DiffStat | null;
  outputText: string | null;
}

const FILE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'filewrite',
  'fileedit',
]);

const MAX_EXPANDED_TEXT_LENGTH = 6000;
const MAX_DIFF_FILE_LIST_LENGTH = 20;

type JsonRecord = Record<string, unknown>;
type ToolCardWithDetails = SessionRenderToolCard & { details?: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.trim()) {
      return field.trim();
    }
  }
  return null;
}

function readRawStringField(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string') {
      return field;
    }
  }
  return null;
}

function readNumberField(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const field = value[key];
    const numberValue = typeof field === 'number'
      ? field
      : typeof field === 'string' && field.trim()
        ? Number(field)
        : NaN;
    if (Number.isFinite(numberValue) && numberValue >= 0) {
      return Math.trunc(numberValue);
    }
  }
  return null;
}

function parseStructuredText(text: string | undefined): unknown {
  return parseToolResultJson(text);
}

function readToolResultValue(tool: SessionRenderToolCard): unknown {
  if (tool.output != null) {
    return tool.output;
  }
  if (tool.result.kind === 'json') {
    return parseStructuredText(tool.result.bodyText);
  }
  if (tool.result.kind === 'canvas' && tool.result.rawText) {
    return parseStructuredText(tool.result.rawText);
  }
  return null;
}

function readPlainResultText(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) {
    return null;
  }
  const structuredValue = parseToolResultJson(trimmed);
  if (structuredValue !== null) {
    return extractToolResultContentBlockText(structuredValue);
  }
  return trimmed;
}

function readResultText(tool: SessionRenderToolCard): string | null {
  const outputText = extractToolResultContentBlockText(tool.output);
  if (outputText) {
    return outputText;
  }
  if (tool.result.kind === 'text' || tool.result.kind === 'json') {
    return readPlainResultText(tool.result.bodyText)
      ?? readPlainResultText(tool.result.collapsedPreview);
  }
  if (tool.result.kind === 'canvas') {
    return readPlainResultText(tool.result.rawText)
      ?? readPlainResultText(tool.result.collapsedPreview);
  }
  return null;
}

function basename(path: string | null): string {
  if (!path) {
    return '文件';
  }
  return path.replace(/[\\/]+$/g, '').split(/[\\/]/).pop() || path;
}

function readOperationFrom(value: unknown): FileOperation | null {
  const operation = readStringField(value, ['type', 'operation']);
  if (!operation) {
    return null;
  }
  const normalized = operation.toLowerCase();
  if (normalized === 'create' || normalized === 'created' || normalized === 'write') {
    return 'create';
  }
  if (normalized === 'update' || normalized === 'updated' || normalized === 'edit') {
    return 'update';
  }
  return null;
}

function inferOperation(toolName: string, projection: FileToolProjection): FileOperation {
  const normalized = toolName.toLowerCase();
  if (normalized.includes('create')) {
    return 'create';
  }
  if (!projection.diffText && normalized.includes('write')) {
    return 'create';
  }
  return 'update';
}

function normalizeToolName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function readPathFrom(value: unknown): string | null {
  return readStringField(value, ['file_path', 'filePath', 'path']);
}

function readPathFromResultText(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(/\b(?:to|at)\s+(.+)$/i);
  const path = match?.[1]?.trim().replace(/^["'`]|["'`]$/g, '') ?? '';
  return path || null;
}

function readContentFrom(value: unknown): string | null {
  return readRawStringField(value, ['content', 'newContent']);
}

function readOriginalContentFrom(value: unknown): string | null {
  return readRawStringField(value, ['originalFile', 'originalContent', 'oldContent', 'fileContent']);
}

function readStructuredPatchLines(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  if (Array.isArray(value.lines)) {
    return value.lines.filter((line): line is string => typeof line === 'string');
  }
  const line = readStringField(value, ['text', 'line', 'content']);
  return line ? [line] : [];
}

function readDirectDiffFrom(value: unknown): string | null {
  return readStringField(value, ['diff', 'patch']);
}

function readDirectDiffStatFrom(value: unknown): DiffStat | null {
  const additions = readNumberField(value, ['additions', 'added']);
  const deletions = readNumberField(value, ['deletions', 'removed']);
  if (additions == null && deletions == null) {
    return null;
  }
  return {
    additions: additions ?? 0,
    deletions: deletions ?? 0,
  };
}

function readDiffStatFrom(value: unknown): DiffStat | null {
  if (!isRecord(value)) {
    return null;
  }
  return readDirectDiffStatFrom(value)
    ?? readDirectDiffStatFrom(value.liveDiffStat)
    ?? readDirectDiffStatFrom(value.diffStat)
    ?? readDirectDiffStatFrom(value.stat);
}

function buildStringReplacementDiff(value: unknown): string | null {
  const oldString = readRawStringField(value, ['old_string', 'oldString']);
  const newString = readRawStringField(value, ['new_string', 'newString']);
  if (oldString == null || newString == null) {
    return null;
  }
  const oldLines = oldString.split(/\r\n|\r|\n/).map((line) => `-${line}`);
  const newLines = newString.split(/\r\n|\r|\n/).map((line) => `+${line}`);
  return [...oldLines, ...newLines].join('\n');
}

function readDiffFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const direct = readDirectDiffFrom(value);
  if (direct) {
    return direct;
  }
  const gitDiff = value.gitDiff;
  if (typeof gitDiff === 'string' && gitDiff.trim()) {
    return gitDiff.trim();
  }
  const gitPatch = readStringField(gitDiff, ['patch', 'diff']);
  if (gitPatch) {
    return gitPatch;
  }
  const structuredPatch = value.structuredPatch;
  if (typeof structuredPatch === 'string' && structuredPatch.trim()) {
    return structuredPatch.trim();
  }
  if (!Array.isArray(structuredPatch)) {
    return null;
  }
  const lines = structuredPatch.flatMap(readStructuredPatchLines);
  return lines.length > 0 ? lines.join('\n') : null;
}

function buildWriteDiffPreview(content: string): string | null {
  if (!content) {
    return null;
  }
  const normalized = content.replace(/\r\n|\r/g, '\n');
  const lines = (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
  return lines.length > 0 ? lines.map((line) => `+${line}`).join('\n') : null;
}

function normalizeDiffPath(path: string | null): string | null {
  const value = path?.trim().replace(/^["']|["']$/g, '').split('\t')[0]?.trim() ?? '';
  if (!value || value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '');
}

function readGitDiffPath(line: string): string | null {
  const quotedTargetIndex = line.indexOf(' "b/');
  if (quotedTargetIndex >= 0) {
    return normalizeDiffPath(line.slice(quotedTargetIndex + 2));
  }
  const targetIndex = line.indexOf(' b/');
  if (targetIndex >= 0) {
    return normalizeDiffPath(line.slice(targetIndex + 1));
  }
  const parts = line.trim().split(/\s+/);
  return normalizeDiffPath(parts[parts.length - 1] ?? null);
}

function pushUniquePath(paths: string[], seen: Set<string>, path: string | null): void {
  if (!path || seen.has(path)) {
    return;
  }
  seen.add(path);
  paths.push(path);
}

function scanDiffText(diffText: string | null): DiffScan | null {
  if (!diffText) {
    return null;
  }

  let additions = 0;
  let deletions = 0;
  let gitFileCount = 0;
  let unifiedFileCount = 0;
  let pendingOldPath: string | null = null;
  const gitFilePaths: string[] = [];
  const unifiedFilePaths: string[] = [];
  const seenGitFilePaths = new Set<string>();
  const seenUnifiedFilePaths = new Set<string>();

  for (let start = 0; start <= diffText.length;) {
    const newlineIndex = diffText.indexOf('\n', start);
    const end = newlineIndex === -1 ? diffText.length : newlineIndex;
    let line = diffText.slice(start, end);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    if (line.startsWith('diff --git ')) {
      gitFileCount += 1;
      pushUniquePath(gitFilePaths, seenGitFilePaths, readGitDiffPath(line));
      pendingOldPath = null;
    } else if (line.startsWith('--- ')) {
      pendingOldPath = normalizeDiffPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      if (pendingOldPath) {
        unifiedFileCount += 1;
        pushUniquePath(unifiedFilePaths, seenUnifiedFilePaths, normalizeDiffPath(line.slice(4)) ?? pendingOldPath);
      }
      pendingOldPath = null;
    } else {
      pendingOldPath = null;
      if (line.startsWith('+')) {
        additions += 1;
      } else if (line.startsWith('-')) {
        deletions += 1;
      }
    }

    if (newlineIndex === -1) {
      break;
    }
    start = newlineIndex + 1;
  }

  const filePaths = gitFileCount > 0 ? gitFilePaths : unifiedFilePaths;
  const fileCount = gitFileCount > 0
    ? Math.max(gitFileCount, gitFilePaths.length)
    : Math.max(unifiedFileCount, unifiedFilePaths.length);

  return {
    additions,
    deletions,
    fileCount,
    filePaths,
  };
}

function buildProjection(tool: SessionRenderToolCard): FileToolProjection {
  const inputTextValue = parseStructuredText(tool.inputText);
  const outputValue = readToolResultValue(tool);
  const outputText = readResultText(tool);
  const detailsValue = (tool as ToolCardWithDetails).details;
  const filePath = readPathFrom(tool.input)
    ?? readPathFrom(inputTextValue)
    ?? readPathFrom(outputValue)
    ?? (tool.summary ? readPathFrom(parseStructuredText(tool.summary)) : null)
    ?? readPathFromResultText(outputText);
  const content = readContentFrom(outputValue) ?? readContentFrom(tool.input) ?? readContentFrom(inputTextValue);
  const originalContent = readOriginalContentFrom(outputValue);
  const explicitDiffText = readDiffFrom(detailsValue)
    ?? readDiffFrom(outputValue)
    ?? readDiffFrom(tool.input)
    ?? readDiffFrom(inputTextValue)
    ?? buildStringReplacementDiff(tool.input)
    ?? buildStringReplacementDiff(inputTextValue);
  const operation = readOperationFrom(outputValue) ?? readOperationFrom(tool.input) ?? readOperationFrom(inputTextValue);
  const projection: FileToolProjection = {
    filePath,
    operation: operation ?? 'update',
    content,
    originalContent,
    diffText: explicitDiffText,
    diffScan: scanDiffText(explicitDiffText),
    providedDiffStat: readDiffStatFrom(detailsValue)
      ?? readDiffStatFrom(outputValue)
      ?? readDiffStatFrom(tool.input)
      ?? readDiffStatFrom(inputTextValue),
    outputText,
  };
  if (!operation) {
    projection.operation = inferOperation(tool.name, projection);
  }
  if (!projection.diffText && projection.operation === 'create' && projection.content != null) {
    projection.diffText = buildWriteDiffPreview(projection.content);
    projection.diffScan = scanDiffText(projection.diffText);
  }
  return projection;
}

function countContentLines(content: string | null): number | null {
  if (content == null) {
    return null;
  }
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r\n|\r|\n/).length;
}

function truncateText(text: string): string {
  if (text.length <= MAX_EXPANDED_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_EXPANDED_TEXT_LENGTH).trimEnd()}\n…已截断`;
}

function resolveToolTone(status: SessionRenderToolStatusKind): ToolActivityTone {
  if (status === 'running') return 'running';
  if (status === 'error') return 'danger';
  if (status === 'missing_result') return 'muted';
  return 'neutral';
}

function buildTitle(projection: FileToolProjection): string {
  const verb = projection.operation === 'create' ? '写入' : '更新';
  const fileCount = projection.diffScan?.fileCount ?? 0;
  if (fileCount > 1) {
    return `${verb} ${fileCount} 个文件`;
  }
  return `${verb} ${basename(projection.filePath)}`;
}

function pushDiffStatLabels(labels: ToolActivityViewModel['trailingLabels'], stat: DiffStat | null): void {
  if (!stat) {
    return;
  }
  if (stat.additions > 0) {
    labels.push({ text: `+${stat.additions}`, tone: 'neutral' });
  }
  if (stat.deletions > 0) {
    labels.push({ text: `-${stat.deletions}`, tone: 'neutral' });
  }
}

function buildTrailingLabels(projection: FileToolProjection): ToolActivityViewModel['trailingLabels'] {
  const labels: ToolActivityViewModel['trailingLabels'] = [];
  const fileCount = projection.diffScan?.fileCount ?? 0;
  if (fileCount > 1) {
    labels.push({ text: `${fileCount} 个文件`, tone: 'muted' });
  }

  pushDiffStatLabels(labels, projection.providedDiffStat ?? projection.diffScan);
  if (labels.length > 0) {
    return labels;
  }

  if (projection.operation === 'create') {
    const lines = countContentLines(projection.content);
    return lines == null ? [] : [{ text: `+${lines}`, tone: 'neutral' }];
  }

  return [];
}

function buildDiffFileList(projection: FileToolProjection): string | null {
  const diffScan = projection.diffScan;
  if (!diffScan || diffScan.fileCount <= 1 || diffScan.filePaths.length === 0) {
    return null;
  }
  const filePaths = diffScan.filePaths.slice(0, MAX_DIFF_FILE_LIST_LENGTH);
  const omittedCount = Math.max(0, diffScan.fileCount - filePaths.length);
  return omittedCount > 0
    ? `${filePaths.join('\n')}\n…另 ${omittedCount} 个文件`
    : filePaths.join('\n');
}

function buildTextBlocks(projection: FileToolProjection): ToolActivityViewModel['textBlocks'] {
  const blocks: ToolActivityViewModel['textBlocks'] = [];
  const diffFileList = buildDiffFileList(projection);
  if (diffFileList) {
    blocks.push({
      kind: 'input',
      title: '文件',
      text: diffFileList,
      copyable: true,
    });
  } else if (projection.filePath) {
    blocks.push({
      kind: 'input',
      title: '路径',
      text: projection.filePath,
      copyable: true,
    });
  }
  const fileCount = projection.diffScan?.fileCount ?? 0;
  if (projection.diffText) {
    blocks.push({
      kind: 'output',
      title: fileCount > 1 ? `差异（${fileCount} 个文件）` : '差异',
      text: truncateText(projection.diffText),
      copyable: false,
    });
  } else if (projection.content != null) {
    blocks.push({
      kind: 'output',
      title: projection.operation === 'update' ? '更新内容' : '内容',
      text: truncateText(projection.content),
      copyable: false,
    });
  }
  if (projection.outputText && projection.outputText !== projection.content) {
    blocks.push({
      kind: 'output',
      title: '结果',
      text: truncateText(projection.outputText),
      copyable: false,
    });
  }
  return blocks;
}

export function isFileToolActivityName(name: string): boolean {
  const normalized = normalizeToolName(name);
  return FILE_TOOL_NAMES.has(normalized)
    || /^openclaw.*(create|update|write|edit).*file/.test(normalized)
    || /^openclaw.*file.*(create|update|write|edit)/.test(normalized);
}

export function buildFileToolActivityViewModel(tool: SessionRenderToolCard): ToolActivityViewModel {
  const projection = buildProjection(tool);
  const textBlocks = buildTextBlocks(projection);
  return {
    title: buildTitle(projection),
    tone: resolveToolTone(tool.status),
    isRunning: tool.status === 'running',
    isError: tool.status === 'error',
    canExpand: textBlocks.length > 0,
    trailingLabels: buildTrailingLabels(projection),
    textBlocks,
    diffStatPlacement: 'header',
  };
}

export const fileToolActivityRenderer = buildFileToolActivityViewModel;

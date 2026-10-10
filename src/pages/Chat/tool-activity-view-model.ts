import type { TFunction } from 'i18next';
import type {
  SessionRenderAssistantBubbleToolResult,
  SessionRenderToolCard,
} from '../../types/session/tool-card';
import { buildToolActivityViewModelFromRegistry } from './tool-renderers';
import {
  isOpenClawTool,
  readApprovalReviewOutcome,
  readApprovalReviews,
  readBrowserTabPreview,
  readMcpAppPreview,
  readProgressReceipt,
  readPublicDetailSummary,
  type OpenClawApprovalReview,
  type OpenClawApprovalReviewOutcome,
  type OpenClawBrowserTabPreview,
  type OpenClawPublicDetailValue,
} from './tool-renderers/openclaw-details';

export type ToolActivityTone = 'neutral' | 'running' | 'danger' | 'muted';
export type ToolActivityMetadataValue = string | number | boolean;
export type ToolActivityPublicDetailValue = OpenClawPublicDetailValue;

export interface ToolActivityTrailingLabel {
  text: string;
  tone: 'neutral' | 'muted';
}

export interface ToolActivityTextBlock {
  kind: 'input' | 'output' | 'notice' | 'details';
  title?: string;
  text: string;
  copyable: boolean;
}

export interface ToolActivityMcpAppMetadata {
  viewId?: string;
  serverName?: string;
  toolName?: string;
  uiResourceUri?: string;
  toolCallId?: string;
  originSessionKey?: string;
}

export type ToolActivityBrowserTabPreview = OpenClawBrowserTabPreview;
export type ToolActivityApprovalReview = OpenClawApprovalReview;

export interface ToolActivityApprovalReviewOutcome {
  label: string;
  status: OpenClawApprovalReviewOutcome;
}

export interface ToolActivityProgressReceipt {
  completedCount: number;
  totalCount: number;
  currentItem?: string;
  currentStatus?: 'pending' | 'in_progress' | 'completed';
  markdownSummary?: string;
}

export interface ToolActivityDiffStat {
  filesChanged?: string[];
  filesCreated?: string[];
  additions?: number;
  deletions?: number;
  fileCount?: number;
}

export interface ToolActivityViewModel {
  title: string;
  tone: ToolActivityTone;
  isRunning: boolean;
  isError: boolean;
  canExpand: boolean;
  trailingLabels: ToolActivityTrailingLabel[];
  textBlocks: ToolActivityTextBlock[];
  canvasPreview?: {
    title: string;
    url: string;
    preferredHeight?: number;
    rawText?: string;
    mcpApp?: ToolActivityMcpAppMetadata;
  };
  browserTabPreview?: ToolActivityBrowserTabPreview;
  approvalReviews?: ToolActivityApprovalReview[];
  approvalReviewOutcome?: ToolActivityApprovalReviewOutcome;
  progressReceipt?: ToolActivityProgressReceipt;
  publicDetails?: Record<string, ToolActivityPublicDetailValue>;
  diffStatPlacement?: 'header';
  diffStat?: ToolActivityDiffStat;
  liveDiffStat?: ToolActivityDiffStat;
}

export type ToolActivityContent = Omit<ToolActivityViewModel, 'tone' | 'isRunning' | 'isError'> & {
  hasOutputError?: boolean;
};

type JsonRecord = Record<string, unknown>;
type ToolActivityCanvasPreview = NonNullable<ToolActivityViewModel['canvasPreview']>;

const SPECIAL_PUBLIC_DETAIL_KEYS = new Set([
  'browserTab',
  'changed',
  'created',
  'diff',
  'patch',
  'approvalReviews',
  'approvalReviewOutcome',
  'mcpAppPreview',
  'truncation',
  'fullOutputPath',
  'exitCode',
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : undefined;
  return parsed !== undefined && Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

function readNumberField(value: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const field = readNumber(value[key]);
    if (field !== undefined) return field;
  }
  return undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map(readString)
    .filter((item): item is string => item !== undefined);
  return strings.length > 0 ? strings : undefined;
}

function uniqueStrings(values: ReadonlyArray<string[] | undefined>): string[] | undefined {
  const unique = new Set<string>();
  for (const list of values) {
    for (const value of list ?? []) unique.add(value);
  }
  return unique.size > 0 ? [...unique] : undefined;
}

function readPathListFromDiffValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return uniqueStrings(value.map(readPathListFromDiffValue));
  if (!isRecord(value)) return undefined;
  const path = readString(value.path) ?? readString(value.filePath) ?? readString(value.file);
  return path ? [path] : undefined;
}

function readDiffText(value: unknown): string | undefined {
  const text = readString(value);
  if (text) return text;
  if (!isRecord(value)) return undefined;
  return readString(value.diff) ?? readString(value.patch);
}

function countDiffLines(diffText: string | undefined): Pick<ToolActivityDiffStat, 'additions' | 'deletions'> | undefined {
  if (!diffText) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split(/\r\n|\r|\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}

function hasDiffStatContent(value: ToolActivityDiffStat): boolean {
  return (value.filesChanged?.length ?? 0) > 0
    || (value.filesCreated?.length ?? 0) > 0
    || value.fileCount !== undefined
    || value.additions !== undefined
    || value.deletions !== undefined;
}

function readExplicitDiffStat(value: unknown): ToolActivityDiffStat | undefined {
  if (!isRecord(value)) return undefined;
  const filesChanged = uniqueStrings([
    readStringList(value.filesChanged),
    readStringList(value.changedFiles),
    readStringList(value.files),
  ]);
  const filesCreated = readStringList(value.filesCreated) ?? readStringList(value.createdFiles);
  const stat: ToolActivityDiffStat = {
    filesChanged,
    filesCreated,
    fileCount: readNumberField(value, ['fileCount', 'filesChangedCount', 'changedFileCount']),
    additions: readNumberField(value, ['additions', 'added', 'insertions']),
    deletions: readNumberField(value, ['deletions', 'removed', 'deleted']),
  };
  return hasDiffStatContent(stat) ? stat : undefined;
}

function readInferredDiffStat(value: JsonRecord): ToolActivityDiffStat | undefined {
  const filesChanged = uniqueStrings([
    readStringList(value.changed),
    readPathListFromDiffValue(value.diff),
    readPathListFromDiffValue(value.patch),
  ]);
  const filesCreated = readStringList(value.created);
  const lineStat = countDiffLines(readDiffText(value.diff) ?? readDiffText(value.patch));
  const stat: ToolActivityDiffStat = {
    filesChanged,
    filesCreated,
    additions: lineStat?.additions,
    deletions: lineStat?.deletions,
  };
  return hasDiffStatContent(stat) ? stat : undefined;
}

function readDiffStat(details: unknown): ToolActivityDiffStat | undefined {
  if (!isRecord(details)) return undefined;
  return readExplicitDiffStat(details.diffStat)
    ?? readExplicitDiffStat(details.stat)
    ?? readExplicitDiffStat(details)
    ?? readInferredDiffStat(details);
}

function readLiveDiffStat(details: unknown): ToolActivityDiffStat | undefined {
  if (!isRecord(details)) return undefined;
  return readExplicitDiffStat(details.liveDiffStat);
}

function readCanvasPreview(details: unknown): ToolActivityCanvasPreview | undefined {
  const preview = readMcpAppPreview(details);
  if (!preview?.url) return undefined;
  return {
    title: preview.title ?? preview.mcpApp?.toolName ?? 'MCP App',
    url: preview.url,
    preferredHeight: preview.preferredHeight,
    mcpApp: preview.mcpApp,
  };
}

function readPublicDetails(details: unknown): Record<string, ToolActivityPublicDetailValue> | undefined {
  const summary = readPublicDetailSummary(details);
  if (!summary) return undefined;
  const publicDetails: Record<string, ToolActivityPublicDetailValue> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (SPECIAL_PUBLIC_DETAIL_KEYS.has(key)) continue;
    publicDetails[key] = value as ToolActivityPublicDetailValue;
  }
  return Object.keys(publicDetails).length > 0 ? publicDetails : undefined;
}

function readReviewOutcome(details: unknown, t: TFunction<'chat'>): ToolActivityApprovalReviewOutcome | undefined {
  const status = readApprovalReviewOutcome(details);
  return status ? { label: t('toolActivity.result'), status } : undefined;
}

function readProgressView(tool: SessionRenderToolCard): ToolActivityProgressReceipt | undefined {
  const receipt = readProgressReceipt(tool);
  if (!receipt) return undefined;
  if (receipt.total === 0 && !receipt.currentLabel && !receipt.markdown) return undefined;
  return {
    completedCount: receipt.completed,
    totalCount: receipt.total,
    currentItem: receipt.currentLabel,
    currentStatus: receipt.currentStatus,
    markdownSummary: receipt.markdown,
  };
}

function progressTextBlocks(receipt: ToolActivityProgressReceipt, t: TFunction<'chat'>): ToolActivityTextBlock[] {
  const lines = [`${receipt.completedCount}/${receipt.totalCount}`];
  if (receipt.currentItem) lines.push(t('toolActivity.currentItem', { name: receipt.currentItem }));
  if (receipt.markdownSummary) lines.push(receipt.markdownSummary);
  return [{ kind: 'notice', title: t('toolActivity.progress'), text: lines.join('\n'), copyable: false }];
}

function mergeCanvasPreview(
  base: ToolActivityCanvasPreview | undefined,
  details: ToolActivityCanvasPreview | undefined,
): ToolActivityCanvasPreview | undefined {
  if (!details) return base;
  if (!base) return details;
  return {
    title: details.title,
    url: details.url,
    preferredHeight: details.preferredHeight ?? base.preferredHeight,
    rawText: base.rawText,
    mcpApp: details.mcpApp,
  };
}

function hasStructuredProjection(input: {
  canvasPreview?: ToolActivityCanvasPreview;
  browserTabPreview?: ToolActivityBrowserTabPreview;
  approvalReviews: ToolActivityApprovalReview[];
  approvalReviewOutcome?: ToolActivityApprovalReviewOutcome;
  progressReceipt?: ToolActivityProgressReceipt;
  publicDetails?: Record<string, ToolActivityPublicDetailValue>;
  diffStat?: ToolActivityDiffStat;
  liveDiffStat?: ToolActivityDiffStat;
}): boolean {
  return input.canvasPreview != null
    || input.browserTabPreview != null
    || input.approvalReviews.length > 0
    || input.approvalReviewOutcome != null
    || input.progressReceipt != null
    || input.publicDetails != null
    || input.diffStat != null
    || input.liveDiffStat != null;
}

function mergeOpenClawDetails(tool: SessionRenderToolCard, viewModel: ToolActivityViewModel, t: TFunction<'chat'>): ToolActivityViewModel {
  const canvasPreview = readCanvasPreview(tool.details);
  const browserTabPreview = readBrowserTabPreview(tool.details);
  const approvalReviews = readApprovalReviews(tool.details);
  const approvalReviewOutcome = readReviewOutcome(tool.details, t);
  const progressReceipt = readProgressView(tool);
  const publicDetails = readPublicDetails(tool.details);
  const diffStat = readDiffStat(tool.details);
  const liveDiffStat = readLiveDiffStat(tool.details);
  const textBlocks = progressReceipt ? progressTextBlocks(progressReceipt, t) : viewModel.textBlocks;
  const mergedCanvasPreview = mergeCanvasPreview(viewModel.canvasPreview, canvasPreview);
  const hasStructured = hasStructuredProjection({
    canvasPreview: mergedCanvasPreview,
    browserTabPreview,
    approvalReviews,
    approvalReviewOutcome,
    progressReceipt,
    publicDetails,
    diffStat,
    liveDiffStat,
  });

  return {
    ...viewModel,
    title: progressReceipt ? t('toolActivity.progress') : viewModel.title,
    textBlocks,
    canvasPreview: mergedCanvasPreview,
    canExpand: textBlocks.length > 0 || hasStructured,
    ...(browserTabPreview ? { browserTabPreview } : {}),
    ...(approvalReviews.length > 0 ? { approvalReviews } : {}),
    ...(approvalReviewOutcome ? { approvalReviewOutcome } : {}),
    ...(progressReceipt ? { progressReceipt } : {}),
    ...(publicDetails ? { publicDetails } : {}),
    ...(diffStat ? { diffStat } : {}),
    ...(liveDiffStat ? { liveDiffStat } : {}),
  };
}

export function buildToolActivityViewModel(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityViewModel {
  const viewModel = buildToolActivityViewModelFromRegistry(tool, t);
  return isOpenClawTool(tool) ? mergeOpenClawDetails(tool, viewModel, t) : viewModel;
}

export function buildCanvasActivityViewModel(item: SessionRenderAssistantBubbleToolResult, t: TFunction<'chat'>): ToolActivityViewModel | null {
  if (item.preview.kind !== 'canvas') {
    return null;
  }

  const rawText = item.rawText?.trim() ?? '';
  return {
    title: item.preview.title?.trim() || item.toolName,
    tone: 'neutral',
    isRunning: false,
    isError: false,
    canExpand: rawText.length > 0,
    trailingLabels: [{ text: t('toolActivity.canvas'), tone: 'muted' }],
    textBlocks: rawText ? [{ kind: 'output', text: rawText, copyable: false }] : [],
    canvasPreview: {
      title: item.preview.title?.trim() || item.toolName,
      url: item.preview.url,
      preferredHeight: item.preview.preferredHeight,
      rawText: rawText || undefined,
    },
  };
}

import type { TFunction } from 'i18next';
import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type {
  ToolActivityApprovalReview,
  ToolActivityApprovalReviewOutcome,
  ToolActivityBrowserTabPreview,
  ToolActivityContent,
  ToolActivityDiffStat,
  ToolActivityProgressReceipt,
  ToolActivityPublicDetailValue,
  ToolActivityTextBlock,
} from '../tool-activity-view-model';
import {
  readApprovalReviewOutcome,
  readApprovalReviews,
  readBrowserTabPreview,
  readMcpAppPreview,
  readProgressReceipt,
  readPublicDetailSummary,
  type OpenClawPublicDetailSummary,
} from './openclaw-details';

type JsonRecord = Record<string, unknown>;
type ToolActivityCanvasPreview = NonNullable<ToolActivityContent['canvasPreview']>;

const SPECIAL_PUBLIC_DETAIL_KEYS = new Set([
  'browserTab',
  'approvalReviews',
  'approvalReviewOutcome',
  'mcpAppPreview',
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

function readDiffStat(details: unknown): ToolActivityDiffStat | undefined {
  if (!isRecord(details)) return undefined;
  return readExplicitDiffStat(details.diffStat)
    ?? readExplicitDiffStat(details.stat)
    ?? readExplicitDiffStat(details);
}

function readLiveDiffStat(details: unknown): ToolActivityDiffStat | undefined {
  if (!isRecord(details)) return undefined;
  return readExplicitDiffStat(details.liveDiffStat);
}

function readCanvasPreview(details: unknown): ToolActivityCanvasPreview | undefined {
  const preview = readMcpAppPreview(details);
  if (!preview) return undefined;
  return {
    title: preview.title ?? (preview.kind === 'mcp-app' ? preview.mcpApp.toolName ?? 'MCP App' : 'Canvas'),
    surface: preview.surface,
    sandbox: preview.sandbox,
    boardWidgetName: preview.boardWidgetName,
    preferredHeight: preview.preferredHeight,
  };
}

function readPublicDetails(summary: OpenClawPublicDetailSummary | undefined): Record<string, ToolActivityPublicDetailValue> | undefined {
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
    ...base,
    ...details,
    preferredHeight: details.preferredHeight ?? base.preferredHeight,
    rawText: base.rawText,
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

export function mergeOpenClawDetails(tool: SessionRenderToolCard, content: ToolActivityContent, t: TFunction<'chat'>): ToolActivityContent {
  const canvasPreview = readCanvasPreview(tool.details);
  const browserTabPreview = tool.name === 'browser' && tool.status === 'completed' ? readBrowserTabPreview(tool.details) : undefined;
  const approvalReviews = readApprovalReviews(tool.details);
  const approvalReviewOutcome = readReviewOutcome(tool.details, t);
  const progressReceipt = readProgressView(tool);
  const publicSummary = readPublicDetailSummary(tool.details);
  const publicDetails = readPublicDetails(publicSummary);
  const succeeded = tool.status === 'completed' && content.hasOutputError !== true;
  const diffStat = succeeded ? content.diffStat ?? readDiffStat(tool.details) : undefined;
  const liveDiffStat = tool.status === 'running' ? content.liveDiffStat ?? readLiveDiffStat(tool.details) : undefined;
  const textBlocks = progressReceipt ? progressTextBlocks(progressReceipt, t) : [...content.textBlocks];
  if (!progressReceipt && publicSummary) {
    const lines: string[] = [];
    const truncation = publicSummary.truncation;
    if (truncation != null && truncation !== false && (typeof truncation !== 'string' || truncation.toLowerCase() !== 'false')) {
      lines.push(t('toolActivity.shell.truncated'));
    }
    if (publicSummary.fullOutputPath) lines.push(t('toolActivity.shell.fullOutputPath', { path: publicSummary.fullOutputPath }));
    if (lines.length > 0) textBlocks.push({ kind: 'notice', title: t('toolActivity.shell.outputDetails'), text: lines.join('\n'), copyable: false });
  }
  const result = tool.result;
  const resultCanvasPreview = result.kind === 'canvas'
    ? {
      title: result.preview.title?.trim() || tool.name,
      surface: result.preview.surface,
      preferredHeight: result.preview.preferredHeight,
      rawText: result.rawText?.trim(),
    }
    : undefined;
  const mergedCanvasPreview = mergeCanvasPreview(content.canvasPreview ?? resultCanvasPreview, canvasPreview);
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
    ...content,
    title: progressReceipt ? t('toolActivity.progress') : content.title,
    textBlocks,
    canvasPreview: mergedCanvasPreview,
    canExpand: content.canExpand || textBlocks.length > 0 || hasStructured || (content.parameters?.length ?? 0) > 0,
    canOpenSurface: browserTabPreview != null || readMcpAppPreview(tool.details) != null,
    ...(browserTabPreview ? { browserTabPreview } : {}),
    ...(approvalReviews.length > 0 ? { approvalReviews } : {}),
    ...(approvalReviewOutcome ? { approvalReviewOutcome } : {}),
    ...(progressReceipt ? { progressReceipt } : {}),
    ...(publicDetails ? { publicDetails } : {}),
    diffStat,
    liveDiffStat,
  };
}

export function buildOpenClawToolActivityPreviewContent(
  tool: SessionRenderToolCard,
  title: string,
  t: TFunction<'chat'>,
): ToolActivityContent | null {
  const details = isRecord(tool.details) ? tool.details : undefined;
  const browserTabPreview = tool.name === 'browser' && tool.status === 'completed' && details?.browserTab ? readBrowserTabPreview(details) : undefined;
  const approvalReviews = details?.approvalReviews ? readApprovalReviews(details) : [];
  const approvalReviewOutcome = details?.approvalReviewOutcome ? readReviewOutcome(details, t) : undefined;
  const mcpAppPreview = details?.mcpAppPreview ? readMcpAppPreview(details) : undefined;
  const progressReceipt = tool.name.trim().toLowerCase() === 'progress_card' ? readProgressView(tool) : undefined;
  if (!browserTabPreview && approvalReviews.length === 0 && !approvalReviewOutcome && !mcpAppPreview && !progressReceipt) return null;
  return {
    title: progressReceipt ? t('toolActivity.progress') : title,
    canExpand: approvalReviews.length > 0 || approvalReviewOutcome != null,
    canOpenSurface: browserTabPreview != null || mcpAppPreview != null,
    trailingLabels: [],
    textBlocks: [],
    ...(browserTabPreview ? { browserTabPreview } : {}),
    ...(mcpAppPreview ? { canvasPreview: readCanvasPreview(details) } : {}),
    ...(approvalReviews.length > 0 ? { approvalReviews } : {}),
    ...(approvalReviewOutcome ? { approvalReviewOutcome } : {}),
    ...(progressReceipt ? { progressReceipt } : {}),
  };
}

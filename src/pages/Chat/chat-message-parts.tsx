import { useCallback, useMemo, useRef, useState, memo, type MouseEvent, type PointerEvent } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, CornerDownLeft, SquareTerminal, Code2, FileText, FilePenLine, FilePlus2, Search, Globe, Wrench, ExternalLink, Film, Music, FileArchive, File, ZoomIn, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { invokeIpc } from '@/lib/api-client';
import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionRenderAssistantBubbleToolResult,
  SessionRenderToolCard,
} from '../../types/session/tool-card';
import type { SessionIdentity } from '../../types/desktop/runtime-address';
import type { ChatMessageImage } from './chat-message-view';
import { formatTimestamp } from './message-utils';
import { buildMarkdownCacheKey, getOrBuildMarkdownBody } from './md-pipeline';
import { DIRECTORY_MIME_TYPE } from '@/components/file-preview/types';
import { shouldKeepAssistantAttachmentVisible } from './artifact-paths';
import {
  buildCanvasActivityViewModel,
  buildToolActivityPreview,
  buildToolActivityViewModel,
  type ToolActivityTrailingLabel,
  type ToolActivityViewModel,
} from './tool-activity-view-model';
import { describeToolActivity, getToolActivityStatus, summarizeToolActivities } from './tool-renderers';
import type { ToolActivityDisclosure, ToolActivityKind } from './tool-renderers/types';
import { getToolDisclosureKey, getToolGroupDisclosureKey } from './chat-tool-groups';
import { useToolActivityDisclosure } from './useToolActivityDisclosure';
import ToolBrowserCard from './tool-browser-card';
import { ToolWidgetCard } from './tool-widget-card';

export interface MessageLightboxState {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
}

const COMPACT_SIDE_RAIL_EXPANDED_WIDTH = 'w-full max-w-[46rem]';
const COMPACT_SIDE_RAIL_TRACK = `${COMPACT_SIDE_RAIL_EXPANDED_WIDTH} flex max-w-full flex-col self-start`;
const COMPACT_SIDE_RAIL_HEADER = 'inline-flex max-w-full self-start items-center gap-1.5 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border/50';
const COMPACT_TEXT_BLOCK = 'w-full overflow-hidden rounded-[16px] border border-border/45 bg-muted/55';
const COMPACT_OUTPUT_SCROLL_AREA = 'max-h-72 overflow-auto overscroll-contain whitespace-pre-wrap break-words outline-none';
const COMPACT_ICON_TOGGLE = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:text-foreground';
const COMPACT_STRUCTURED_CARD = 'w-full overflow-hidden rounded-[16px] border border-border/45 bg-card px-3.5 py-3 shadow-sm';
const COMPACT_META_CHIP = 'inline-flex max-w-full items-center rounded-full border border-border/45 bg-muted/55 px-2 py-0.5 text-[11px] leading-4 text-muted-foreground';

function imageSrc(img: ChatMessageImage): string | null {
  if (img.url) return img.url;
  if (img.data) return `data:${img.mimeType};base64,${img.data}`;
  return null;
}

function useVersionedDisclosure(collapseVersion: number) {
  const [state, setState] = useState({ version: collapseVersion, expanded: false });
  const expanded = state.version === collapseVersion && state.expanded;
  const toggle = useCallback(() => {
    setState((current) => ({
      version: collapseVersion,
      expanded: !(current.version === collapseVersion && current.expanded),
    }));
  }, [collapseVersion]);
  return [expanded, toggle] as const;
}

const TOOL_ACTIVITY_ICONS = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePenLine,
  write: FilePlus2,
  search: Search,
  fetch: Globe,
  generic: Wrench,
};

function ToolActivityKindIcon({ kind, status }: { kind: ToolActivityKind; status: SessionRenderToolCard['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />;
  const Icon = TOOL_ACTIVITY_ICONS[kind];
  return <Icon className={`h-3.5 w-3.5 shrink-0 ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`} />;
}

function activityTrailingClassName(label: ToolActivityTrailingLabel): string {
  return `shrink-0 text-[13px] ${label.tone === 'muted' ? 'text-muted-foreground/75' : 'text-muted-foreground/85'}`;
}

function ToolActivityStatusIcon({ activity }: { activity: ToolActivityViewModel }) {
  if (activity.isRunning) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />;
  }
  return <SquareTerminal className={`h-3.5 w-3.5 ${activity.isError ? 'text-destructive' : 'text-muted-foreground'}`} />;
}

function ToolActivityTextBlock({
  block,
  copied,
  onCopy,
}: {
  block: ToolActivityViewModel['textBlocks'][number];
  copied?: boolean;
  onCopy?: () => void;
}) {
  const { t } = useTranslation('chat');
  const text = block.text;
  if (!text.trim()) {
    return null;
  }

  if (block.kind === 'notice') {
    return (
      <div className="w-full rounded-[14px] bg-muted px-4 py-3 text-[12px] text-muted-foreground">
        {text}
      </div>
    );
  }

  const isCommand = block.format === 'command';
  const diffLines = block.format === 'diff' ? text.split(/\r\n|\r|\n/) : null;
  return (
    <div className={`${COMPACT_TEXT_BLOCK} ${isCommand ? 'border-zinc-700 bg-zinc-950 text-zinc-100' : ''}`}>
      {(block.title || onCopy) ? (
        <div className={`flex h-9 items-center justify-between gap-3 border-b px-3.5 ${isCommand ? 'border-zinc-800 text-zinc-400' : 'border-border/35 text-muted-foreground'}`}>
          <div className="flex min-w-0 items-center gap-2">
            {block.title ? (isCommand ? <SquareTerminal className="h-3.5 w-3.5 shrink-0" /> : <Code2 className="h-3.5 w-3.5 shrink-0" />) : null}
            {block.title ? <span className="truncate text-[12px] font-medium uppercase tracking-wide">{block.title}</span> : null}
          </div>
          {onCopy ? (
            <button
              type="button"
              aria-label={t(copied ? 'toolActivity.copied' : 'toolActivity.copy')}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              onClick={onCopy}
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
      ) : null}
      <pre
        data-tool-output-scroll="true"
        tabIndex={0}
        className={`${COMPACT_OUTPUT_SCROLL_AREA} max-w-full py-3 font-mono text-[12px] leading-6 ${block.format === 'diff' ? '' : 'px-3.5'} ${isCommand ? 'text-zinc-100' : 'text-foreground'}`}
      >
        {diffLines ? diffLines.map((line, index) => (
          <span
            key={index}
            className={`block min-h-6 px-3.5 ${line.startsWith('+') && !line.startsWith('+++') ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : line.startsWith('-') && !line.startsWith('---') ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400' : line.startsWith('@@') ? 'text-sky-600 dark:text-sky-400' : ''}`}
          >
            {line}{index < diffLines.length - 1 ? '\n' : null}
          </span>
        )) : text}
      </pre>
    </div>
  );
}

type ToolActivityApprovalReview = NonNullable<ToolActivityViewModel['approvalReviews']>[number];
type ToolActivityApprovalReviewOutcome = NonNullable<ToolActivityViewModel['approvalReviewOutcome']>;
type ToolActivityDiffStat = NonNullable<ToolActivityViewModel['diffStat']>;
type ToolActivityProgressReceipt = NonNullable<ToolActivityViewModel['progressReceipt']>;
type ToolActivityPublicDetails = NonNullable<ToolActivityViewModel['publicDetails']>;
type ToolActivityPublicDetailValue = ToolActivityPublicDetails[string];

interface StructuredDetailRow {
  label: string;
  value: string;
}

const STRUCTURED_DETAIL_LABELS: Record<string, string> = {
  changed: 'toolActivity.detailLabels.changed',
  created: 'toolActivity.detailLabels.created',
  diff: 'toolActivity.detailLabels.diff',
  patch: 'toolActivity.detailLabels.patch',
  truncation: 'toolActivity.detailLabels.truncation',
  fullOutputPath: 'toolActivity.detailLabels.fullOutputPath',
  exitCode: 'toolActivity.detailLabels.exitCode',
};

function formatStructuredDetailLabel(key: string, t: TFunction<'chat'>): string {
  return STRUCTURED_DETAIL_LABELS[key] ? t(STRUCTURED_DETAIL_LABELS[key]) : key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

function isPublicDetailRecord(value: ToolActivityPublicDetailValue): value is Record<string, ToolActivityPublicDetailValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatScalarDetailValue(value: ToolActivityPublicDetailValue, t: TFunction<'chat'>): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return t(value ? 'toolActivity.yes' : 'toolActivity.no');
  return null;
}

function collectPublicDetailRows(details: ToolActivityPublicDetails | undefined, t: TFunction<'chat'>, maxRows = 12): StructuredDetailRow[] {
  const rows: StructuredDetailRow[] = [];

  const visit = (value: ToolActivityPublicDetailValue, label: string, depth: number) => {
    if (rows.length >= maxRows || depth > 3) return;

    const scalar = formatScalarDetailValue(value, t);
    if (scalar) {
      rows.push({ label, value: scalar });
      return;
    }

    if (Array.isArray(value)) {
      const scalars = value.map((item) => formatScalarDetailValue(item, t)).filter((item): item is string => item != null);
      if (scalars.length === value.length && scalars.length > 0) {
        const items = scalars.slice(0, 4).join(t('toolActivity.listSeparator'));
        rows.push({ label, value: scalars.length > 4 ? t('toolActivity.listSummary', { items, count: scalars.length }) : items });
        return;
      }
      for (const [index, item] of value.slice(0, 4).entries()) {
        visit(item, `${label} ${index + 1}`, depth + 1);
      }
      return;
    }

    if (!isPublicDetailRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (rows.length >= maxRows) return;
      visit(item, label ? `${label} · ${formatStructuredDetailLabel(key, t)}` : formatStructuredDetailLabel(key, t), depth + 1);
    }
  };

  for (const [key, value] of Object.entries(details ?? {})) {
    visit(value, formatStructuredDetailLabel(key, t), 0);
  }

  return rows.filter((row) => row.label && row.value);
}

function hasToolActivityStructuredContent(activity: ToolActivityViewModel, t: TFunction<'chat'>): boolean {
  return activity.canvasPreview != null
    || activity.browserTabPreview != null
    || (activity.approvalReviews?.length ?? 0) > 0
    || activity.approvalReviewOutcome != null
    || activity.diffStat != null
    || activity.liveDiffStat != null
    || activity.progressReceipt != null
    || collectPublicDetailRows(activity.publicDetails, t, 1).length > 0;
}

function shouldHideRawDetailsBlock(activity: ToolActivityViewModel, t: TFunction<'chat'>): boolean {
  return activity.browserTabPreview != null
    || (activity.approvalReviews?.length ?? 0) > 0
    || activity.approvalReviewOutcome != null
    || activity.progressReceipt != null
    || collectPublicDetailRows(activity.publicDetails, t, 1).length > 0;
}

function ToolActivityApprovalReviews({
  reviews,
  outcome,
}: {
  reviews: readonly ToolActivityApprovalReview[];
  outcome?: ToolActivityApprovalReviewOutcome;
}) {
  const { t } = useTranslation('chat');
  if (reviews.length === 0 && !outcome) return null;

  return (
    <div className={COMPACT_STRUCTURED_CARD}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-foreground">{t('toolActivity.approvalReview')}</div>
        {outcome ? <span className={COMPACT_META_CHIP}>{outcome.status}</span> : null}
      </div>
      {reviews.length > 0 ? (
        <div className="mt-2 space-y-2">
          {reviews.map((review) => (
            <div key={review.id} className="rounded-[12px] border border-border/35 bg-muted/35 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-[12px] font-medium text-foreground">{review.label}</span>
                <span className={COMPACT_META_CHIP}>{review.status}</span>
                {review.riskLevel ? <span className={COMPACT_META_CHIP}>{t('toolActivity.risk', { value: review.riskLevel })}</span> : null}
                {review.userAuthorization ? <span className={COMPACT_META_CHIP}>{t('toolActivity.authorization', { value: review.userAuthorization })}</span> : null}
              </div>
              {review.rationale ? <div className="mt-1 text-[11px] leading-5 text-muted-foreground">{review.rationale}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolActivityDiffStatCard({
  title,
  diffStat,
}: {
  title: string;
  diffStat?: ToolActivityDiffStat;
}) {
  const { t } = useTranslation('chat');
  if (!diffStat) return null;
  const files = [...(diffStat.filesChanged ?? []), ...(diffStat.filesCreated ?? [])];
  const fileCount = diffStat.fileCount ?? files.length;
  if (diffStat.additions == null && diffStat.deletions == null && fileCount === 0) return null;

  return (
    <div className={COMPACT_STRUCTURED_CARD}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] font-medium text-foreground">{title}</span>
        {typeof diffStat.additions === 'number' ? <span className={`${COMPACT_META_CHIP} text-emerald-600`}>+{diffStat.additions}</span> : null}
        {typeof diffStat.deletions === 'number' ? <span className={`${COMPACT_META_CHIP} text-rose-600`}>-{diffStat.deletions}</span> : null}
        {fileCount > 0 ? <span className={COMPACT_META_CHIP}>{t('toolActivity.files', { count: fileCount })}</span> : null}
      </div>
      {files.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {files.slice(0, 4).map((file) => (
            <div key={file} className="truncate font-mono text-[11px] leading-5 text-muted-foreground" title={file}>{file}</div>
          ))}
          {files.length > 4 ? <div className="text-[11px] leading-5 text-muted-foreground">{t('toolActivity.moreFiles', { count: files.length - 4 })}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolActivityMarkdownSummary({ markdown }: { markdown: string }) {
  const cacheKey = useMemo(() => `tool-progress:${buildMarkdownCacheKey({
    role: 'assistant',
    text: markdown,
    attachedFiles: [],
  })}`, [markdown]);
  const renderResult = useMemo(() => getOrBuildMarkdownBody(cacheKey, { markdown }), [cacheKey, markdown]);

  return (
    <div
      className="chat-markdown chat-markdown-sm chat-markdown-muted mt-2 max-w-none"
      dangerouslySetInnerHTML={{ __html: renderResult.fullHtml }}
    />
  );
}

function ToolActivityProgressReceiptCard({ receipt }: { receipt?: ToolActivityProgressReceipt }) {
  const { t } = useTranslation('chat');
  if (!receipt) return null;
  const percent = receipt.totalCount > 0 ? Math.max(0, Math.min(100, (receipt.completedCount / receipt.totalCount) * 100)) : 0;

  return (
    <div role="status" className={COMPACT_STRUCTURED_CARD}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-foreground">{t('toolActivity.progress')}</div>
        <span className={COMPACT_META_CHIP}>{receipt.completedCount}/{receipt.totalCount}</span>
      </div>
      {receipt.totalCount > 0 ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-sky-500" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {receipt.currentItem ? <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{t('toolActivity.currentItem', { name: receipt.currentItem })}</div> : null}
      {receipt.markdownSummary ? <ToolActivityMarkdownSummary markdown={receipt.markdownSummary} /> : null}
    </div>
  );
}

function StructuredDetailsRows({ rows }: { rows: StructuredDetailRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 grid gap-1.5">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 text-[11px] leading-5">
          <span className="truncate text-muted-foreground" title={row.label}>{row.label}</span>
          <span className="min-w-0 break-words text-foreground/90">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function ToolActivityStructuredDetails({ details }: { details?: ToolActivityPublicDetails }) {
  const { t } = useTranslation('chat');
  const rows = collectPublicDetailRows(details, t);
  if (rows.length === 0) return null;

  return (
    <details className={COMPACT_STRUCTURED_CARD}>
      <summary className="cursor-pointer select-none text-[12px] font-medium text-foreground marker:text-muted-foreground">
        {t('toolActivity.details')}
      </summary>
      <StructuredDetailsRows rows={rows} />
    </details>
  );
}

function ToolActivityStructuredContent({ activity, sessionIdentity, onOpen, tool, latestBrowserTool = false, onRuntimeSendMessage, onRuntimeOpenLink }: {
  activity: ToolActivityViewModel;
  sessionIdentity?: SessionIdentity;
  onOpen?: () => void;
  tool?: SessionRenderToolCard;
  latestBrowserTool?: boolean;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const showDiffStatCard = activity.diffStatPlacement !== 'header';
  return (
    <>
      {activity.browserTabPreview ? <ToolBrowserCard preview={activity.browserTabPreview} sessionIdentity={sessionIdentity} onOpen={onOpen}
        latest={latestBrowserTool} revision={tool ? `${tool.id}:${tool.updatedAt ?? ''}` : undefined} status={tool ? getToolActivityStatus(tool) : undefined} /> : null}
      {activity.canvasPreview ? <ToolWidgetCard preview={activity.canvasPreview} sessionIdentity={sessionIdentity} onOpen={onOpen} onSendMessage={onRuntimeSendMessage} onOpenLink={onRuntimeOpenLink} /> : null}
      <ToolActivityApprovalReviews reviews={activity.approvalReviews ?? []} outcome={activity.approvalReviewOutcome} />
      {showDiffStatCard ? <ToolActivityDiffStatCard title={t('toolActivity.liveChanges')} diffStat={activity.liveDiffStat} /> : null}
      {showDiffStatCard && !activity.liveDiffStat ? <ToolActivityDiffStatCard title={t('toolActivity.fileChanges')} diffStat={activity.diffStat} /> : null}
      <ToolActivityProgressReceiptCard receipt={activity.progressReceipt} />
      <ToolActivityStructuredDetails details={activity.publicDetails} />
    </>
  );
}

function ToolActivitySurfaceButton({
  title,
  onOpen,
}: {
  title: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <button
      type="button"
      aria-label={`${t('toolActivity.openSurface')} · ${title}`}
      title={t('toolActivity.openSurface')}
      className={`${COMPACT_ICON_TOGGLE} h-7 w-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border/50`}
      onClick={onOpen}
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>
  );
}

function ToolActivityPreview({
  tool,
  activity,
  showTitle = false,
  sessionIdentity,
  latestBrowserTool,
  onOpenToolSurface,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  tool: SessionRenderToolCard;
  activity: ToolActivityViewModel;
  showTitle?: boolean;
  sessionIdentity?: SessionIdentity;
  latestBrowserTool?: boolean;
  onOpenToolSurface?: (tool: SessionRenderToolCard, sessionIdentity: SessionIdentity) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const onOpen = activity.canOpenSurface && onOpenToolSurface && sessionIdentity ? () => onOpenToolSurface(tool, sessionIdentity) : undefined;
  return (
    <div data-tool-activity-preview="true" className="w-full space-y-2">
      {showTitle ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">{activity.title}</span>
          {!activity.browserTabPreview && !activity.canvasPreview && onOpen ? (
            <ToolActivitySurfaceButton title={activity.title} onOpen={onOpen} />
          ) : null}
        </div>
      ) : null}
      <ToolActivityStructuredContent activity={activity} sessionIdentity={sessionIdentity} onOpen={onOpen} tool={tool} latestBrowserTool={latestBrowserTool} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} />
    </div>
  );
}

function collapseToolActivityPreviews(previews: ReadonlyArray<ToolActivityViewModel | null>, tools: ReadonlyArray<SessionRenderToolCard>, latestBrowserTools: ReadonlySet<SessionRenderToolCard> | undefined, t: TFunction<'chat'>) {
  const latestTabs = new Map<string, number>();
  const result = previews.map((preview) => preview ? { ...preview, approvalReviews: undefined, approvalReviewOutcome: undefined } : null);
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const preview = result[index];
    if (!preview) continue;
    const tab = preview.browserTabPreview;
    if (tab) {
      const key = JSON.stringify([tab.target, tab.node ?? '', tab.profile, tab.targetId]);
      const previousIndex = latestTabs.get(key);
      if (previousIndex === undefined) latestTabs.set(key, index);
      else {
        const hidden = latestBrowserTools?.has(tools[index]) ? result[previousIndex]! : preview;
        hidden.browserTabPreview = undefined;
        hidden.canOpenSurface = hidden.canvasPreview?.runtimeSurface !== undefined;
        if (hidden !== preview) latestTabs.set(key, index);
      }
    }
  }
  return result.map((preview) => preview && (preview.canOpenSurface || hasToolActivityStructuredContent(preview, t)) ? preview : null);
}

export const ToolCardList = memo(function ToolCardList({
  tools,
  collapseVersion,
  sessionIdentity,
  groupKey,
  disclosure,
  latestBrowserTools,
  onOpenToolSurface,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  tools: ReadonlyArray<SessionRenderToolCard>;
  collapseVersion: number;
  sessionIdentity?: SessionIdentity;
  groupKey?: string;
  disclosure?: ToolActivityDisclosure;
  latestBrowserTools?: ReadonlySet<SessionRenderToolCard>;
  onOpenToolSurface?: (tool: SessionRenderToolCard, sessionIdentity: SessionIdentity) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const localDisclosure = useToolActivityDisclosure(disclosure ? undefined : sessionIdentity, collapseVersion);
  const activeDisclosure = disclosure ?? localDisclosure;
  const disclosureKey = getToolGroupDisclosureKey(groupKey ?? (tools[0] ? getToolDisclosureKey(tools[0]) : ''));
  const expanded = activeDisclosure.expandedKeys.has(disclosureKey);
  const summary = useMemo(() => summarizeToolActivities(tools, t), [tools, t]);
  const previews = useMemo(() => tools.map((tool) => buildToolActivityPreview(tool, t, sessionIdentity)), [tools, t, sessionIdentity]);
  const collapsedPreviews = useMemo(() => collapseToolActivityPreviews(previews, tools, latestBrowserTools, t), [previews, tools, latestBrowserTools, t]);
  const approvalStatus = useMemo(() => {
    let status: ToolActivityApprovalReviewOutcome['status'] | undefined;
    for (const preview of previews) {
      const reviews = preview?.approvalReviews ?? [];
      const outcome = preview?.approvalReviewOutcome?.status;
      if (outcome === 'denied' || reviews.some((review) => ['denied', 'timed_out', 'aborted'].includes(review.status))) return 'denied';
      if (outcome === 'reviewing' || reviews.some((review) => review.status === 'in_progress')) status = 'reviewing';
      else if (!status && (outcome === 'approved' || reviews.some((review) => review.status === 'approved'))) status = 'approved';
    }
    return status;
  }, [previews]);
  const statusCounts = useMemo(() => {
    const counts = new Map<SessionRenderToolCard['status'], number>();
    for (const tool of tools) {
      const status = getToolActivityStatus(tool);
      if (status !== 'completed') counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [tools]);
  let runningTool: SessionRenderToolCard | undefined;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index].status === 'running') {
      runningTool = tools[index];
      break;
    }
  }
  const title = runningTool ? `${describeToolActivity(runningTool, t).title}…` : summary;
  if (tools.length === 0) {
    return null;
  }

  return (
    <div data-compact-rail="tool-group" className={`${COMPACT_SIDE_RAIL_TRACK} gap-1.5 text-sm`}>
      <button
        type="button"
        data-chat-local-geometry-anchor="true"
        aria-label={t(expanded ? 'toolActivity.collapse' : 'toolActivity.expand', { title })}
        aria-expanded={expanded}
        className={`${COMPACT_SIDE_RAIL_HEADER} w-full text-left`}
        onClick={() => activeDisclosure.toggle(disclosureKey)}
      >
        <span className={COMPACT_ICON_TOGGLE}>
          {runningTool ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" /> : expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 truncate text-[14px] leading-6" title={title}>{title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground/75">{tools.length}</span>
        {approvalStatus ? <span className={`${COMPACT_META_CHIP} ${approvalStatus === 'denied' ? 'text-destructive' : ''}`}>{t('toolActivity.approvalReview')} · {approvalStatus}</span> : null}
        {[...statusCounts].map(([status, count]) => (
          <span key={status} className={`shrink-0 text-[11px] ${status === 'error' ? 'text-destructive' : 'text-muted-foreground/75'}`}>
            {t(`toolStatus.${status}`)} {count}
          </span>
        ))}
      </button>
      {expanded ? (
        <div className="flex w-full flex-col items-start gap-1.5 border-l border-border/40 pl-4">
          {tools.map((tool, index) => (
            <ToolCard
              key={getToolDisclosureKey(tool)}
              tool={tool}
              preview={previews[index]}
              disclosure={activeDisclosure}
              sessionIdentity={sessionIdentity}
              latestBrowserTool={latestBrowserTools?.has(tool) ?? false}
              onOpenToolSurface={onOpenToolSurface}
              onRuntimeSendMessage={onRuntimeSendMessage}
              onRuntimeOpenLink={onRuntimeOpenLink}
            />
          ))}
        </div>
      ) : collapsedPreviews.some(Boolean) ? (
        <div className="w-full space-y-2 pl-7">
          {tools.map((tool, index) => collapsedPreviews[index] ? (
            <ToolActivityPreview
              key={getToolDisclosureKey(tool)}
              tool={tool}
              activity={collapsedPreviews[index]!}
              showTitle
              sessionIdentity={sessionIdentity}
              latestBrowserTool={latestBrowserTools?.has(tool) ?? false}
              onOpenToolSurface={onOpenToolSurface}
              onRuntimeSendMessage={onRuntimeSendMessage}
              onRuntimeOpenLink={onRuntimeOpenLink}
            />
          ) : null)}
        </div>
      ) : null}
    </div>
  );
});

export const AssistantEmbeddedToolResults = memo(function AssistantEmbeddedToolResults({
  embeddedToolResults,
  sourceTool,
  collapseVersion,
  sessionIdentity,
  onOpenToolSurface,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  embeddedToolResults: ReadonlyArray<SessionRenderAssistantBubbleToolResult>;
  sourceTool?: SessionRenderToolCard;
  collapseVersion: number;
  sessionIdentity?: SessionIdentity;
  onOpenToolSurface?: (tool: SessionRenderToolCard, sessionIdentity: SessionIdentity) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  if (embeddedToolResults.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col items-start gap-2">
      {embeddedToolResults.map((item) => (
        <AssistantEmbeddedToolResultCard key={item.key} item={item} sourceTool={sourceTool} collapseVersion={collapseVersion} sessionIdentity={sessionIdentity} onOpenToolSurface={onOpenToolSurface} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} />
      ))}
    </div>
  );
});

export const ThinkingSection = memo(function ThinkingSection({
  content,
  collapseVersion,
}: {
  content: string;
  collapseVersion: number;
}) {
  const [expanded, toggleExpanded] = useVersionedDisclosure(collapseVersion);
  const thinkingCacheKey = useMemo(() => `thinking:${buildMarkdownCacheKey({
    role: 'assistant',
    text: content,
    attachedFiles: [],
  })}`, [content]);
  const renderResult = useMemo(() => getOrBuildMarkdownBody(thinkingCacheKey, {
    markdown: content,
  }), [content, thinkingCacheKey]);

  return (
    <div
      data-compact-rail="thinking"
      className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}
    >
      <button
        type="button"
        data-chat-local-geometry-anchor="true"
        aria-label={expanded ? '收起思考' : '展开思考'}
        aria-expanded={expanded}
        className={`${COMPACT_SIDE_RAIL_HEADER} group/tool`}
        onClick={toggleExpanded}
      >
        <span className={COMPACT_ICON_TOGGLE}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <span className="truncate text-[14px] leading-6">思考过程</span>
      </button>
      {expanded && (
        <div className="mt-1 pl-7">
          <div
            className="chat-markdown chat-markdown-sm chat-markdown-muted max-w-none"
            dangerouslySetInnerHTML={{ __html: renderResult.fullHtml }}
          />
        </div>
      )}
    </div>
  );
});

export function UserMessageMedia({
  images,
  attachedFiles,
  onPreview,
}: {
  images: ReadonlyArray<ChatMessageImage>;
  attachedFiles: ReadonlyArray<AttachedFileMeta>;
  onPreview: (item: MessageLightboxState) => void;
}) {
  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {images.map((img, index) => {
            const src = imageSrc(img);
            if (!src) return null;
            return (
              <ImageThumbnail
                key={`content-${index}`}
                src={src}
                fileName="image"
                onPreview={() => onPreview({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
              />
            );
          })}
        </div>
      )}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {attachedFiles.map((file, index) => {
            const isImage = file.mimeType.startsWith('image/');
            if (isImage && images.length > 0 && !(file.source === 'user-upload' && file.filePath)) return null;
            if (!isImage || (file.source === 'user-upload' && file.filePath)) {
              return <FileCard key={`local-${index}`} file={file} />;
            }
            if (!file.preview) {
              if (file.filePath) {
                return <FileCard key={`local-${index}`} file={file} />;
              }
              return <MissingImagePreview key={`local-${index}`} unavailable={file.previewStatus === 'unavailable'} label={attachmentImageLabel(file)} />;
            }
            return (
              <ImageThumbnail
                key={`local-${index}`}
                src={file.preview}
                fileName={file.fileName}
                onPreview={() => onPreview({
                  src: file.preview!,
                  fileName: file.fileName,
                  filePath: file.filePath,
                  mimeType: file.mimeType,
                })}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

export function AssistantMessageMedia({
  images,
  attachedFiles,
  onPreview,
  onOpenFile,
}: {
  images: ReadonlyArray<ChatMessageImage>;
  attachedFiles: ReadonlyArray<AttachedFileMeta>;
  onPreview: (item: MessageLightboxState) => void;
  onOpenFile?: (file: AttachedFileMeta) => void;
}) {
  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {images.map((img, index) => {
            const src = imageSrc(img);
            if (!src) return null;
            return (
              <ImagePreviewCard
                key={`content-${index}`}
                src={src}
                fileName="image"
                onPreview={() => onPreview({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
              />
            );
          })}
        </div>
      )}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {attachedFiles.map((file, index) => {
            const isImage = file.mimeType.startsWith('image/');
            if (isImage && images.length > 0) return null;
            if (!isImage) {
              return <FileCard key={`local-${index}`} file={file} onOpen={onOpenFile} />;
            }
            if (!file.preview) {
              if (file.filePath) {
                return <FileCard key={`local-${index}`} file={file} onOpen={onOpenFile} />;
              }
              return <MissingImagePreview key={`local-${index}`} unavailable={file.previewStatus === 'unavailable'} label={attachmentImageLabel(file)} />;
            }
            return (
              <ImagePreviewCard
                key={`local-${index}`}
                src={file.preview}
                fileName={file.fileName}
                onPreview={() => onPreview({
                  src: file.preview!,
                  fileName: file.fileName,
                  filePath: file.filePath,
                  mimeType: file.mimeType,
                })}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

export const UserMessageMetaBar = memo(function UserMessageMetaBar({
  timestamp,
  onReuse,
  loading = false,
}: {
  timestamp?: number;
  onReuse?: () => void;
  loading?: boolean;
}) {
  const { t } = useTranslation('chat');
  if (!timestamp && !onReuse) {
    return null;
  }

  return (
    <div className={`mt-0.5 flex w-full items-center justify-end ${loading ? 'opacity-100' : 'opacity-0'} transition-opacity duration-200 select-none group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none`}>
      {timestamp ? (
        <span className="px-1 text-[11px] leading-5 text-muted-foreground/80">
          {formatTimestamp(timestamp)}
        </span>
      ) : null}
      {onReuse ? (
        <button
          type="button"
          aria-label={t('reuseMessage')}
          title={t('reuseMessage')}
          aria-busy={loading}
          disabled={loading}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground/75 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-wait motion-reduce:transition-none"
          onClick={onReuse}
        >
          {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <CornerDownLeft aria-hidden="true" className="h-4 w-4" />}
        </button>
      ) : null}
    </div>
  );
});

export const AssistantMessageMetaBar = memo(function AssistantMessageMetaBar({
  text,
  timestamp,
  statusLabel,
}: {
  text: string;
  timestamp?: number;
  statusLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const canCopy = text.trim().length > 0;

  const copyContent = useCallback(() => {
    if (!canCopy) {
      return;
    }
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [canCopy, text]);

  return (
    <div className="mt-0.5 flex w-full justify-end opacity-0 transition-opacity duration-200 select-none group-hover:opacity-100">
      <div className="inline-flex items-center gap-1.5 px-1 text-[11px] leading-5 text-muted-foreground/80">
        <span>{statusLabel ?? (timestamp ? formatTimestamp(timestamp) : '')}</span>
        {canCopy ? (
          <button
            type="button"
            aria-label={copied ? 'Copied reply' : 'Copy reply'}
            title={copied ? 'Copied' : 'Copy'}
            className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground/75 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border/60"
            onClick={copyContent}
          >
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </button>
        ) : null}
      </div>
    </div>
  );
});

function ToolActivityBody({
  activity,
  expanded,
  showCanvasFrame = false,
  sessionIdentity,
  onOpen,
  tool,
  latestBrowserTool,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  activity: ToolActivityViewModel;
  expanded: boolean;
  showCanvasFrame?: boolean;
  sessionIdentity?: SessionIdentity;
  onOpen?: () => void;
  tool?: SessionRenderToolCard;
  latestBrowserTool?: boolean;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copyBlockText = useCallback((text: string) => {
    if (!text.trim()) return;
    void navigator.clipboard.writeText(text);
    setCopiedText(text);
    window.setTimeout(() => setCopiedText(null), 1600);
  }, []);
  const hideRawDetails = shouldHideRawDetailsBlock(activity, t);
  const textBlocks = activity.textBlocks.filter((block) =>
    !(hideRawDetails && block.kind === 'details')
    && !(activity.canvasPreview?.rawText && block.kind === 'output' && block.text === activity.canvasPreview.rawText));
  const parameters = activity.parameters ?? [];
  const parameterText = parameters.map(({ name, value }) => `${name}: ${value}`).join('\n');
  const details = (
    <>
      {parameters.length > 0 ? (
        <div className={COMPACT_STRUCTURED_CARD}>
          <div className="flex items-center justify-between gap-2 text-[12px] font-medium text-foreground">
            <span>{t('toolActivity.skill.parameters')}</span>
            <button
              type="button"
              aria-label={t(copiedText === parameterText ? 'toolActivity.copied' : 'toolActivity.copy')}
              className={`${COMPACT_ICON_TOGGLE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border/50`}
              onClick={() => copyBlockText(parameterText)}
            >
              {copiedText === parameterText ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div data-tool-output-scroll="true" tabIndex={0} className={COMPACT_OUTPUT_SCROLL_AREA}>
            <StructuredDetailsRows rows={parameters.map(({ name, value }) => ({ label: name, value }))} />
          </div>
        </div>
      ) : null}
      <ToolActivityStructuredContent activity={activity} sessionIdentity={sessionIdentity} onOpen={onOpen} tool={tool} latestBrowserTool={latestBrowserTool} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} />
      {textBlocks.map((block, index) => (
        <ToolActivityTextBlock
          key={`${block.kind}-${index}`}
          block={block}
          copied={copiedText === block.text}
          onCopy={block.copyable || block.kind === 'output' ? () => copyBlockText(block.text) : undefined}
        />
      ))}
    </>
  );

  return expanded ? <div className="mt-2 w-full space-y-2">{details}</div> : showCanvasFrame && activity.canvasPreview ? (
    <div className="mt-2 w-full">
      <ToolWidgetCard preview={activity.canvasPreview} sessionIdentity={sessionIdentity} onOpen={onOpen} onSendMessage={onRuntimeSendMessage} onOpenLink={onRuntimeOpenLink} />
    </div>
  ) : null;
}

function ToolActivityRail({
  activity,
  collapseVersion,
  sessionIdentity,
  onOpen,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  activity: ToolActivityViewModel;
  collapseVersion: number;
  sessionIdentity?: SessionIdentity;
  onOpen?: () => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const [expanded, toggleExpanded] = useVersionedDisclosure(collapseVersion);
  const canExpand = activity.canExpand || hasToolActivityStructuredContent(activity, t);
  return (
    <div data-compact-rail="embedded-tool-result" className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}>
      <button
        type="button"
        data-chat-local-geometry-anchor="true"
        aria-label={t(expanded ? 'toolActivity.collapse' : 'toolActivity.expand', { title: activity.title })}
        aria-expanded={expanded}
        disabled={!canExpand}
        className={`${COMPACT_SIDE_RAIL_HEADER} disabled:cursor-default disabled:hover:text-muted-foreground`}
        onClick={toggleExpanded}
      >
        <span className={COMPACT_ICON_TOGGLE}>
          <ToolActivityStatusIcon activity={activity} />
        </span>
        <span className="min-w-0 truncate text-[14px] leading-6">{activity.title}</span>
        {activity.trailingLabels.map((label, index) => (
          <span key={`${label.text}-${index}`} className={activityTrailingClassName(label)}>{label.text}</span>
        ))}
        {canExpand ? expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : null}
      </button>
      <ToolActivityBody activity={activity} expanded={expanded && canExpand} showCanvasFrame sessionIdentity={sessionIdentity} onOpen={onOpen} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} />
    </div>
  );
}

function ToolActivityDetails({ tool, sessionIdentity, onOpen, latestBrowserTool, onRuntimeSendMessage, onRuntimeOpenLink }: {
  tool: SessionRenderToolCard;
  sessionIdentity?: SessionIdentity;
  onOpen?: () => void;
  latestBrowserTool?: boolean;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const activity = useMemo(() => buildToolActivityViewModel(tool, t, sessionIdentity), [tool, t, sessionIdentity]);
  return (
    <>
      {activity.trailingLabels.length > 0 ? (
        <div className={`flex flex-wrap items-center gap-2 text-[11px] ${activity.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {activity.trailingLabels.map((label, index) => <span key={`${label.text}-${index}`}>{label.text}</span>)}
        </div>
      ) : null}
      <ToolActivityBody activity={activity} expanded sessionIdentity={sessionIdentity} onOpen={onOpen} tool={tool} latestBrowserTool={latestBrowserTool} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} />
    </>
  );
}

const ToolCard = memo(function ToolCard({
  tool,
  preview,
  disclosure,
  sessionIdentity,
  latestBrowserTool,
  onOpenToolSurface,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  tool: SessionRenderToolCard;
  preview: ToolActivityViewModel | null;
  disclosure: ToolActivityDisclosure;
  sessionIdentity?: SessionIdentity;
  latestBrowserTool?: boolean;
  onOpenToolSurface?: (tool: SessionRenderToolCard, sessionIdentity: SessionIdentity) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const descriptor = useMemo(() => describeToolActivity(tool, t), [tool, t]);
  const status = getToolActivityStatus(tool);
  const key = getToolDisclosureKey(tool);
  const expanded = disclosure.expandedKeys.has(key);
  const onOpen = preview?.canOpenSurface && onOpenToolSurface && sessionIdentity ? () => onOpenToolSurface(tool, sessionIdentity) : undefined;
  return (
    <div data-compact-rail="tool" className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}>
      <div className="flex w-full min-w-0 items-center gap-1">
        <button
          type="button"
          data-chat-local-geometry-anchor="true"
          aria-label={t(expanded ? 'toolActivity.collapse' : 'toolActivity.expand', { title: descriptor.title })}
          aria-expanded={expanded}
          className={`${COMPACT_SIDE_RAIL_HEADER} min-w-0 flex-1 text-left`}
          onClick={() => disclosure.toggle(key)}
        >
          <span className={COMPACT_ICON_TOGGLE}><ToolActivityKindIcon kind={descriptor.kind} status={status} /></span>
          <span className="min-w-0 truncate text-[13px] leading-6" title={descriptor.title}>{descriptor.title}</span>
          {status !== 'completed' ? <span className={`shrink-0 text-[11px] ${status === 'error' ? 'text-destructive' : 'text-muted-foreground/75'}`}>{t(`toolStatus.${status}`)}</span> : null}
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        </button>
        {!preview?.browserTabPreview && !preview?.canvasPreview && onOpen ? <ToolActivitySurfaceButton title={descriptor.title} onOpen={onOpen} /> : null}
      </div>
      {expanded ? (
        <div className="w-full pl-7"><ToolActivityDetails tool={tool} sessionIdentity={sessionIdentity} onOpen={onOpen} latestBrowserTool={latestBrowserTool} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} /></div>
      ) : preview ? (
        <div className="mt-1 w-full pl-7"><ToolActivityPreview tool={tool} activity={preview} sessionIdentity={sessionIdentity} latestBrowserTool={latestBrowserTool} onOpenToolSurface={onOpenToolSurface} onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} /></div>
      ) : null}
    </div>
  );
});

function AssistantEmbeddedToolResultCard({
  item,
  sourceTool,
  collapseVersion,
  sessionIdentity,
  onOpenToolSurface,
  onRuntimeSendMessage,
  onRuntimeOpenLink,
}: {
  item: SessionRenderAssistantBubbleToolResult;
  sourceTool?: SessionRenderToolCard;
  collapseVersion: number;
  sessionIdentity?: SessionIdentity;
  onOpenToolSurface?: (tool: SessionRenderToolCard, sessionIdentity: SessionIdentity) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const activity = useMemo(() => buildCanvasActivityViewModel(item, t, sourceTool, sessionIdentity), [item, t, sourceTool, sessionIdentity]);
  if (!activity) {
    return null;
  }
  return (
    <ToolActivityRail activity={activity} collapseVersion={collapseVersion} sessionIdentity={sessionIdentity}
      onOpen={activity.canOpenSurface && sourceTool && sessionIdentity && onOpenToolSurface ? () => onOpenToolSurface(sourceTool, sessionIdentity) : undefined}
      onRuntimeSendMessage={onRuntimeSendMessage} onRuntimeOpenLink={onRuntimeOpenLink} />
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType === DIRECTORY_MIME_TYPE) return <FileArchive className={className} />;
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

function attachmentStatusLabel(file: AttachedFileMeta): string | null {
  if (file.attachmentStatus === 'preview-unavailable' || file.previewStatus === 'unavailable') return '预览不可用';
  if (file.attachmentStatus === 'unsafe-media-omitted') return '不安全媒体已省略';
  if (file.attachmentStatus === 'thinking-omitted') return '思考内容已省略';
  if (file.attachmentStatus === 'unknown-omitted') return '附件已省略';
  return null;
}

function attachmentSourceLabel(source: AttachedFileMeta['source']): string | null {
  if (source === 'message-ref') return '消息附件';
  if (source === 'tool-result') return '工具结果';
  if (source === 'user-upload') return '用户上传';
  return null;
}

function attachmentImageLabel(file: AttachedFileMeta): string | null {
  return attachmentStatusLabel(file) ?? attachmentSourceLabel(file.source);
}

function FileCard({
  file,
  onOpen,
}: {
  file: AttachedFileMeta;
  onOpen?: (file: AttachedFileMeta) => void;
}) {
  const filePath = typeof file.filePath === 'string' ? file.filePath.trim() : '';
  const isDirectory = file.mimeType === DIRECTORY_MIME_TYPE;
  const canOpenDirectly = file.source === 'user-upload' && filePath.length > 0;
  const canOpenArtifact = !canOpenDirectly && filePath.length > 0 && Boolean(onOpen) && shouldKeepAssistantAttachmentVisible(file);
  const canOpen = canOpenDirectly || canOpenArtifact;
  const visiblePath = canOpenDirectly ? filePath : null;
  const statusLabel = attachmentStatusLabel(file);
  const sourceLabel = attachmentSourceLabel(file.source);
  const baseDetail = visiblePath ?? (isDirectory ? '文件夹' : file.fileSize > 0 ? formatFileSize(file.fileSize) : 'File');
  const detail = statusLabel ?? (sourceLabel ? `${sourceLabel} · ${baseDetail}` : baseDetail);
  const lastOpenEventRef = useRef<{ kind: 'pointerdown' | 'mousedown' | 'click'; at: number } | null>(null);
  const handleOpen = useCallback(() => {
    if (!canOpen) {
      return;
    }
    if (canOpenDirectly) {
      void invokeIpc('shell:openPath', filePath);
      return;
    }
    onOpen?.(file);
  }, [canOpen, canOpenDirectly, file, filePath, onOpen]);
  const triggerOpen = useCallback((kind: 'pointerdown' | 'mousedown' | 'click') => {
    const previous = lastOpenEventRef.current;
    const now = Date.now();
    if (previous && now - previous.at < 250) {
      if (previous.kind === 'pointerdown' && (kind === 'mousedown' || kind === 'click')) {
        return;
      }
      if (previous.kind === 'mousedown' && kind === 'click') {
        return;
      }
    }
    lastOpenEventRef.current = { kind, at: now };
    handleOpen();
  }, [handleOpen]);
  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    triggerOpen('pointerdown');
  }, [triggerOpen]);
  const handleMouseDown = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    triggerOpen('mousedown');
  }, [triggerOpen]);
  const handleClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    triggerOpen('click');
  }, [triggerOpen]);

  if (canOpen) {
    return (
      <button
        type="button"
        data-testid="chat-attached-file-card"
        data-chat-attached-file-path={file.filePath}
        data-chat-attached-file-name={file.fileName}
        onPointerDown={handlePointerDown}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        title={visiblePath ?? 'Open file'}
        className="flex max-w-[220px] items-center gap-2 rounded-[16px] border border-border/42 bg-card px-3 py-2 text-left shadow-sm transition-colors hover:bg-background/95"
      >
        <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 overflow-hidden">
          <p className="text-xs font-medium truncate">{file.fileName}</p>
          <p aria-hidden="true" className="truncate text-[10px] text-muted-foreground">{detail}</p>
        </div>
      </button>
    );
  }

  return (
    <div className="flex max-w-[220px] items-center gap-2 rounded-[16px] border border-border/42 bg-card px-3 py-2 shadow-sm">
      <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 overflow-hidden">
        <p className="text-xs font-medium truncate">{file.fileName}</p>
        <p aria-hidden="true" className="truncate text-[10px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function MissingImagePreview({ unavailable = false, label }: { unavailable?: boolean; label?: string | null }) {
  return (
    <div
      data-testid={unavailable ? 'chat-image-preview-unavailable' : 'chat-missing-image-preview'}
      className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex flex-col gap-2 items-center justify-center text-muted-foreground"
    >
      <File className="h-8 w-8" />
      {label ? <span className="px-3 text-center text-[11px] leading-4">{label}</span> : null}
    </div>
  );
}

function ImageThumbnail({
  src,
  fileName,
  onPreview,
}: {
  src: string;
  fileName: string;
  onPreview: () => void;
}) {
  return (
    <div
      className="group/img relative h-36 w-36 cursor-zoom-in overflow-hidden rounded-[18px] border border-border/42 bg-card shadow-sm"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="w-full h-full object-cover" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/25 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

function ImagePreviewCard({
  src,
  fileName,
  onPreview,
}: {
  src: string;
  fileName: string;
  onPreview: () => void;
}) {
  return (
    <div
      className="group/img relative max-w-xs cursor-zoom-in overflow-hidden rounded-[18px] border border-border/42 bg-card shadow-sm"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="block w-full" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

import { useCallback, useMemo, useRef, useState, memo, type FormEvent, type MouseEvent, type PointerEvent } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, SquareTerminal, Code2, FileText, Film, Music, FileArchive, File, ZoomIn, Loader2 } from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import { hostOpenClawQuestionResolve } from '@/lib/host-api';
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
  buildToolActivityViewModel,
  type ToolActivityTrailingLabel,
  type ToolActivityViewModel,
} from './tool-activity-view-model';

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
  const trimmedText = block.text.trim();
  if (!trimmedText) {
    return null;
  }

  if (block.kind === 'notice') {
    return (
      <div className="w-full rounded-[14px] bg-muted px-4 py-3 text-[12px] text-muted-foreground">
        {trimmedText}
      </div>
    );
  }

  return (
    <div className={COMPACT_TEXT_BLOCK}>
      {(block.title || onCopy) ? (
        <div className="flex h-9 items-center justify-between gap-3 border-b border-border/35 px-3.5 text-foreground">
          <div className="flex min-w-0 items-center gap-2">
            {block.title ? <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
            {block.title ? <span className="truncate text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{block.title}</span> : null}
          </div>
          {onCopy ? (
            <button
              type="button"
              aria-label={copied ? '已复制输入' : '复制输入'}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-background/95 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              onClick={onCopy}
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
      ) : null}
      <pre
        data-tool-output-scroll="true"
        className={`${COMPACT_OUTPUT_SCROLL_AREA} max-w-full px-3.5 py-3 text-[12px] leading-6 text-foreground`}
      >
        {trimmedText}
      </pre>
    </div>
  );
}

type ToolActivityBrowserTabPreview = NonNullable<ToolActivityViewModel['browserTabPreview']>;
type ToolActivityApprovalReview = NonNullable<ToolActivityViewModel['approvalReviews']>[number];
type ToolActivityApprovalReviewOutcome = NonNullable<ToolActivityViewModel['approvalReviewOutcome']>;
type ToolActivityDiffStat = NonNullable<ToolActivityViewModel['diffStat']>;
type ToolActivityProgressReceipt = NonNullable<ToolActivityViewModel['progressReceipt']>;
type ToolActivityPublicDetails = NonNullable<ToolActivityViewModel['publicDetails']>;
type ToolActivityPublicDetailValue = ToolActivityPublicDetails[string];
type ToolActivityCanvasPreview = NonNullable<ToolActivityViewModel['canvasPreview']>;

interface StructuredDetailRow {
  label: string;
  value: string;
}

const STRUCTURED_DETAIL_LABELS: Record<string, string> = {
  changed: '已变更',
  created: '已创建',
  diff: '差异',
  patch: '补丁',
  truncation: '截断',
  fullOutputPath: '完整输出',
  exitCode: '退出码',
};

function formatStructuredDetailLabel(key: string): string {
  return STRUCTURED_DETAIL_LABELS[key] ?? key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

function isPublicDetailRecord(value: ToolActivityPublicDetailValue): value is Record<string, ToolActivityPublicDetailValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatScalarDetailValue(value: ToolActivityPublicDetailValue): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return null;
}

function collectPublicDetailRows(details: ToolActivityPublicDetails | undefined, maxRows = 12): StructuredDetailRow[] {
  const rows: StructuredDetailRow[] = [];

  const visit = (value: ToolActivityPublicDetailValue, label: string, depth: number) => {
    if (rows.length >= maxRows || depth > 3) return;

    const scalar = formatScalarDetailValue(value);
    if (scalar) {
      rows.push({ label, value: scalar });
      return;
    }

    if (Array.isArray(value)) {
      const scalars = value.map(formatScalarDetailValue).filter((item): item is string => item != null);
      if (scalars.length === value.length && scalars.length > 0) {
        rows.push({ label, value: scalars.slice(0, 4).join('、') + (scalars.length > 4 ? ` 等 ${scalars.length} 项` : '') });
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
      visit(item, label ? `${label} · ${formatStructuredDetailLabel(key)}` : formatStructuredDetailLabel(key), depth + 1);
    }
  };

  for (const [key, value] of Object.entries(details ?? {})) {
    visit(value, formatStructuredDetailLabel(key), 0);
  }

  return rows.filter((row) => row.label && row.value);
}

function hasToolActivityStructuredContent(activity: ToolActivityViewModel): boolean {
  return activity.canvasPreview != null
    || activity.browserTabPreview != null
    || (activity.approvalReviews?.length ?? 0) > 0
    || activity.approvalReviewOutcome != null
    || activity.diffStat != null
    || activity.liveDiffStat != null
    || activity.progressReceipt != null
    || collectPublicDetailRows(activity.publicDetails, 1).length > 0;
}

function shouldHideRawDetailsBlock(activity: ToolActivityViewModel): boolean {
  return activity.browserTabPreview != null
    || (activity.approvalReviews?.length ?? 0) > 0
    || activity.approvalReviewOutcome != null
    || activity.progressReceipt != null
    || collectPublicDetailRows(activity.publicDetails, 1).length > 0;
}

function resolveCanvasFramePreview(activity: ToolActivityViewModel, showCanvasFrame: boolean): ToolActivityCanvasPreview | null {
  if (!activity.canvasPreview) return null;
  return showCanvasFrame || activity.canvasPreview.url ? activity.canvasPreview : null;
}

function ToolActivityBrowserTabCard({ preview }: { preview?: ToolActivityBrowserTabPreview }) {
  if (!preview) return null;
  return (
    <div className={COMPACT_STRUCTURED_CARD}>
      <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-foreground">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{preview.title ?? '浏览器标签页'}</span>
      </div>
      {preview.url ? (
        <div className="mt-1 truncate font-mono text-[11px] leading-5 text-muted-foreground" title={preview.url}>{preview.url}</div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={COMPACT_META_CHIP}>{preview.target}</span>
        <span className={COMPACT_META_CHIP}>target {preview.targetId}</span>
        <span className={COMPACT_META_CHIP}>profile {preview.profile}</span>
        {preview.node ? <span className={COMPACT_META_CHIP}>node {preview.node}</span> : null}
      </div>
    </div>
  );
}

function ToolActivityApprovalReviews({
  reviews,
  outcome,
}: {
  reviews: readonly ToolActivityApprovalReview[];
  outcome?: ToolActivityApprovalReviewOutcome;
}) {
  if (reviews.length === 0 && !outcome) return null;

  return (
    <div className={COMPACT_STRUCTURED_CARD}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-foreground">审批复核</div>
        {outcome ? <span className={COMPACT_META_CHIP}>{outcome.status}</span> : null}
      </div>
      {reviews.length > 0 ? (
        <div className="mt-2 space-y-2">
          {reviews.map((review) => (
            <div key={review.id} className="rounded-[12px] border border-border/35 bg-muted/35 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-[12px] font-medium text-foreground">{review.label}</span>
                <span className={COMPACT_META_CHIP}>{review.status}</span>
                {review.riskLevel ? <span className={COMPACT_META_CHIP}>风险 {review.riskLevel}</span> : null}
                {review.userAuthorization ? <span className={COMPACT_META_CHIP}>授权 {review.userAuthorization}</span> : null}
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
        {fileCount > 0 ? <span className={COMPACT_META_CHIP}>{fileCount} 个文件</span> : null}
      </div>
      {files.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {files.slice(0, 4).map((file) => (
            <div key={file} className="truncate font-mono text-[11px] leading-5 text-muted-foreground" title={file}>{file}</div>
          ))}
          {files.length > 4 ? <div className="text-[11px] leading-5 text-muted-foreground">另有 {files.length - 4} 个文件</div> : null}
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
  if (!receipt) return null;
  const percent = receipt.totalCount > 0 ? Math.max(0, Math.min(100, (receipt.completedCount / receipt.totalCount) * 100)) : 0;

  return (
    <div className={COMPACT_STRUCTURED_CARD}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-medium text-foreground">进度</div>
        <span className={COMPACT_META_CHIP}>{receipt.completedCount}/{receipt.totalCount}</span>
      </div>
      {receipt.totalCount > 0 ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-sky-500" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {receipt.currentItem ? <div className="mt-2 text-[11px] leading-5 text-muted-foreground">当前：{receipt.currentItem}</div> : null}
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
  const rows = collectPublicDetailRows(details);
  if (rows.length === 0) return null;

  return (
    <details className={COMPACT_STRUCTURED_CARD}>
      <summary className="cursor-pointer select-none text-[12px] font-medium text-foreground marker:text-muted-foreground">
        详情
      </summary>
      <StructuredDetailsRows rows={rows} />
    </details>
  );
}

function ToolActivityStructuredContent({ activity }: { activity: ToolActivityViewModel }) {
  const showDiffStatCard = activity.diffStatPlacement !== 'header';
  return (
    <>
      <ToolActivityBrowserTabCard preview={activity.browserTabPreview} />
      <ToolActivityApprovalReviews reviews={activity.approvalReviews ?? []} outcome={activity.approvalReviewOutcome} />
      {showDiffStatCard ? <ToolActivityDiffStatCard title="实时变更" diffStat={activity.liveDiffStat} /> : null}
      {showDiffStatCard && !activity.liveDiffStat ? <ToolActivityDiffStatCard title="文件变更" diffStat={activity.diffStat} /> : null}
      <ToolActivityProgressReceiptCard receipt={activity.progressReceipt} />
      <ToolActivityStructuredDetails details={activity.publicDetails} />
    </>
  );
}

export const ToolCardList = memo(function ToolCardList({
  tools,
  collapseVersion,
  sessionIdentity,
}: {
  tools: ReadonlyArray<SessionRenderToolCard>;
  collapseVersion: number;
  sessionIdentity?: SessionIdentity;
}) {
  if (tools.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      {tools.map((tool, index) => (
        <ToolCard
          key={tool.toolCallId || tool.id || `${tool.name}-${index}`}
          tool={tool}
          collapseVersion={collapseVersion}
          sessionIdentity={sessionIdentity}
        />
      ))}
    </div>
  );
});

export const AssistantEmbeddedToolResults = memo(function AssistantEmbeddedToolResults({
  embeddedToolResults,
  collapseVersion,
}: {
  embeddedToolResults: ReadonlyArray<SessionRenderAssistantBubbleToolResult>;
  collapseVersion: number;
}) {
  if (embeddedToolResults.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-col items-start gap-2">
      {embeddedToolResults.map((item) => (
        <AssistantEmbeddedToolResultCard key={item.key} item={item} collapseVersion={collapseVersion} />
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

export const UserMessageMetaBar = memo(function UserMessageMetaBar({ timestamp }: { timestamp?: number }) {
  if (!timestamp) {
    return null;
  }

  return (
    <div className="mt-0.5 flex w-full justify-end opacity-0 transition-opacity duration-200 select-none group-hover:opacity-100">
      <span className="px-1 text-[11px] leading-5 text-muted-foreground/80">
        {formatTimestamp(timestamp)}
      </span>
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

function ToolActivityRail({
  activity,
  collapseVersion,
  railKind,
  showCanvasFrame = false,
}: {
  activity: ToolActivityViewModel;
  collapseVersion: number;
  railKind: 'tool' | 'embedded-tool-result';
  showCanvasFrame?: boolean;
}) {
  const [expanded, toggleExpanded] = useVersionedDisclosure(collapseVersion);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copyBlockText = useCallback((text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }
    void navigator.clipboard.writeText(trimmedText);
    setCopiedText(trimmedText);
    window.setTimeout(() => setCopiedText(null), 1600);
  }, []);

  const canvasFrame = resolveCanvasFramePreview(activity, showCanvasFrame);
  const hasStructuredContent = hasToolActivityStructuredContent(activity);
  const canExpand = activity.canExpand || hasStructuredContent;
  const textBlocks = shouldHideRawDetailsBlock(activity)
    ? activity.textBlocks.filter((block) => block.title?.trim() !== '详情' && block.title?.trim().toLowerCase() !== 'details')
    : activity.textBlocks;

  const renderTextBlocks = (blocks: ToolActivityViewModel['textBlocks']) => (
    blocks.map((block, index) => (
      <ToolActivityTextBlock
        key={`${block.kind}-${index}`}
        block={block}
        copied={copiedText === block.text.trim()}
        onCopy={block.copyable ? () => copyBlockText(block.text) : undefined}
      />
    ))
  );

  return (
    <div
      data-compact-rail={railKind}
      className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}
    >
      <button
        type="button"
        data-chat-local-geometry-anchor="true"
        aria-label={expanded ? `收起${activity.title}` : `展开${activity.title}`}
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
          <span key={`${label.text}-${index}`} className={activityTrailingClassName(label)}>
            {label.text}
          </span>
        ))}
        {canExpand ? (
          expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : null}
      </button>
      {canvasFrame ? (
        <div className="mt-2 pl-7">
          <div className="w-full overflow-hidden rounded-[20px] bg-muted">
            <iframe
              title={canvasFrame.title}
              src={canvasFrame.url}
              className="block w-full border-0 bg-white"
              style={{ height: `${canvasFrame.preferredHeight ?? 320}px` }}
            />
          </div>
          {expanded ? (
            <div className="mt-2 space-y-2">
              <ToolActivityStructuredContent activity={activity} />
              {textBlocks.length > 0 ? renderTextBlocks(textBlocks) : null}
            </div>
          ) : null}
        </div>
      ) : expanded && canExpand ? (
        <div className="mt-2 w-full space-y-2 pl-0">
          <ToolActivityStructuredContent activity={activity} />
          {textBlocks.length > 0 ? renderTextBlocks(textBlocks) : null}
        </div>
      ) : null}
    </div>
  );
}

type AskUserQuestionOption = {
  label: string;
  description?: string;
};

type AskUserQuestionItem = {
  questionId: string;
  header: string;
  question: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
  isOther: boolean;
};

type AskUserQuestionPayload = {
  questions: AskUserQuestionItem[];
};

function readAskUserQuestion(tool: SessionRenderToolCard): AskUserQuestionPayload | null {
  if (tool.name !== 'ask_user') {
    return null;
  }
  const input = isJsonRecord(tool.input) ? tool.input : parseJsonRecord(tool.inputText);
  const questions = Array.isArray(input?.questions)
    ? input.questions.map(readAskUserQuestionItem)
    : [];
  if (questions.length === 0 || questions.some((question) => question == null)) {
    return null;
  }
  return { questions: questions as AskUserQuestionItem[] };
}

function readAskUserQuestionItem(value: unknown): AskUserQuestionItem | null {
  if (!isJsonRecord(value)) {
    return null;
  }
  const questionId = readTrimmedString(value.questionId) ?? readTrimmedString(value.id);
  const header = readTrimmedString(value.header);
  const question = readTrimmedString(value.question);
  const options = Array.isArray(value.options)
    ? value.options.map(readAskUserQuestionOption)
    : [];
  if (!questionId || !header || !question || options.length < 2 || options.some((option) => option == null)) {
    return null;
  }
  return {
    questionId,
    header,
    question,
    options: options as AskUserQuestionOption[],
    multiSelect: value.multiSelect === true,
    isOther: value.isOther !== false,
  };
}

function readAskUserQuestionOption(value: unknown): AskUserQuestionOption | null {
  if (!isJsonRecord(value)) {
    return null;
  }
  const label = readTrimmedString(value.label);
  if (!label) {
    return null;
  }
  const description = readTrimmedString(value.description);
  return { label, ...(description ? { description } : {}) };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function selectedAnswerValues(
  question: AskUserQuestionItem,
  selected: readonly string[] | undefined,
  other: string | undefined,
): string[] {
  const otherAnswer = other?.trim();
  if (!question.multiSelect && otherAnswer) {
    return [otherAnswer];
  }
  const answers = [...(selected ?? [])];
  if (otherAnswer) {
    answers.push(otherAnswer);
  }
  return answers;
}

function parseAgentSessionKey(sessionKey: string | undefined): { agentId: string; rest: string } | null {
  const raw = sessionKey?.trim();
  if (!raw || raw.slice(0, 6).toLowerCase() !== 'agent:') {
    return null;
  }
  const agentIdEnd = raw.indexOf(':', 6);
  if (agentIdEnd === -1) {
    return null;
  }
  const agentId = raw.slice(6, agentIdEnd).trim();
  const rest = raw.slice(agentIdEnd + 1);
  return agentId && rest && !rest.startsWith(':') ? { agentId, rest } : null;
}

function askUserSessionKey(sessionIdentity?: SessionIdentity): string {
  const sessionKey = sessionIdentity?.sessionKey.trim();
  if (sessionKey && parseAgentSessionKey(sessionKey)) {
    return sessionKey;
  }
  return `${sessionIdentity?.agentId.trim() || 'unknown'}\0${sessionKey || 'session:unknown'}`;
}

async function buildAskUserQuestionId(tool: SessionRenderToolCard, sessionIdentity?: SessionIdentity): Promise<string> {
  const toolCallId = tool.toolCallId || tool.id;
  const owner = tool.runId?.trim() || askUserSessionKey(sessionIdentity);
  const bytes = new TextEncoder().encode(`${owner}\0${toolCallId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `ask_${hex.slice(0, 32)}`;
}

function AskUserToolCard({
  tool,
  question,
  sessionIdentity,
}: {
  tool: SessionRenderToolCard;
  question: AskUserQuestionPayload;
  sessionIdentity?: SessionIdentity;
}) {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'submitted'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isTerminal = tool.status === 'completed' || tool.status === 'error' || tool.status === 'missing_result';
  const isDisabled = isTerminal || submitState === 'submitting' || submitState === 'submitted';
  const currentQuestion = question.questions[Math.min(currentQuestionIndex, question.questions.length - 1)]!;
  const isLastQuestion = currentQuestionIndex >= question.questions.length - 1;
  const answers = useMemo(() => {
    const next: Record<string, string[]> = {};
    for (const item of question.questions) {
      next[item.questionId] = selectedAnswerValues(item, selectedAnswers[item.questionId], otherAnswers[item.questionId]);
    }
    return next;
  }, [otherAnswers, question, selectedAnswers]);
  const currentAnswers = answers[currentQuestion.questionId] ?? [];
  const canAdvance = currentAnswers.length > 0;
  const canSubmit = question.questions.every((item) => (answers[item.questionId]?.length ?? 0) > 0);

  const goNext = useCallback(() => {
    if (!canAdvance || isLastQuestion) {
      return;
    }
    setCurrentQuestionIndex((current) => Math.min(current + 1, question.questions.length - 1));
  }, [canAdvance, isLastQuestion, question.questions.length]);

  const goBack = useCallback(() => {
    setCurrentQuestionIndex((current) => Math.max(0, current - 1));
  }, []);

  const toggleOption = useCallback((item: AskUserQuestionItem, label: string) => {
    setSubmitError(null);
    setSelectedAnswers((current) => {
      const currentAnswers = current[item.questionId] ?? [];
      const nextAnswers = item.multiSelect
        ? currentAnswers.includes(label)
          ? currentAnswers.filter((value) => value !== label)
          : [...currentAnswers, label]
        : [label];
      return { ...current, [item.questionId]: nextAnswers };
    });
    if (!item.multiSelect) {
      setOtherAnswers((current) => ({ ...current, [item.questionId]: '' }));
      if (!isLastQuestion) {
        setCurrentQuestionIndex((current) => Math.min(current + 1, question.questions.length - 1));
      }
    }
  }, [isLastQuestion, question.questions.length]);

  const updateOtherAnswer = useCallback((item: AskUserQuestionItem, value: string) => {
    setSubmitError(null);
    setOtherAnswers((current) => ({ ...current, [item.questionId]: value }));
    if (!item.multiSelect && value.trim()) {
      setSelectedAnswers((current) => ({ ...current, [item.questionId]: [] }));
    }
  }, []);

  const submitAnswer = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canSubmit || isDisabled) {
      return;
    }
    setSubmitState('submitting');
    setSubmitError(null);
    try {
      await hostOpenClawQuestionResolve({
        id: await buildAskUserQuestionId(tool, sessionIdentity),
        answers: { answers },
        resolvedBy: 'matchaclaw',
      });
      setSubmitState('submitted');
    } catch {
      setSubmitState('idle');
      setSubmitError('提交失败，请重试');
    }
  }, [answers, canSubmit, isDisabled, sessionIdentity, tool]);

  return (
    <form
      className={`${COMPACT_SIDE_RAIL_EXPANDED_WIDTH} max-w-full rounded-[18px] border border-border/45 bg-card p-3.5 text-sm shadow-sm`}
      onSubmit={submitAnswer}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <SquareTerminal className={`h-3.5 w-3.5 ${isTerminal ? 'text-muted-foreground' : 'text-sky-500'}`} />
        <span>需要你确认</span>
      </div>
      <div className="mt-3 space-y-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={COMPACT_META_CHIP}>{currentQuestion.header}</span>
            {currentQuestion.multiSelect ? <span className="text-[11px] text-muted-foreground">可多选</span> : null}
            <span className="ml-auto text-[11px] text-muted-foreground">{currentQuestionIndex + 1}/{question.questions.length}</span>
          </div>
          <div className="text-[13px] font-medium leading-5 text-foreground">{currentQuestion.question}</div>
          <div className="grid gap-1.5">
            {currentQuestion.options.map((option, index) => {
              const isSelected = currentAnswers.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={isSelected}
                  disabled={isDisabled}
                  className={`grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-[12px] border px-3 py-2 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${isSelected ? 'border-sky-500/70 bg-sky-500/10 text-foreground' : 'border-border/50 bg-muted/45 text-foreground hover:bg-muted'}`}
                  title={option.description}
                  onClick={() => toggleOption(currentQuestion, option.label)}
                >
                  <span className={`inline-flex h-4 w-4 items-center justify-center border text-[10px] font-bold ${currentQuestion.multiSelect ? 'rounded-[4px]' : 'rounded-full'} ${isSelected ? 'border-sky-500 text-sky-500' : 'border-border text-transparent'}`}>✓</span>
                  <span className="min-w-0">
                    <strong className="block truncate font-medium">{option.label}</strong>
                    {option.description ? <small className="mt-0.5 block truncate text-muted-foreground">{option.description}</small> : null}
                  </span>
                  <kbd className="font-mono text-[11px] text-muted-foreground">{index + 1}</kbd>
                </button>
              );
            })}
            {currentQuestion.isOther ? (
              <label className={`grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-[12px] border px-3 py-2 text-left text-[12px] transition-colors ${otherAnswers[currentQuestion.questionId]?.trim() ? 'border-sky-500/70 bg-sky-500/10' : 'border-border/50 bg-muted/45'}`}>
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] border border-border" />
                <input
                  type="text"
                  value={otherAnswers[currentQuestion.questionId] ?? ''}
                  disabled={isDisabled}
                  placeholder="其他回答"
                  className="min-w-0 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
                  onChange={(event) => updateOtherAnswer(currentQuestion, event.target.value)}
                />
                <kbd className="font-mono text-[11px] text-muted-foreground">{currentQuestion.options.length + 1}</kbd>
              </label>
            ) : null}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {currentQuestionIndex > 0 ? (
          <button
            type="button"
            disabled={isDisabled}
            className="inline-flex h-8 items-center justify-center rounded-full px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
            onClick={goBack}
          >
            上一步
          </button>
        ) : null}
        {!isLastQuestion ? (
          <button
            type="button"
            disabled={isDisabled || !canAdvance}
            className="ml-auto inline-flex h-8 items-center justify-center rounded-full bg-[hsl(var(--shell-icon-active))] px-3 text-[12px] font-medium text-[hsl(var(--shell-window))] transition-colors hover:bg-[hsl(var(--shell-icon-active))]/92 disabled:pointer-events-none disabled:opacity-45"
            onClick={goNext}
          >
            下一步
          </button>
        ) : (
          <button
            type="submit"
            disabled={isDisabled || !canSubmit}
            className="ml-auto inline-flex h-8 items-center justify-center rounded-full bg-[hsl(var(--shell-icon-active))] px-3 text-[12px] font-medium text-[hsl(var(--shell-window))] transition-colors hover:bg-[hsl(var(--shell-icon-active))]/92 disabled:pointer-events-none disabled:opacity-45"
          >
            {isTerminal ? '已回答' : submitState === 'submitting' ? '提交中…' : submitState === 'submitted' ? '已提交' : '提交回答'}
          </button>
        )}
        {submitError ? <span className="text-[12px] text-destructive">{submitError}</span> : null}
      </div>
    </form>
  );
}

function ToolCard({
  tool,
  collapseVersion,
  sessionIdentity,
}: {
  tool: SessionRenderToolCard;
  collapseVersion: number;
  sessionIdentity?: SessionIdentity;
}) {
  const question = useMemo(() => readAskUserQuestion(tool), [tool]);
  const activity = useMemo(() => buildToolActivityViewModel(tool), [tool]);
  if (question) {
    return <AskUserToolCard tool={tool} question={question} sessionIdentity={sessionIdentity} />;
  }
  return <ToolActivityRail activity={activity} collapseVersion={collapseVersion} railKind="tool" />;
}

function AssistantEmbeddedToolResultCard({
  item,
  collapseVersion,
}: {
  item: SessionRenderAssistantBubbleToolResult;
  collapseVersion: number;
}) {
  const activity = useMemo(() => buildCanvasActivityViewModel(item), [item]);
  if (!activity) {
    return null;
  }
  return (
    <ToolActivityRail
      activity={activity}
      collapseVersion={collapseVersion}
      railKind="embedded-tool-result"
      showCanvasFrame
    />
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

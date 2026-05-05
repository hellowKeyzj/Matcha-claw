import { useCallback, useEffect, useMemo, useState, memo } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, Wrench, FileText, Film, Music, FileArchive, File, ZoomIn, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionRenderAssistantBubbleToolResult,
  SessionRenderToolCard,
} from '../../../runtime-host/shared/session-adapter-types';
import type { ChatMessageImage } from './chat-message-view';
import { formatTimestamp } from './message-utils';
import { buildMarkdownCacheKey, getOrBuildMarkdownBody } from './md-pipeline';

export interface MessageLightboxState {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
}

export interface StreamingToolStatus {
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
  summary?: string;
}

const COMPACT_SIDE_RAIL_EXPANDED_WIDTH = 'w-[20rem] max-w-[min(20rem,calc(100vw-6.5rem))]';
const COMPACT_SIDE_RAIL_TRACK = `${COMPACT_SIDE_RAIL_EXPANDED_WIDTH} inline-flex max-w-full flex-col self-start`;
const COMPACT_SIDE_RAIL_HEADER = 'w-full rounded-none border-0 bg-transparent shadow-none backdrop-blur-0';
const COMPACT_INNER_TOGGLE = 'mx-1 w-[calc(100%-0.5rem)] rounded-[13px] border border-border/28 bg-muted/24';
const COMPACT_SUBSECTION_BODY = 'rounded-[11px] bg-background/58 px-2 py-1.5';
const COMPACT_OUTPUT_SCROLL_AREA = 'max-h-64 overflow-y-auto overscroll-contain pr-1';
const COMPACT_ICON_TOGGLE = 'inline-flex h-4 w-4 items-center justify-center rounded-[6px] text-muted-foreground/75 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border/35';
const COMPACT_SECTION_LABEL = 'text-[10px] font-medium tracking-[0.08em] text-muted-foreground/88';

function imageSrc(img: ChatMessageImage): string | null {
  if (img.url) return img.url;
  if (img.data) return `data:${img.mimeType};base64,${img.data}`;
  return null;
}

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export const ToolCardList = memo(function ToolCardList({
  tools,
  collapseVersion,
}: {
  tools: ReadonlyArray<SessionRenderToolCard>;
  collapseVersion: number;
}) {
  if (tools.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-0">
      {tools.map((tool, index) => (
        <ToolCard
          key={tool.toolCallId || tool.id || `${tool.name}-${index}`}
          tool={tool}
          collapseVersion={collapseVersion}
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
    <div className="flex flex-col items-start gap-0.5">
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
  const [expanded, setExpanded] = useState(false);
  const thinkingCacheKey = useMemo(() => `thinking:${buildMarkdownCacheKey({
    role: 'assistant',
    text: content,
    attachedFiles: [],
  })}`, [content]);
  const renderResult = useMemo(() => getOrBuildMarkdownBody(thinkingCacheKey, {
    markdown: content,
  }), [content, thinkingCacheKey]);

  useEffect(() => {
    setExpanded(false);
  }, [collapseVersion]);

  return (
    <div
      data-compact-rail="thinking"
      className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}
    >
      <div className={`${COMPACT_SIDE_RAIL_HEADER} flex w-full items-center gap-1.5 px-0 py-0.5 text-muted-foreground`}>
        <button
          type="button"
          aria-label={expanded ? '收起思考' : '展开思考'}
          className={COMPACT_ICON_TOGGLE}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className="text-[10px] font-medium uppercase tracking-[0.12em]">思考</span>
      </div>
      {expanded && (
        <div className="pt-1 text-muted-foreground">
          <div
            className="prose prose-sm dark:prose-invert max-w-none opacity-80 prose-p:leading-6"
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
            if (isImage && images.length > 0) return null;
            if (!isImage) {
              return <FileCard key={`local-${index}`} file={file} />;
            }
            if (!file.preview) {
              return <MissingImagePreview key={`local-${index}`} />;
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
              return <FileCard key={`local-${index}`} file={file} />;
            }
            if (!file.preview) {
              return <MissingImagePreview key={`local-${index}`} />;
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
}: {
  text: string;
  timestamp?: number;
}) {
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <div className="mt-0.5 flex w-full justify-start opacity-0 transition-opacity duration-200 select-none group-hover:opacity-100">
      <div className="inline-flex items-center gap-1.5 px-1 text-[11px] leading-5 text-muted-foreground/80">
        <span>{timestamp ? formatTimestamp(timestamp) : ''}</span>
        <button
          type="button"
          aria-label={copied ? 'Copied reply' : 'Copy reply'}
          title={copied ? 'Copied' : 'Copy'}
          className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground/75 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border/60"
          onClick={copyContent}
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
});

function ToolCard({
  tool,
  collapseVersion,
}: {
  tool: SessionRenderToolCard;
  collapseVersion: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const durationLabel = formatDuration(tool.durationMs);
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'error';
  const inputText = tool.inputText?.trim() ?? '';
  const result = tool.result;
  const hasInput = inputText.length > 0;
  const hasOutput = result.kind !== 'none';
  const titleText = tool.displayTitle?.trim() ?? '';
  const headerDetail = tool.displayDetail?.trim() ?? '';
  const outputPreview = (
    result.kind === 'text' || result.kind === 'json' || result.kind === 'canvas'
  )
    ? result.collapsedPreview.trim()
    : '';
  const shouldShowHeaderTitle = !headerDetail;
  const headerPrimaryLine = shouldShowHeaderTitle ? titleText : headerDetail;
  const headerSecondaryLine = hasOutput ? outputPreview : '';
  const rawOutputMarkdown = useMemo(() => {
    if (result.kind !== 'canvas' || !result.rawText?.trim()) {
      return null;
    }
    const rawMarkdown = getOrBuildMarkdownBody(`tool-output-raw:${tool.id}:${result.rawText}`, {
      markdown: `\`\`\`text\n${result.rawText}\n\`\`\``,
    }).fullHtml;
    return rawMarkdown;
  }, [result, tool.id]);
  const hasPreview = result.kind === 'canvas' && result.preview.kind === 'canvas' && result.preview.url;

  useEffect(() => {
    setExpanded(false);
    setInputExpanded(false);
    setOutputExpanded(false);
    setRawExpanded(false);
  }, [collapseVersion]);

  const renderExpandedOutput = () => {
    if (result.kind === 'none') {
      return null;
    }
    if (hasPreview && result.kind === 'canvas') {
      return (
        <div className="space-y-1">
          <div className="rounded-[12px] border border-border/22 bg-background/56 px-3 py-2 text-[11px] text-muted-foreground">
            预览已显示在助手消息里。
          </div>
          {result.rawText?.trim() ? (
            <div className="rounded-[12px] border border-border/22 bg-background/56">
              <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
                <span className={COMPACT_SECTION_LABEL}>原始内容</span>
                <button
                  type="button"
                  aria-label={rawExpanded ? '收起原始内容' : '展开原始内容'}
                  className={COMPACT_ICON_TOGGLE}
                  onClick={() => setRawExpanded((value) => !value)}
                  aria-expanded={rawExpanded}
                >
                  {rawExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                </button>
              </div>
              {rawExpanded && rawOutputMarkdown ? (
                <div
                  data-tool-output-scroll="true"
                  className={`${COMPACT_SUBSECTION_BODY} ${COMPACT_OUTPUT_SCROLL_AREA} prose prose-zinc max-w-none break-words text-[12px] dark:prose-invert prose-p:my-1 prose-pre:my-2 prose-pre:rounded-[14px] prose-pre:border-0 prose-pre:bg-transparent prose-pre:px-0 prose-pre:py-0`}
                  dangerouslySetInnerHTML={{ __html: rawOutputMarkdown }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="space-y-px">
        {result.kind === 'json' ? (
          <div className={COMPACT_SUBSECTION_BODY}>
            <div className="mb-2 text-[11px] text-muted-foreground/92">结构化结果</div>
            <pre
              data-tool-output-scroll="true"
              className={`max-w-full overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words px-0 py-0 text-[12px] text-foreground/88 ${COMPACT_OUTPUT_SCROLL_AREA}`}
            >
              {result.bodyText}
            </pre>
          </div>
        ) : result.kind === 'text' ? (
          <div
            data-tool-output-scroll="true"
            className={`${COMPACT_SUBSECTION_BODY} ${COMPACT_OUTPUT_SCROLL_AREA} whitespace-pre-wrap break-words text-[12px] text-foreground/88`}
          >
            {result.bodyText}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      data-compact-rail="tool"
      className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}
    >
      <div className={`${COMPACT_SIDE_RAIL_HEADER} rounded-[13px] border border-border/36 bg-background/72 px-2.5 py-1.5`}>
        <div className="flex items-start gap-2 text-left">
          <div className="flex shrink-0 items-center gap-1 pt-px">
            {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />}
            {!isRunning && !isError && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
            {isError && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <Wrench className="h-3.5 w-3.5 shrink-0 opacity-55" />
          </div>
          <div className="min-w-0 flex-1">
            {headerPrimaryLine ? (
              <div className={`${shouldShowHeaderTitle ? 'text-[12px] font-semibold text-foreground/92' : 'text-[11px] text-muted-foreground/80'} truncate leading-4.5`}>
                {headerPrimaryLine}
              </div>
            ) : null}
            {headerSecondaryLine ? (
              <div className="truncate text-[11px] leading-4.5 text-muted-foreground/62">
                {headerSecondaryLine}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-px">
            {!expanded && durationLabel ? <span className="text-[10px] text-muted-foreground/65">{durationLabel}</span> : null}
            {!expanded && !isRunning ? (
              <span className="text-[10px] text-muted-foreground/55">
                {isError ? '失败' : '完成'}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={expanded ? `收起工具 ${tool.name}` : `展开工具 ${tool.name}`}
              className={COMPACT_ICON_TOGGLE}
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="max-w-full space-y-0.5 pt-0.5">
              {hasInput ? (
            <div className={COMPACT_INNER_TOGGLE}>
              <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground">
                <span className={COMPACT_SECTION_LABEL}>输入参数</span>
                <button
                  type="button"
                  aria-label={inputExpanded ? '收起输入参数' : '展开输入参数'}
                  className={COMPACT_ICON_TOGGLE}
                  onClick={() => setInputExpanded((value) => !value)}
                  aria-expanded={inputExpanded}
                >
                  {inputExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                </button>
              </div>
              {inputExpanded ? (
                <div className={`${COMPACT_SUBSECTION_BODY} mx-1 mb-px mt-px`}>
                  <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                    {inputText}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
          {hasOutput ? (
            <div className={COMPACT_INNER_TOGGLE}>
              <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground">
                <span className={`truncate ${COMPACT_SECTION_LABEL}`}>
                  {result.kind === 'json' ? '输出结果 · JSON' : '输出结果'}
                </span>
                <button
                  type="button"
                  aria-label={outputExpanded ? '收起输出结果' : '展开输出结果'}
                  className={COMPACT_ICON_TOGGLE}
                  onClick={() => setOutputExpanded((value) => !value)}
                  aria-expanded={outputExpanded}
                >
                  {outputExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                </button>
              </div>
              {outputExpanded ? (
                <div className="mx-1 mb-px mt-px">
                  {renderExpandedOutput()}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AssistantEmbeddedToolResultCard({
  item,
  collapseVersion,
}: {
  item: SessionRenderAssistantBubbleToolResult;
  collapseVersion: number;
}) {
  const [rawExpanded, setRawExpanded] = useState(false);
  const rawMarkdown = useMemo(() => {
    const rawText = item.rawText?.trim() ?? '';
    if (!rawText) {
      return null;
    }
    const markdown = `\`\`\`text\n${rawText}\n\`\`\``;
    return getOrBuildMarkdownBody(`assistant-embedded-tool-result:${item.key}:${markdown}`, {
      markdown,
    }).fullHtml;
  }, [item.key, item.rawText]);

  useEffect(() => {
    setRawExpanded(false);
  }, [collapseVersion]);

  if (item.preview.kind !== 'canvas') {
    return null;
  }

  return (
    <div
      data-compact-rail="embedded-tool-result"
      className={`${COMPACT_SIDE_RAIL_TRACK} text-sm`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/42 px-0 py-1">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            内嵌结果
          </div>
          <div className="truncate text-[12px] font-medium text-foreground/90">
            {item.preview.title?.trim() || item.toolName}
          </div>
        </div>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
          画布
        </span>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-border/42 bg-background/72">
        <iframe
          title={item.preview.title?.trim() || item.toolName}
          src={item.preview.url}
          className="block w-full border-0 bg-white"
          style={{ height: `${item.preview.preferredHeight ?? 320}px` }}
        />
      </div>
      {item.rawText?.trim() ? (
          <div className="border-t border-border/42">
            <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-muted-foreground">
            <span className={COMPACT_SECTION_LABEL}>原始内容</span>
            <button
              type="button"
              aria-label={rawExpanded ? '收起原始内容' : '展开原始内容'}
              className={COMPACT_ICON_TOGGLE}
              onClick={() => setRawExpanded((value) => !value)}
              aria-expanded={rawExpanded}
            >
              {rawExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            </button>
          </div>
          {rawExpanded && rawMarkdown ? (
            <div
              data-tool-output-scroll="true"
              className={`px-2.5 pb-2.5 prose prose-zinc max-w-none break-words text-[12px] dark:prose-invert prose-p:my-1 prose-pre:my-2 prose-pre:rounded-[14px] prose-pre:border prose-pre:border-border/45 prose-pre:bg-background/88 prose-pre:px-3 prose-pre:py-2 ${COMPACT_OUTPUT_SCROLL_AREA}`}
              dangerouslySetInnerHTML={{ __html: rawMarkdown }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FileIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  if (mimeType.startsWith('video/')) return <Film className={className} />;
  if (mimeType.startsWith('audio/')) return <Music className={className} />;
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') return <FileText className={className} />;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return <FileArchive className={className} />;
  if (mimeType === 'application/pdf') return <FileText className={className} />;
  return <File className={className} />;
}

function FileCard({ file }: { file: AttachedFileMeta }) {
  const canOpen = typeof file.filePath === 'string' && file.filePath.trim().length > 0;
  const handleOpen = useCallback(() => {
    if (!canOpen) {
      return;
    }
    void invokeIpc('shell:openPath', file.filePath!);
  }, [canOpen, file.filePath]);

  if (canOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        title="Open file"
        className="flex max-w-[220px] items-center gap-2 rounded-[16px] border border-border/42 bg-background/72 px-3 py-2 text-left shadow-sm backdrop-blur-sm transition-colors hover:bg-background/84"
      >
        <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 overflow-hidden">
          <p className="text-xs font-medium truncate">{file.fileName}</p>
          <p className="text-[10px] text-muted-foreground">
            {file.fileSize > 0 ? formatFileSize(file.fileSize) : 'File'}
          </p>
        </div>
      </button>
    );
  }

  return (
    <div className="flex max-w-[220px] items-center gap-2 rounded-[16px] border border-border/42 bg-background/72 px-3 py-2 shadow-sm backdrop-blur-sm">
      <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 overflow-hidden">
        <p className="text-xs font-medium truncate">{file.fileName}</p>
        <p className="text-[10px] text-muted-foreground">
          {file.fileSize > 0 ? formatFileSize(file.fileSize) : 'File'}
        </p>
      </div>
    </div>
  );
}

function MissingImagePreview() {
  return (
    <div className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex items-center justify-center text-muted-foreground">
      <File className="h-8 w-8" />
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
      className="group/img relative h-36 w-36 cursor-zoom-in overflow-hidden rounded-[18px] border border-border/42 bg-background/72 shadow-sm backdrop-blur-sm"
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
      className="group/img relative max-w-xs cursor-zoom-in overflow-hidden rounded-[18px] border border-border/42 bg-background/68 shadow-sm backdrop-blur-sm"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="block w-full" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

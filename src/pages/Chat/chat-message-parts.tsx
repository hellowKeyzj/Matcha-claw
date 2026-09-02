import { useCallback, useMemo, useRef, useState, memo, type MouseEvent, type PointerEvent } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, SquareTerminal, Code2, FileText, Film, Music, FileArchive, File, ZoomIn, Loader2 } from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import type { AttachedFileMeta } from '@/stores/chat';
import type {
  SessionRenderAssistantBubbleToolResult,
  SessionRenderToolCard,
} from '../../types/session/tool-card';
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
const COMPACT_TEXT_BLOCK = 'w-full overflow-hidden rounded-[20px] bg-muted';
const COMPACT_OUTPUT_SCROLL_AREA = 'max-h-72 overflow-auto overscroll-contain outline-none';
const COMPACT_ICON_TOGGLE = 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:text-foreground';

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
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  }
  return <SquareTerminal className={`h-3.5 w-3.5 ${activity.isError ? 'text-destructive' : ''}`} />;
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
        <div className="flex h-10 items-center justify-between gap-3 px-4 text-foreground">
          <div className="flex min-w-0 items-center gap-2">
            {block.title ? <Code2 className="h-3.5 w-3.5 shrink-0 text-foreground/75" /> : null}
            {block.title ? <span className="truncate text-[13px] font-medium">{block.title}</span> : null}
          </div>
          {onCopy ? (
            <button
              type="button"
              aria-label={copied ? '已复制输入' : '复制输入'}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              onClick={onCopy}
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
          ) : null}
        </div>
      ) : null}
      <pre
        data-tool-output-scroll="true"
        className={`${COMPACT_OUTPUT_SCROLL_AREA} max-w-full ${block.title || onCopy ? 'px-4 pb-4 pt-1' : 'px-4 py-4'} text-[12px] leading-6 text-foreground`}
      >
        {trimmedText}
      </pre>
    </div>
  );
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
    <div className="flex w-full flex-col items-start gap-1.5">
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
            if (isImage && images.length > 0) return null;
            if (!isImage) {
              return <FileCard key={`local-${index}`} file={file} />;
            }
            if (!file.preview) {
              if (file.filePath) {
                return <FileCard key={`local-${index}`} file={file} />;
              }
              return <MissingImagePreview key={`local-${index}`} unavailable={file.previewStatus === 'unavailable'} />;
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
              return <MissingImagePreview key={`local-${index}`} unavailable={file.previewStatus === 'unavailable'} />;
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
        disabled={!activity.canExpand}
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
        {activity.canExpand ? (
          expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : null}
      </button>
      {showCanvasFrame && activity.canvasPreview ? (
        <div className="mt-2 pl-7">
          <div className="w-full overflow-hidden rounded-[20px] bg-muted">
            <iframe
              title={activity.canvasPreview.title}
              src={activity.canvasPreview.url}
              className="block w-full border-0 bg-white"
              style={{ height: `${activity.canvasPreview.preferredHeight ?? 320}px` }}
            />
          </div>
          {expanded && activity.textBlocks.length > 0 ? (
            <div className="mt-2 space-y-2">
              {renderTextBlocks(activity.textBlocks)}
            </div>
          ) : null}
        </div>
      ) : expanded && activity.canExpand ? (
        <div className="mt-2 w-full space-y-2 pl-0">
          {renderTextBlocks(activity.textBlocks)}
        </div>
      ) : null}
    </div>
  );
}

function ToolCard({
  tool,
  collapseVersion,
}: {
  tool: SessionRenderToolCard;
  collapseVersion: number;
}) {
  const activity = useMemo(() => buildToolActivityViewModel(tool), [tool]);
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

function FileCard({
  file,
  onOpen,
}: {
  file: AttachedFileMeta;
  onOpen?: (file: AttachedFileMeta) => void;
}) {
  const canOpen = typeof file.filePath === 'string' && file.filePath.trim().length > 0;
  const lastOpenEventRef = useRef<{ kind: 'pointerdown' | 'mousedown' | 'click'; at: number } | null>(null);
  const handleOpen = useCallback(() => {
    if (!canOpen) {
      return;
    }
    if (onOpen && shouldKeepAssistantAttachmentVisible(file)) {
      onOpen(file);
      return;
    }
    void invokeIpc('shell:openPath', file.filePath!);
  }, [canOpen, file, onOpen]);
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
        title="Open file"
        className="flex max-w-[220px] items-center gap-2 rounded-[16px] border border-border/42 bg-background/72 px-3 py-2 text-left shadow-sm backdrop-blur-sm transition-colors hover:bg-background/84"
      >
        <FileIcon mimeType={file.mimeType} className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 overflow-hidden">
          <p className="text-xs font-medium truncate">{file.fileName}</p>
          <p className="text-[10px] text-muted-foreground">
            {file.mimeType === DIRECTORY_MIME_TYPE ? '文件夹' : file.fileSize > 0 ? formatFileSize(file.fileSize) : 'File'}
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

function MissingImagePreview({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <div
      data-testid={unavailable ? 'chat-image-preview-unavailable' : 'chat-missing-image-preview'}
      className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex items-center justify-center text-muted-foreground"
    >
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

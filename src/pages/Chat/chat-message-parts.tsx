import { useCallback, useMemo, useState, memo } from 'react';
import { Copy, Check, ChevronDown, ChevronRight, Wrench, FileText, Film, Music, FileArchive, File, ZoomIn, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { AttachedFileMeta } from '@/stores/chat';
import type { ChatMessageImage, ChatMessageToolUse } from './chat-message-view';
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

export function ToolStatusBar({ tools }: { tools: StreamingToolStatus[] }) {
  return (
    <div className="w-full space-y-1.5">
      {tools.map((tool) => {
        const duration = formatDuration(tool.durationMs);
        const isRunning = tool.status === 'running';
        const isError = tool.status === 'error';
        return (
          <div
            key={tool.toolCallId || tool.id || tool.name}
            className={cn(
              'flex items-center gap-2 rounded-[16px] border px-3 py-2 text-xs transition-colors',
              isRunning && 'border-primary/18 bg-background/84 text-foreground',
              !isRunning && !isError && 'border-border/38 bg-background/72 text-muted-foreground',
              isError && 'border-destructive/18 bg-background/84 text-destructive',
            )}
          >
            {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />}
            {!isRunning && !isError && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
            {isError && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <Wrench className="h-3 w-3 shrink-0 opacity-60" />
            <span className="font-mono text-[11px] font-medium tracking-[-0.01em]">{tool.name}</span>
            {duration && <span className="text-[10px] opacity-60">{duration}</span>}
            {tool.summary && (
              <span className="truncate text-[10px] opacity-70">{tool.summary}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const ThinkingSection = memo(function ThinkingSection({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const thinkingCacheKey = useMemo(() => `thinking:${buildMarkdownCacheKey({
    role: 'assistant',
    text: content,
    attachedFiles: [],
  })}`, [content]);
  const renderResult = useMemo(() => getOrBuildMarkdownBody(thinkingCacheKey, {
    markdown: content,
  }), [content, thinkingCacheKey]);

  return (
    <div className="w-full rounded-[16px] border border-border/38 bg-background/72 text-sm backdrop-blur-sm">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="text-[11px] font-medium uppercase tracking-[0.12em]">Thinking</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-muted-foreground">
          <div
            className="prose prose-sm dark:prose-invert max-w-none opacity-80 prose-p:leading-6"
            dangerouslySetInnerHTML={{ __html: renderResult.fullHtml }}
          />
        </div>
      )}
    </div>
  );
});

export const ToolUseList = memo(function ToolUseList({ tools }: { tools: ReadonlyArray<ChatMessageToolUse> }) {
  if (tools.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      {tools.map((tool, index) => (
        <ToolCard key={tool.id || index} name={tool.name} input={tool.input} />
      ))}
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

function ToolCard({ name, input }: { name: string; input: unknown }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="inline-flex max-w-full flex-col self-start rounded-[16px] border border-border/38 bg-background/72 text-sm backdrop-blur-sm">
      <button
        className="inline-flex max-w-full items-center gap-1.5 px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
        <Wrench className="h-3 w-3 shrink-0 opacity-60" />
        <span className="max-w-[10rem] truncate font-mono text-[11px]">{name}</span>
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
      </button>
      {expanded && input != null && (
        <pre className="max-w-full overflow-x-auto px-2.5 pb-2.5 text-[11px] text-muted-foreground">
          {typeof input === 'string' ? input : JSON.stringify(input, null, 2) as string}
        </pre>
      )}
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

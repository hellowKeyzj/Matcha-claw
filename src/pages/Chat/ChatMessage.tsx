/**
 * Chat Message Component
 * Renders user / assistant / system / toolresult messages
 * with markdown, thinking sections, images, and tool cards.
 */
import { useState, useCallback, useEffect, useMemo, memo, type ReactNode } from 'react';
import { User, Sparkles, Copy, Check, ChevronDown, ChevronRight, Wrench, FileText, Film, Music, FileArchive, File, X, FolderOpen, ZoomIn, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import type { RawMessage, AttachedFileMeta } from '@/stores/chat';
import { extractText, extractThinking, extractImages, extractToolUse, formatTimestamp } from './message-utils';

interface ChatMessageProps {
  message: RawMessage;
  showThinking: boolean;
  assistantAvatarEmoji?: string;
  userAvatarImageUrl?: string | null;
  isStreaming?: boolean;
  streamingTools?: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
}

interface ExtractedImage { url?: string; data?: string; mimeType: string; }

/** Resolve an ExtractedImage to a displayable src string, or null if not possible. */
function imageSrc(img: ExtractedImage): string | null {
  if (img.url) return img.url;
  if (img.data) return `data:${img.mimeType};base64,${img.data}`;
  return null;
}

const FILE_LINK_EXTENSIONS = 'md|txt|json|ya?ml|csv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|svg|mp4|mov|avi|mkv|webm|mp3|wav|ogg|aac|zip|tar|gz|rar|7z';
const FILE_HINT_RE = new RegExp(
  String.raw`(^|[^\p{L}\p{N}_./\\-])((?:\.{1,2}[\\/])?[\p{L}\p{N}_./\\-]+?\.(?:${FILE_LINK_EXTENSIONS}))(?=$|[^\p{L}\p{N}_./\\-])`,
  'giu',
);
const MARKDOWN_LINK_SEGMENT_RE = /^!?\[[^\]\n]+\]\([^)]+\)$/u;
const FILE_PATH_WITH_EXT_RE = new RegExp(String.raw`\.(?:${FILE_LINK_EXTENSIONS})(?:$|[?#])`, 'iu');
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-z]:[\\/]/i;
const LOCAL_RELATIVE_PATH_RE = /^\.{1,2}[\\/]/;
type FileHintPathResolver = (displayPath: string) => string | undefined;

function decodeMaybeEncodedPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function getFileNameFromPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0];
  const parts = withoutQuery.split(/[\\/]/);
  return parts[parts.length - 1] || withoutQuery;
}

function isAbsoluteLikePath(path: string): boolean {
  const normalized = path.trim();
  return (
    normalized.startsWith('/')
    || normalized.startsWith('~/')
    || normalized.startsWith('\\\\')
    || WINDOWS_ABSOLUTE_PATH_RE.test(normalized)
  );
}

function looksLikeAbsoluteFilePath(path: string): boolean {
  const normalized = decodeMaybeEncodedPath(path.trim());
  if (!isAbsoluteLikePath(normalized)) {
    return false;
  }
  return FILE_PATH_WITH_EXT_RE.test(normalized);
}

function createFileHintPathResolver(
  attachedFiles: AttachedFileMeta[],
): FileHintPathResolver | undefined {
  const nameToAbsolutePaths = new Map<string, string[]>();
  const attachedAbsolutePaths = new Set<string>();

  const addAbsolutePath = (candidate?: string): void => {
    if (!candidate) {
      return;
    }
    const normalized = decodeMaybeEncodedPath(candidate.trim());
    if (!looksLikeAbsoluteFilePath(normalized)) {
      return;
    }
    attachedAbsolutePaths.add(normalized);
    const fileName = getFileNameFromPath(normalized).toLowerCase();
    if (!fileName) {
      return;
    }
    const existingPaths = nameToAbsolutePaths.get(fileName);
    if (!existingPaths) {
      nameToAbsolutePaths.set(fileName, [normalized]);
      return;
    }
    if (!existingPaths.includes(normalized)) {
      existingPaths.push(normalized);
    }
  };

  for (const file of attachedFiles) {
    addAbsolutePath(file.filePath);
  }

  if (nameToAbsolutePaths.size === 0) {
    return undefined;
  }

  return (displayPath: string): string | undefined => {
    const normalized = decodeMaybeEncodedPath(displayPath.trim());
    if (!normalized) {
      return undefined;
    }
    if (isAbsoluteLikePath(normalized)) {
      return attachedAbsolutePaths.has(normalized) ? normalized : undefined;
    }
    const fileName = getFileNameFromPath(normalized).toLowerCase();
    const candidates = nameToAbsolutePaths.get(fileName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    // Keep stable behavior: when multiple absolute paths share same file name,
    // use the first collected path from this message's attachments.
    return candidates[0];
  };
}

function shouldMigrateLegacyLocalMarkdownHref(rawHref: string): boolean {
  const href = rawHref.trim();
  if (!href || href.startsWith('#') || href.startsWith('filehint:')) {
    return false;
  }

  const decoded = decodeMaybeEncodedPath(href);
  if (/^(https?:\/\/|mailto:|tel:|data:|javascript:)/i.test(decoded)) {
    return false;
  }

  const isWindowsAbsolutePath = WINDOWS_ABSOLUTE_PATH_RE.test(decoded);
  if (URI_SCHEME_RE.test(decoded) && !isWindowsAbsolutePath) {
    return false;
  }

  if (
    isWindowsAbsolutePath
    || decoded.startsWith('\\\\')
    || decoded.startsWith('/')
    || decoded.startsWith('~/')
    || LOCAL_RELATIVE_PATH_RE.test(decoded)
  ) {
    return true;
  }

  return FILE_PATH_WITH_EXT_RE.test(decoded);
}

function migrateLegacyMarkdownFileLinks(text: string, resolveFileHintPath?: FileHintPathResolver): string {
  if (!text) return text;
  const chunks = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return chunks.map((chunk) => {
    if (chunk.startsWith('```') || (chunk.startsWith('`') && chunk.endsWith('`'))) {
      return chunk;
    }
    return chunk.replace(/(!?\[[^\]\n]+\])\(([^)\n]+)\)/g, (full, label: string, href: string) => {
      if (!shouldMigrateLegacyLocalMarkdownHref(href)) {
        return full;
      }
      const normalized = decodeMaybeEncodedPath(href.trim());
      const resolvedPath = resolveFileHintPath?.(normalized);
      if (!resolvedPath || !looksLikeAbsoluteFilePath(resolvedPath)) {
        return normalized;
      }
      return `${label}(filehint:${encodeURIComponent(resolvedPath)})`;
    });
  }).join('');
}

function linkifyFileHintsInMarkdown(text: string, resolveFileHintPath?: FileHintPathResolver): string {
  if (!text) return text;
  const chunks = text.split(/(```[\s\S]*?```|`[^`\n]*`|!?\[[^\]\n]+\]\([^)]+\))/g);
  return chunks.map((chunk) => {
    if (
      chunk.startsWith('```')
      || (chunk.startsWith('`') && chunk.endsWith('`'))
      || MARKDOWN_LINK_SEGMENT_RE.test(chunk)
    ) {
      return chunk;
    }
    return chunk.replace(FILE_HINT_RE, (full, prefix: string, path: string) => {
      if (!path || path.includes('://')) {
        return full;
      }
      const normalized = path.trim();
      const resolvedPath = resolveFileHintPath?.(normalized);
      if (!resolvedPath || !looksLikeAbsoluteFilePath(resolvedPath)) {
        return full;
      }
      return `${prefix}[${normalized}](filehint:${encodeURIComponent(resolvedPath)})`;
    });
  }).join('');
}

export const ChatMessage = memo(function ChatMessage({
  message,
  showThinking,
  assistantAvatarEmoji,
  userAvatarImageUrl,
  isStreaming = false,
  streamingTools = [],
}: ChatMessageProps) {
  const isUser = message.role === 'user';
  const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
  const isToolResult = role === 'toolresult' || role === 'tool_result';
  const text = extractText(message);
  const hasText = text.trim().length > 0;
  const thinking = extractThinking(message);
  const images = extractImages(message);
  const tools = extractToolUse(message);
  const visibleThinking = showThinking ? thinking : null;
  const visibleTools = tools;

  const attachedFiles = useMemo(
    () => (Array.isArray(message._attachedFiles) ? message._attachedFiles : []),
    [message._attachedFiles],
  );
  const resolveFileHintPath = useMemo(
    () => createFileHintPathResolver(attachedFiles),
    [attachedFiles],
  );
  const [lightboxImg, setLightboxImg] = useState<{ src: string; fileName: string; filePath?: string; base64?: string; mimeType?: string } | null>(null);

  // Never render tool result messages in chat UI
  if (isToolResult) return null;

  const hasStreamingToolStatus = isStreaming && streamingTools.length > 0;
  if (!hasText && !visibleThinking && images.length === 0 && visibleTools.length === 0 && attachedFiles.length === 0 && !hasStreamingToolStatus) return null;

  return (
    <div
      className={cn(
        'flex gap-3 group',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white',
        )}
      >
        {isUser ? (
          userAvatarImageUrl ? (
            <img
              src={userAvatarImageUrl}
              alt="user-avatar"
              className="h-full w-full rounded-full object-cover"
            />
          ) : (
            <User className="h-4 w-4" />
          )
        ) : (
          assistantAvatarEmoji ? <span className="text-base leading-none">{assistantAvatarEmoji}</span> : <Sparkles className="h-4 w-4" />
        )}
      </div>

      {/* Content */}
      <div
        className={cn(
          'flex flex-col w-full min-w-0 max-w-[80%] space-y-2',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        {isStreaming && !isUser && streamingTools.length > 0 && (
          <ToolStatusBar tools={streamingTools} />
        )}

        {/* Thinking section */}
        {visibleThinking && (
          <ThinkingBlock content={visibleThinking} />
        )}

        {/* Tool use cards */}
        {visibleTools.length > 0 && (
          <div className="space-y-1">
            {visibleTools.map((tool, i) => (
              <ToolCard key={tool.id || i} name={tool.name} input={tool.input} />
            ))}
          </div>
        )}

        {/* Images — rendered ABOVE text bubble for user messages */}
        {/* Images from content blocks (Gateway session data / channel push photos) */}
        {isUser && images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImageThumbnail
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  base64={img.data}
                  mimeType={img.mimeType}
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — images above text for user, file cards below */}
        {isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              // Skip image attachments if we already have images from content blocks
              if (isImage && images.length > 0) return null;
              if (isImage) {
                return file.preview ? (
                  <ImageThumbnail
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
                    filePath={file.filePath}
                    mimeType={file.mimeType}
                    onPreview={() => setLightboxImg({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                  />
                ) : (
                  <div
                    key={`local-${i}`}
                    className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex items-center justify-center text-muted-foreground"
                  >
                    <File className="h-8 w-8" />
                  </div>
                );
              }
              // Non-image files → file card
              return <FileCard key={`local-${i}`} file={file} />;
            })}
          </div>
        )}

        {/* Main text bubble */}
        {hasText && (
          <MessageBubble
            text={text}
            isUser={isUser}
            isStreaming={isStreaming}
            resolveFileHintPath={resolveFileHintPath}
          />
        )}

        {/* Images from content blocks — assistant messages (below text) */}
        {!isUser && images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImagePreviewCard
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  base64={img.data}
                  mimeType={img.mimeType}
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — assistant messages (below text) */}
        {!isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              if (isImage && images.length > 0) return null;
              if (isImage && file.preview) {
                return (
                  <ImagePreviewCard
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
                    filePath={file.filePath}
                    mimeType={file.mimeType}
                    onPreview={() => setLightboxImg({ src: file.preview!, fileName: file.fileName, filePath: file.filePath, mimeType: file.mimeType })}
                  />
                );
              }
              if (isImage && !file.preview) {
                return (
                  <div key={`local-${i}`} className="w-36 h-36 rounded-xl border overflow-hidden bg-muted flex items-center justify-center text-muted-foreground">
                    <File className="h-8 w-8" />
                  </div>
                );
              }
              return <FileCard key={`local-${i}`} file={file} />;
            })}
          </div>
        )}

        {/* Hover row for user messages — timestamp only */}
        {isUser && message.timestamp && (
          <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none">
            {formatTimestamp(message.timestamp)}
          </span>
        )}

        {/* Hover row for assistant messages — only when there is real text content */}
        {!isUser && hasText && (
          <AssistantHoverBar text={text} timestamp={message.timestamp} />
        )}
      </div>

      {/* Image lightbox portal */}
      {lightboxImg && (
        <ImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          base64={lightboxImg.base64}
          mimeType={lightboxImg.mimeType}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </div>
  );
});

function formatDuration(durationMs?: number): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function ToolStatusBar({
  tools,
}: {
  tools: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
}) {
  return (
    <div className="w-full space-y-1">
      {tools.map((tool) => {
        const duration = formatDuration(tool.durationMs);
        const isRunning = tool.status === 'running';
        const isError = tool.status === 'error';
        return (
          <div
            key={tool.toolCallId || tool.id || tool.name}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors',
              isRunning && 'border-primary/30 bg-primary/5 text-foreground',
              !isRunning && !isError && 'border-border/50 bg-muted/20 text-muted-foreground',
              isError && 'border-destructive/30 bg-destructive/5 text-destructive',
            )}
          >
            {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />}
            {!isRunning && !isError && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />}
            {isError && <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <Wrench className="h-3 w-3 shrink-0 opacity-60" />
            <span className="font-mono text-[12px] font-medium">{tool.name}</span>
            {duration && <span className="text-[11px] opacity-60">{duration}</span>}
            {tool.summary && (
              <span className="truncate text-[11px] opacity-70">{tool.summary}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Assistant hover bar (timestamp + copy, shown on group hover) ─

const AssistantHoverBar = memo(function AssistantHoverBar({ text, timestamp }: { text: string; timestamp?: number }) {
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <div className="flex items-center justify-between w-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 select-none px-1">
      <span className="text-xs text-muted-foreground">
        {timestamp ? formatTimestamp(timestamp) : ''}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={copyContent}
      >
        {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      </Button>
    </div>
  );
});

// ── Message Bubble ──────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  text,
  isUser,
  isStreaming,
  resolveFileHintPath,
}: {
  text: string;
  isUser: boolean;
  isStreaming: boolean;
  resolveFileHintPath?: FileHintPathResolver;
}) {
  const handleOpenFileHint = useCallback(async (hintPath: string) => {
    if (!hintPath) {
      return;
    }
    try {
      await invokeIpc('shell:showItemInFolder', hintPath);
    } catch {
      // ignore open errors
    }
  }, []);

  const markdownContent = useMemo(
    () => linkifyFileHintsInMarkdown(
      migrateLegacyMarkdownFileLinks(text, resolveFileHintPath),
      resolveFileHintPath,
    ),
    [resolveFileHintPath, text],
  );

  const markdownComponents = useMemo(
    () => ({
      code({ className, children, ...props }: { className?: string; children?: ReactNode }) {
        const match = /language-(\w+)/.exec(className || '');
        const isInline = !match && !className;
        if (isInline) {
          return (
            <code className="bg-background/50 px-1.5 py-0.5 rounded text-sm font-mono break-words break-all" {...props}>
              {children}
            </code>
          );
        }
        return (
          <pre className="bg-background/50 rounded-lg p-4 overflow-x-auto">
            <code className={cn('text-sm font-mono', className)} {...props}>
              {children}
            </code>
          </pre>
        );
      },
      a({ href, children }: { href?: string; children?: ReactNode }) {
        const rawHref = typeof href === 'string' ? href : '';
        if (rawHref.startsWith('filehint:')) {
          const encodedHint = rawHref.slice('filehint:'.length);
          const decodedHint = decodeMaybeEncodedPath(encodedHint);
          return (
            <button
              type="button"
              className="inline cursor-pointer rounded-sm text-primary underline underline-offset-2 hover:text-primary/80"
              onClick={() => void handleOpenFileHint(decodedHint)}
            >
              {children}
            </button>
          );
        }
        return (
          <a href={rawHref} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-words break-all">
            {children}
          </a>
        );
      },
    }),
    [handleOpenFileHint],
  );

  return (
    <div
      className={cn(
        'relative rounded-2xl px-4 py-3',
        !isUser && 'w-full',
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted',
      )}
    >
      {isUser ? (
        <p className="whitespace-pre-wrap break-words break-all text-sm">{text}</p>
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none break-words break-all">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => {
              if (url.startsWith('filehint:')) {
                return url;
              }
              return defaultUrlTransform(url);
            }}
            components={markdownComponents}
          >
            {markdownContent}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-foreground/50 animate-pulse ml-0.5" />
          )}
        </div>
      )}

    </div>
  );
});

// ── Thinking Block ──────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="w-full rounded-lg border border-border/50 bg-muted/30 text-sm">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-medium">Thinking</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-muted-foreground">
          <div className="prose prose-sm dark:prose-invert max-w-none opacity-75">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ── File Card (for user-uploaded non-image files) ───────────────

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
    void invokeIpc('shell:showItemInFolder', file.filePath!);
  }, [canOpen, file.filePath]);

  if (canOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 bg-muted/30 max-w-[220px] text-left cursor-pointer hover:bg-muted/50 transition-colors"
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
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 bg-muted/30 max-w-[220px]">
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

// ── Image Thumbnail (user bubble — square crop with zoom hint) ──

function ImageThumbnail({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onPreview,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onPreview: () => void;
}) {
  void filePath; void base64; void mimeType;
  return (
    <div
      className="relative w-36 h-36 rounded-xl border overflow-hidden bg-muted group/img cursor-zoom-in"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="w-full h-full object-cover" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/25 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

// ── Image Preview Card (assistant bubble — natural size with overlay actions) ──

function ImagePreviewCard({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onPreview,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onPreview: () => void;
}) {
  void filePath; void base64; void mimeType;
  return (
    <div
      className="relative max-w-xs rounded-lg border overflow-hidden group/img cursor-zoom-in"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="block w-full" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

// ── Image Lightbox ───────────────────────────────────────────────

function ImageLightbox({
  src,
  fileName,
  filePath,
  base64,
  mimeType,
  onClose,
}: {
  src: string;
  fileName: string;
  filePath?: string;
  base64?: string;
  mimeType?: string;
  onClose: () => void;
}) {
  void src; void base64; void mimeType; void fileName;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleShowInFolder = useCallback(() => {
    if (filePath) {
      invokeIpc('shell:showItemInFolder', filePath);
    }
  }, [filePath]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Image + buttons stacked */}
      <div
        className="flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt={fileName}
          className="max-w-[90vw] max-h-[85vh] rounded-lg shadow-2xl object-contain"
        />

        {/* Action buttons below image */}
        <div className="flex items-center gap-2">
          {filePath && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white"
              onClick={handleShowInFolder}
              title="在文件夹中显示"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Tool Card ───────────────────────────────────────────────────

const ToolCard = memo(function ToolCard({ name, input }: { name: string; input: unknown }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 text-sm">
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
        <Wrench className="h-3 w-3 shrink-0 opacity-60" />
        <span className="font-mono text-xs">{name}</span>
        {expanded ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>
      {expanded && input != null && (
        <pre className="px-3 pb-2 text-xs text-muted-foreground overflow-x-auto">
          {typeof input === 'string' ? input : JSON.stringify(input, null, 2) as string}
        </pre>
      )}
    </div>
  );
});

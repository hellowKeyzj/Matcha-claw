/**
 * Chat Message Component
 * Renders user / assistant / system / toolresult messages
 * with markdown, thinking sections, images, and tool cards.
 */
import { startTransition, useEffect, useState, useCallback, useMemo, memo, type ReactNode } from 'react';
import { User, Copy, Check, ChevronDown, ChevronRight, Wrench, FileText, Film, Music, FileArchive, File, ZoomIn, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import {
  prewarmAssistantMarkdownBody,
  getMessageAttachedFiles,
  peekAssistantMarkdownBody,
} from '@/lib/chat-markdown-body';
import type { RawMessage, AttachedFileMeta } from '@/stores/chat';
import { extractText, extractThinking, extractImages, extractToolUse, formatTimestamp } from './message-utils';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import {
  buildMarkdownCacheKey,
  decodeFileHintHref,
  getOrBuildMarkdownBody,
} from './md-pipeline';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import { CsvPreview } from './components/CsvPreview';
import { StructuredTablePreview } from './components/StructuredTablePreview';

interface ChatMessageProps {
  message: RawMessage;
  showThinking: boolean;
  suppressToolCards?: boolean;
  assistantAgentId?: string;
  assistantAgentName?: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
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

type MarkdownWarmupHandle = number | ReturnType<typeof setTimeout>;

function scheduleMarkdownWarmup(task: () => void): MarkdownWarmupHandle {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      return win.requestIdleCallback(() => task(), { timeout: 120 });
    }
  }
  return setTimeout(task, 0);
}

function cancelMarkdownWarmup(handle: MarkdownWarmupHandle): void {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.cancelIdleCallback === 'function' && typeof handle === 'number') {
      win.cancelIdleCallback(handle);
      return;
    }
  }
  clearTimeout(handle);
}

/** Resolve an ExtractedImage to a displayable src string, or null if not possible. */
function imageSrc(img: ExtractedImage): string | null {
  if (img.url) return img.url;
  if (img.data) return `data:${img.mimeType};base64,${img.data}`;
  return null;
}


export const ChatMessage = memo(function ChatMessage({
  message,
  showThinking,
  suppressToolCards = false,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
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
  const visibleTools = suppressToolCards ? [] : tools;

  const attachedFiles = useMemo(
    () => getMessageAttachedFiles(message),
    [message],
  );
  const [lightboxImg, setLightboxImg] = useState<{ src: string; fileName: string; filePath?: string; base64?: string; mimeType?: string } | null>(null);

  // Never render tool result messages in chat UI
  if (isToolResult) return null;

  const hasStreamingToolStatus = isStreaming && streamingTools.length > 0;
  if (!hasText && !visibleThinking && images.length === 0 && visibleTools.length === 0 && attachedFiles.length === 0 && !hasStreamingToolStatus) return null;

  return (
    <>
      <MessageShell
        isUser={isUser}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
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
          <div className="space-y-1.5">
            {visibleTools.map((tool, i) => (
              <ToolCard key={tool.id || i} name={tool.name} input={tool.input} />
            ))}
          </div>
        )}

        {/* Images — rendered ABOVE text bubble for user messages */}
        {/* Images from content blocks (Gateway session data / channel push photos) */}
        {isUser && images.length > 0 && (
          <div className="flex flex-wrap gap-2.5">
            {images.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImageThumbnail
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — images above text for user, file cards below */}
        {isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2.5">
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
        <MessageBody
          text={text}
          message={message}
            isUser={isUser}
            isStreaming={isStreaming}
          />
        )}

        {/* Images from content blocks — assistant messages (below text) */}
        {!isUser && images.length > 0 && (
          <div className="flex flex-wrap gap-2.5">
            {images.map((img, i) => {
              const src = imageSrc(img);
              if (!src) return null;
              return (
                <ImagePreviewCard
                  key={`content-${i}`}
                  src={src}
                  fileName="image"
                  onPreview={() => setLightboxImg({ src, fileName: 'image', base64: img.data, mimeType: img.mimeType })}
                />
              );
            })}
          </div>
        )}

        {/* File attachments — assistant messages (below text) */}
        {!isUser && attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2.5">
            {attachedFiles.map((file, i) => {
              const isImage = file.mimeType.startsWith('image/');
              if (isImage && images.length > 0) return null;
              if (isImage && file.preview) {
                return (
                  <ImagePreviewCard
                    key={`local-${i}`}
                    src={file.preview}
                    fileName={file.fileName}
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
          <div className="flex w-full justify-end">
            <span className="inline-flex items-center rounded-full border border-border/50 bg-background/72 px-2 py-0.5 text-[11px] text-muted-foreground opacity-0 shadow-sm transition-opacity duration-200 select-none group-hover:opacity-100">
              {formatTimestamp(message.timestamp)}
            </span>
          </div>
        )}

        {/* Hover row for assistant messages — only when there is real text content */}
        {!isUser && hasText && (
          <AssistantHoverBar text={text} timestamp={message.timestamp} />
        )}
      </MessageShell>

      {/* Image lightbox portal */}
      {lightboxImg && (
        <ChatImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </>
  );
});

function MessageShell({
  isUser,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  children,
}: {
  isUser: boolean;
  assistantAgentId?: string;
  assistantAgentName?: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarImageUrl?: string | null;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        CHAT_LAYOUT_TOKENS.messageShell,
        isUser
          ? CHAT_LAYOUT_TOKENS.messageShellUserColumns
          : CHAT_LAYOUT_TOKENS.messageShellAssistantColumns,
      )}
    >
      <div
        className={cn(
          CHAT_LAYOUT_TOKENS.messageAvatar,
          isUser
            ? CHAT_LAYOUT_TOKENS.messageAvatarUserOrder
            : CHAT_LAYOUT_TOKENS.messageAvatarAssistantOrder,
          'border border-border/60 bg-background/85 text-foreground shadow-sm backdrop-blur-sm',
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
          <AgentAvatar
            agentId={assistantAgentId}
            agentName={assistantAgentName}
            avatarSeed={assistantAvatarSeed}
            avatarStyle={assistantAvatarStyle}
            className="h-full w-full"
            dataTestId="assistant-message-avatar"
          />
        )}
      </div>

      <div
        className={cn(
          CHAT_LAYOUT_TOKENS.messageContentColumn,
          isUser
            ? CHAT_LAYOUT_TOKENS.messageContentUserOrder
            : CHAT_LAYOUT_TOKENS.messageContentAssistantOrder,
        )}
      >
        {children}
      </div>
    </div>
  );
}

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
    <div className="w-full space-y-1.5">
      {tools.map((tool) => {
        const duration = formatDuration(tool.durationMs);
        const isRunning = tool.status === 'running';
        const isError = tool.status === 'error';
        return (
          <div
            key={tool.toolCallId || tool.id || tool.name}
            className={cn(
              'flex items-center gap-2 rounded-[18px] border px-3 py-2 text-xs shadow-sm backdrop-blur-sm transition-colors',
              isRunning && 'border-primary/20 bg-background/78 text-foreground',
              !isRunning && !isError && 'border-border/45 bg-background/68 text-muted-foreground',
              isError && 'border-destructive/20 bg-background/78 text-destructive',
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

// ── Assistant hover bar (timestamp + copy, shown on group hover) ─

const AssistantHoverBar = memo(function AssistantHoverBar({ text, timestamp }: { text: string; timestamp?: number }) {
  const [copied, setCopied] = useState(false);

  const copyContent = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <div className="flex w-full justify-start opacity-0 transition-opacity duration-200 select-none group-hover:opacity-100">
      <div className="inline-flex items-center gap-1 rounded-full border border-border/45 bg-background/68 px-1.5 py-0.5 shadow-sm backdrop-blur-sm">
        <span className="px-1 text-[11px] text-muted-foreground">
          {timestamp ? formatTimestamp(timestamp) : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 rounded-full"
          onClick={copyContent}
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
    </div>
  );
});

// ── Message Bubble ──────────────────────────────────────────────

const MessageBody = memo(function MessageBody({
  text,
  message,
  isUser,
  isStreaming,
}: {
  text: string;
  message: RawMessage;
  isUser: boolean;
  isStreaming: boolean;
}) {
  if (isUser) {
    return (
      <div
        className={CHAT_LAYOUT_TOKENS.userBubble}
      >
        <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.6]">{text}</p>
      </div>
    );
  }

  return (
    <AssistantMessageBody
      text={text}
      message={message}
      isStreaming={isStreaming}
    />
  );
});

const AssistantMessageBody = memo(function AssistantMessageBody({
  text,
  message,
  isStreaming,
}: {
  text: string;
  message: RawMessage;
  isStreaming: boolean;
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

  const renderMode = isStreaming ? 'streaming' : 'settled';
  const [cacheVersion, setCacheVersion] = useState(0);
  const markdownBody = useMemo(
    () => peekAssistantMarkdownBody(message, renderMode),
    [cacheVersion, message, renderMode],
  );

  useEffect(() => {
    if (isStreaming || markdownBody) {
      return;
    }
    let cancelled = false;
    const handle = scheduleMarkdownWarmup(() => {
      if (cancelled) {
        return;
      }
      if (!prewarmAssistantMarkdownBody(message, renderMode)) {
        return;
      }
      if (cancelled) {
        return;
      }
      startTransition(() => {
        setCacheVersion((version) => version + 1);
      });
    });

    return () => {
      cancelled = true;
      cancelMarkdownWarmup(handle);
    };
  }, [isStreaming, markdownBody, message, renderMode]);

  const streamingMarkdownBody = useMemo(
    () => (isStreaming && !markdownBody ? prewarmAssistantMarkdownBody(message, renderMode) : markdownBody),
    [isStreaming, markdownBody, message, renderMode],
  );
  const resolvedMarkdownBody = streamingMarkdownBody ?? markdownBody;
  const renderNodes = resolvedMarkdownBody?.nodes ?? [];

  const handleMarkdownClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }
    const decodedHint = decodeFileHintHref(anchor.href);
    if (!decodedHint) {
      return;
    }
    event.preventDefault();
    void handleOpenFileHint(decodedHint);
  }, [handleOpenFileHint]);

  return (
    <div
      data-chat-body-mode="full"
      className={cn(
        CHAT_LAYOUT_TOKENS.assistantSurface,
        'relative',
      )}
    >
      <div className="space-y-3.5 text-[14px] leading-[1.75] text-foreground">
        {!resolvedMarkdownBody && (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.75] text-foreground">{text}</p>
        )}
        {renderNodes.map((node) => {
          if (node.kind === 'csv') {
            return (
              <CsvPreview
                key={node.key}
                csv={node.csv}
              />
            );
          }

          if (node.kind === 'markdown_table') {
            return (
              <StructuredTablePreview
                key={node.key}
                rows={node.rows}
              />
            );
          }

          if (!node.html.trim()) {
            return null;
          }

          return (
            <div
              key={node.key}
              className="prose prose-zinc max-w-none break-words dark:prose-invert prose-headings:mb-3 prose-headings:mt-5 prose-headings:tracking-[-0.02em] prose-p:my-0 prose-p:leading-7 prose-pre:my-3 prose-pre:rounded-2xl prose-pre:border prose-pre:border-border/60 prose-pre:bg-background/92 prose-pre:px-4 prose-pre:py-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-blockquote:border-l-border/70 prose-blockquote:text-muted-foreground prose-blockquote:italic prose-code:rounded prose-code:bg-background/82 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.92em]"
              onClick={handleMarkdownClick}
              dangerouslySetInnerHTML={{ __html: node.html }}
            />
          );
        })}
        {isStreaming ? <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/50 align-text-bottom" /> : null}
      </div>
    </div>
  );
});

// ── Thinking Block ──────────────────────────────────────────────

function ThinkingBlock({ content }: { content: string }) {
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
    <div className="w-full rounded-[18px] border border-border/45 bg-background/62 text-sm shadow-sm backdrop-blur-sm">
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
    void invokeIpc('shell:openPath', file.filePath!);
  }, [canOpen, file.filePath]);

  if (canOpen) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        title="Open file"
        className="flex max-w-[220px] items-center gap-2 rounded-[18px] border border-border/50 bg-background/72 px-3 py-2 text-left shadow-sm backdrop-blur-sm transition-colors hover:bg-background/88"
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
    <div className="flex max-w-[220px] items-center gap-2 rounded-[18px] border border-border/50 bg-background/72 px-3 py-2 shadow-sm backdrop-blur-sm">
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
  onPreview,
}: {
  src: string;
  fileName: string;
  onPreview: () => void;
}) {
  return (
    <div
      className="group/img relative h-36 w-36 cursor-zoom-in overflow-hidden rounded-[20px] border border-border/50 bg-background/72 shadow-sm backdrop-blur-sm"
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
  onPreview,
}: {
  src: string;
  fileName: string;
  onPreview: () => void;
}) {
  return (
    <div
      className="group/img relative max-w-xs cursor-zoom-in overflow-hidden rounded-[20px] border border-border/50 bg-background/68 shadow-sm backdrop-blur-sm"
      onClick={onPreview}
    >
      <img src={src} alt={fileName} className="block w-full" />
      <div className="absolute inset-0 bg-black/0 group-hover/img:bg-black/20 transition-colors flex items-center justify-center">
        <ZoomIn className="h-6 w-6 text-white opacity-0 group-hover/img:opacity-100 transition-opacity drop-shadow" />
      </div>
    </div>
  );
}

// ── Tool Card ───────────────────────────────────────────────────

const ToolCard = memo(function ToolCard({ name, input }: { name: string; input: unknown }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-[18px] border border-border/45 bg-background/62 text-sm shadow-sm backdrop-blur-sm">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
        <Wrench className="h-3 w-3 shrink-0 opacity-60" />
        <span className="font-mono text-[11px]">{name}</span>
        {expanded ? <ChevronDown className="h-3 w-3 ml-auto" /> : <ChevronRight className="h-3 w-3 ml-auto" />}
      </button>
      {expanded && input != null && (
        <pre className="overflow-x-auto px-3 pb-3 text-[11px] text-muted-foreground">
          {typeof input === 'string' ? input : JSON.stringify(input, null, 2) as string}
        </pre>
      )}
    </div>
  );
});

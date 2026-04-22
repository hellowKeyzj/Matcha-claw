/**
 * Chat Message Component
 * Renders user / assistant / system / toolresult messages
 * with markdown, thinking sections, images, and tool cards.
 */
import { useState, useCallback, useEffect, useMemo, memo, type ReactNode } from 'react';
import { User, Copy, Check, ChevronDown, ChevronRight, Wrench, FileText, Film, Music, FileArchive, File, X, FolderOpen, ZoomIn, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { createPortal } from 'react-dom';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import type { RawMessage, AttachedFileMeta } from '@/stores/chat';
import { extractText, extractThinking, extractImages, extractToolUse, formatTimestamp } from './message-utils';
import {
  createFileHintPathResolver,
  linkifyFileHintsInMarkdown,
  migrateLegacyMarkdownFileLinks,
  type FileHintPathResolver,
} from './md-link';
import {
  buildMarkdownCacheKey,
  decodeFileHintHref,
  getOrBuildMarkdownBody,
  shouldUseLiteMarkdown,
  type MarkdownBodyRenderMode,
} from './md-pipeline';

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
  bodyRenderMode?: MarkdownBodyRenderMode;
  onRequestFullRender?: () => void;
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
  bodyRenderMode,
  onRequestFullRender,
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
    () => (Array.isArray(message._attachedFiles) ? message._attachedFiles : []),
    [message._attachedFiles],
  );
  const resolveFileHintPath = useMemo(
    () => createFileHintPathResolver(attachedFiles),
    [attachedFiles],
  );
  const markdownCacheKey = useMemo(() => {
    return buildMarkdownCacheKey({
      messageId: typeof message.id === 'string' ? message.id : undefined,
      role: typeof message.role === 'string' ? message.role : undefined,
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
      text,
      attachedFiles,
    });
  }, [attachedFiles, message.id, message.role, message.timestamp, text]);
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
          <MessageBody
            text={text}
            isUser={isUser}
            isStreaming={isStreaming}
            bodyRenderMode={bodyRenderMode}
            onRequestFullRender={onRequestFullRender}
            resolveFileHintPath={resolveFileHintPath}
            markdownCacheKey={markdownCacheKey}
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
      </MessageShell>

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
        'flex gap-3 group',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      <div
        className={cn(
          'mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
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
          'flex w-full min-w-0 max-w-[80%] flex-col space-y-2',
          isUser ? 'items-end' : 'items-start',
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

const MessageBody = memo(function MessageBody({
  text,
  isUser,
  isStreaming,
  bodyRenderMode,
  onRequestFullRender,
  resolveFileHintPath,
  markdownCacheKey,
}: {
  text: string;
  isUser: boolean;
  isStreaming: boolean;
  bodyRenderMode?: MarkdownBodyRenderMode;
  onRequestFullRender?: () => void;
  resolveFileHintPath?: FileHintPathResolver;
  markdownCacheKey: string;
}) {
  if (isUser) {
    return (
      <div
        className="relative rounded-2xl border border-border/60 bg-secondary px-4 py-3 text-foreground dark:border-border/70 dark:bg-secondary/85"
      >
        <p className="whitespace-pre-wrap break-words break-all text-sm">{text}</p>
      </div>
    );
  }

  return (
    <AssistantMessageBody
      text={text}
      isStreaming={isStreaming}
      bodyRenderMode={bodyRenderMode}
      onRequestFullRender={onRequestFullRender}
      resolveFileHintPath={resolveFileHintPath}
      markdownCacheKey={markdownCacheKey}
    />
  );
});

const AssistantMessageBody = memo(function AssistantMessageBody({
  text,
  isStreaming,
  bodyRenderMode,
  onRequestFullRender,
  resolveFileHintPath,
  markdownCacheKey,
}: {
  text: string;
  isStreaming: boolean;
  bodyRenderMode?: MarkdownBodyRenderMode;
  onRequestFullRender?: () => void;
  resolveFileHintPath?: FileHintPathResolver;
  markdownCacheKey: string;
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

  const [forceFullMarkdown, setForceFullMarkdown] = useState(false);
  const markdownContent = useMemo(
    () => {
      return linkifyFileHintsInMarkdown(
        migrateLegacyMarkdownFileLinks(text, resolveFileHintPath),
        resolveFileHintPath,
      );
    },
    [markdownCacheKey, resolveFileHintPath, text],
  );
  const canDeferMarkdown = shouldUseLiteMarkdown(markdownContent, isStreaming);
  const effectiveBodyRenderMode = forceFullMarkdown
    ? 'full'
    : (bodyRenderMode ?? (canDeferMarkdown ? 'lite' : 'full'));
  const preferLiteMarkdown = canDeferMarkdown && effectiveBodyRenderMode === 'lite';
  const markdownBody = useMemo(
    () => {
      return getOrBuildMarkdownBody(markdownCacheKey, {
        markdown: markdownContent,
        allowLite: canDeferMarkdown,
        mode: effectiveBodyRenderMode === 'shell'
          ? 'shell'
          : (preferLiteMarkdown ? 'lite' : 'full'),
      });
    },
    [canDeferMarkdown, effectiveBodyRenderMode, markdownCacheKey, markdownContent, preferLiteMarkdown],
  );
  const shellPreview = markdownBody.shellPreview;
  const renderedHtml = effectiveBodyRenderMode === 'full'
    ? (markdownBody.fullHtml ?? '')
    : (markdownBody.liteHtml ?? '');

  useEffect(() => {
    setForceFullMarkdown(false);
  }, [markdownCacheKey]);

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

  const handleRequestFullMarkdown = useCallback(() => {
    setForceFullMarkdown(true);
    onRequestFullRender?.();
  }, [onRequestFullRender]);

  return (
    <div
      data-chat-body-mode={effectiveBodyRenderMode}
      className={cn(
        'relative',
        'w-full bg-transparent px-0 py-0',
      )}
    >
      {effectiveBodyRenderMode === 'shell' && shellPreview ? (
        <div className="rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-foreground">
          <div className="space-y-3">
            <div className="space-y-2">
              <p className="whitespace-pre-wrap break-words text-sm leading-6">
                {shellPreview.text}
                {shellPreview.truncated ? '…' : ''}
              </p>
              {(shellPreview.hasCodeBlock || shellPreview.hasLinks) ? (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {shellPreview.hasCodeBlock ? (
                    <span className="rounded-full border border-border/60 px-2 py-0.5">Contains code block</span>
                  ) : null}
                  {shellPreview.hasLinks ? (
                    <span className="rounded-full border border-border/60 px-2 py-0.5">Contains links</span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Full markdown formatting is deferred until this message becomes active.
              </p>
              <Button type="button" size="sm" variant="outline" onClick={handleRequestFullMarkdown}>
                Render full formatting
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {markdownBody.canUpgrade && effectiveBodyRenderMode !== 'full' ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Large message preview</p>
                <p className="text-xs text-muted-foreground">
                  Full markdown formatting is deferred to keep session switching responsive.
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={handleRequestFullMarkdown}>
                Render full formatting
              </Button>
            </div>
          ) : null}
          <div
            className="prose prose-sm dark:prose-invert max-w-none break-words break-all [&_.chat-md-lite-code]:overflow-hidden [&_.chat-md-lite-code]:rounded-xl [&_.chat-md-lite-code]:border [&_.chat-md-lite-code]:border-border/60 [&_.chat-md-lite-code]:bg-muted/20 [&_.chat-md-lite-code__header]:border-b [&_.chat-md-lite-code__header]:border-border/60 [&_.chat-md-lite-code__header]:px-3 [&_.chat-md-lite-code__header]:py-2 [&_.chat-md-lite-code__header]:text-xs [&_.chat-md-lite-code__header]:text-muted-foreground [&_.chat-md-lite-code__summary]:flex [&_.chat-md-lite-code__summary]:cursor-pointer [&_.chat-md-lite-code__summary]:items-center [&_.chat-md-lite-code__summary]:justify-between [&_.chat-md-lite-code__summary]:gap-3 [&_.chat-md-lite-code__summary]:border-b [&_.chat-md-lite-code__summary]:border-border/60 [&_.chat-md-lite-code__summary]:px-3 [&_.chat-md-lite-code__summary]:py-2 [&_.chat-md-lite-code__summary]:text-xs [&_.chat-md-lite-code__summary]:text-muted-foreground [&_.chat-md-lite-code_pre]:m-0 [&_.chat-md-lite-code_pre]:overflow-x-auto [&_.chat-md-lite-code_pre]:px-4 [&_.chat-md-lite-code_pre]:py-3"
            onClick={handleMarkdownClick}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
          {isStreaming ? <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/50 align-text-bottom" /> : null}
        </div>
      )}
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
    allowLite: false,
    mode: 'full',
  }), [content, thinkingCacheKey]);

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
          <div
            className="prose prose-sm dark:prose-invert max-w-none opacity-75"
            dangerouslySetInnerHTML={{ __html: renderResult.fullHtml ?? '' }}
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

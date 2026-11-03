import { useMarkdownExtensions } from './use-renderers';
import { useCallback, useEffect, memo, useMemo } from 'react';
import type { AttachedFileMeta } from './attachments';
import { buildArtifactPreviewTargetFromPath } from '@/plugins/files/types';
import { getOrBuildAssistantMarkdownBody, renderStreamingAssistantMarkdownBody } from '@/plugins/message-rendering/assistant-markdown-body';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, summarizeText } from '@/lib/session-trace';
import { cn } from '@/lib/utils';
import { MESSAGE_LAYOUT_TOKENS } from '@/plugins/message-rendering/message-layout-tokens';
import { decodeFileHintHref } from '@/plugins/message-rendering/md-pipeline';
import { handleMarkdownCodeBlockCopy } from '@/plugins/message-rendering/markdown-code-blocks';
import { useLargeTextContent } from '@/plugins/message-rendering/large-text-loader';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionLargeTextMetadata } from '@/types/session/tool-card';

interface AssistantMessageBodyProps {
  itemKey: string;
  createdAt?: number;
  text: string;
  attachedFiles?: ReadonlyArray<AttachedFileMeta>;
  isStreaming: boolean;
  largeText?: SessionLargeTextMetadata;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  onBodyClick?: () => void;
  onOpenFile?: (file: AttachedFileMeta) => boolean | void;
}

function getEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

export const AssistantMessageBody = memo(function AssistantMessageBody({
  itemKey,
  createdAt,
  text,
  attachedFiles,
  isStreaming,
  largeText,
  sessionIdentity,
  endpointSessionId,
  onBodyClick,
  onOpenFile,
}: AssistantMessageBodyProps) {
  const extensions = useMarkdownExtensions();
  const largeTextContent = useLargeTextContent({ initialText: text, largeText, sessionIdentity, endpointSessionId });
  const markdownHtml = useMemo(() => {
    if (!largeTextContent.text.trim()) {
      return null;
    }
    const renderBody = isStreaming ? renderStreamingAssistantMarkdownBody : getOrBuildAssistantMarkdownBody;
    return renderBody({
      key: itemKey,
      role: 'assistant',
      createdAt,
      text: largeTextContent.text,
      attachedFiles: attachedFiles ?? [],
    }, extensions)?.fullHtml ?? null;
  }, [attachedFiles, createdAt, extensions, isStreaming, itemKey, largeTextContent.text]);
  const html = useMemo(() => ({ __html: markdownHtml ?? '' }), [markdownHtml]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.assistant-markdown.committed', 'session-assistant-markdown-boundary', () => ({
      identity: summarizeSessionIdentity(sessionIdentity), markdownKeyHash: summarizeIdentifier(itemKey).hash,
      input: summarizeText(text), markdownInput: summarizeText(largeTextContent.text),
      output: markdownHtml === null ? null : summarizeText(markdownHtml), mode: markdownHtml ? 'html' : 'plain-text', isStreaming,
      ...(largeText ? { loadedBytes: largeText.loadedBytes, totalBytes: largeText.totalBytes } : {}),
    }));
  }, [isStreaming, itemKey, largeText, largeTextContent.text, markdownHtml, sessionIdentity, text]);
  const handleOpenFileHint = useCallback((filePath: string) => {
    const file = buildArtifactPreviewTargetFromPath(filePath);
    onOpenFile?.({ fileName: file.fileName, filePath, mimeType: file.mimeType, fileSize: 0, preview: null, source: 'message-ref' });
  }, [onOpenFile]);

  const handleMarkdownClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (handleMarkdownCodeBlockCopy(event)) {
      return true;
    }

    const target = getEventElement(event.target);
    if (!target) {
      return false;
    }
    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) {
      return false;
    }
    const decodedHint = decodeFileHintHref(anchor.href);
    if (!decodedHint || !onOpenFile) {
      return false;
    }
    event.preventDefault();
    void handleOpenFileHint(decodedHint);
    return true;
  }, [handleOpenFileHint, onOpenFile]);

  const handleBodyClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = getEventElement(event.target);
    if (!target) {
      return;
    }
    if (target.closest('a,button,summary,[role="button"]')) {
      return;
    }
    onBodyClick?.();
  }, [onBodyClick]);

  const handleMarkdownBodyClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (handleMarkdownClick(event)) {
      return;
    }
    handleBodyClick(event);
  }, [handleBodyClick, handleMarkdownClick]);

  return (
    <div
      data-chat-body-mode={isStreaming ? 'streaming' : 'settled'}
      className={cn(
        MESSAGE_LAYOUT_TOKENS.assistantSurface,
        'relative',
      )}
    >
      <div className="chat-markdown text-[14px] leading-[1.68] text-foreground">
        {!markdownHtml && (
          <p
            className="m-0 whitespace-pre-wrap break-words"
            onClick={handleBodyClick}
          >
            {largeTextContent.text}
          </p>
        )}
        {markdownHtml ? (
          <div
            className="chat-markdown max-w-none break-words"
            onClick={handleMarkdownBodyClick}
            dangerouslySetInnerHTML={html}
          />
        ) : null}
        {largeTextContent.loadMoreButton}
      </div>
    </div>
  );
});

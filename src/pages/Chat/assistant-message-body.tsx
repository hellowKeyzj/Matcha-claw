import { useCallback, useEffect, memo, useMemo } from 'react';
import { invokeIpc } from '@/lib/api-client';
import { getOrBuildAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, summarizeText } from '@/lib/session-trace';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { decodeFileHintHref } from './md-pipeline';
import { handleMarkdownCodeBlockCopy } from './markdown-code-blocks';
import { useLargeTextContent } from './large-text-loader';
import type { SessionIdentity } from '../../types/desktop/runtime-address';
import type { SessionLargeTextMetadata } from '../../types/session/tool-card';

interface AssistantMessageBodyProps {
  itemKey: string;
  createdAt?: number;
  text: string;
  isStreaming: boolean;
  largeText?: SessionLargeTextMetadata;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  onBodyClick?: () => void;
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
  isStreaming,
  largeText,
  sessionIdentity,
  endpointSessionId,
  onBodyClick,
}: AssistantMessageBodyProps) {
  const largeTextContent = useLargeTextContent({ initialText: text, largeText, sessionIdentity, endpointSessionId });
  const markdownHtml = useMemo(() => {
    if (!largeTextContent.text.trim()) {
      return null;
    }
    return getOrBuildAssistantMarkdownBody({
      key: itemKey,
      role: 'assistant',
      createdAt,
      text: largeTextContent.text,
      attachedFiles: [],
    } as never)?.fullHtml ?? null;
  }, [createdAt, itemKey, largeTextContent.text]);
  useEffect(() => {
    if (!isSessionTraceEnabled()) return;
    logSessionTrace('session.assistant-markdown.committed', 'session-assistant-markdown-boundary', {
      identity: summarizeSessionIdentity(sessionIdentity), markdownKeyHash: summarizeIdentifier(itemKey).hash,
      input: summarizeText(text), markdownInput: summarizeText(largeTextContent.text),
      output: markdownHtml === null ? null : summarizeText(markdownHtml), mode: markdownHtml ? 'html' : 'plain-text', isStreaming,
      ...(largeText ? { loadedBytes: largeText.loadedBytes, totalBytes: largeText.totalBytes } : {}),
    });
  }, [isStreaming, itemKey, largeText, largeTextContent.text, markdownHtml, sessionIdentity, text]);
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
    if (!decodedHint) {
      return false;
    }
    event.preventDefault();
    void handleOpenFileHint(decodedHint);
    return true;
  }, [handleOpenFileHint]);

  const handleBodyClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = getEventElement(event.target);
    if (!target) {
      return;
    }
    if (target.closest('a,button,[role="button"]')) {
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
        CHAT_LAYOUT_TOKENS.assistantSurface,
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
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        ) : null}
        {largeTextContent.loadMoreButton}
      </div>
    </div>
  );
});

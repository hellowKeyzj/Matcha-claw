import { useCallback, memo } from 'react';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { decodeFileHintHref } from './md-pipeline';

interface AssistantMessageBodyProps {
  text: string;
  markdownHtml: string | null;
  isStreaming: boolean;
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
  text,
  markdownHtml,
  isStreaming,
  onBodyClick,
}: AssistantMessageBodyProps) {
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
    const target = getEventElement(event.target);
    if (!target) {
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
    handleMarkdownClick(event);
    handleBodyClick(event);
  }, [handleBodyClick, handleMarkdownClick]);

  if (!text.trim() && isStreaming) {
    return (
      <div
        data-chat-body-mode="streaming"
        className={cn(
          CHAT_LAYOUT_TOKENS.assistantSurface,
          'relative',
        )}
      >
        <div className="flex min-h-[34px] items-center px-0.5 py-1.5">
          <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/50 align-text-bottom" />
        </div>
      </div>
    );
  }

  return (
    <div
      data-chat-body-mode={isStreaming ? 'streaming' : 'settled'}
      className={cn(
        CHAT_LAYOUT_TOKENS.assistantSurface,
        'relative',
      )}
    >
      <div className="text-[14px] leading-[1.72] text-foreground">
        {!markdownHtml && (
          <p
            className="whitespace-pre-wrap break-words text-[14px] leading-[1.72] text-foreground"
            onClick={handleBodyClick}
          >
            {text}
          </p>
        )}
        {markdownHtml ? (
          <div
            className="prose prose-zinc max-w-none break-words dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:tracking-[-0.02em] prose-p:my-0 prose-p:leading-7 prose-pre:my-3 prose-pre:rounded-[18px] prose-pre:border prose-pre:border-border/45 prose-pre:bg-background/88 prose-pre:px-4 prose-pre:py-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-blockquote:border-l-border/60 prose-blockquote:text-muted-foreground prose-blockquote:italic prose-code:rounded prose-code:bg-background/75 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.92em]"
            onClick={handleMarkdownBodyClick}
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        ) : null}
      </div>
    </div>
  );
});

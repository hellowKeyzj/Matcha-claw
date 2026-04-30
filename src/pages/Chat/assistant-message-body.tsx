import { useCallback, useMemo, memo } from 'react';
import { invokeIpc } from '@/lib/api-client';
import { getOrBuildAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { cn } from '@/lib/utils';
import type { RawMessage } from '@/stores/chat';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { decodeFileHintHref } from './md-pipeline';
import { CsvPreview } from './components/CsvPreview';
import { StructuredTablePreview } from './components/StructuredTablePreview';

interface AssistantMessageBodyProps {
  text: string;
  message: RawMessage;
  isStreaming: boolean;
}

export const AssistantMessageBody = memo(function AssistantMessageBody({
  text,
  message,
  isStreaming,
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

  const renderMode = isStreaming ? 'streaming' : 'settled';
  const markdownBody = useMemo(
    () => getOrBuildAssistantMarkdownBody(message, renderMode) ?? null,
    [message, renderMode],
  );
  const renderNodes = markdownBody?.nodes ?? [];

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
      data-chat-body-mode={isStreaming ? 'streaming' : 'full'}
      className={cn(
        CHAT_LAYOUT_TOKENS.assistantSurface,
        'relative',
      )}
    >
      <div className="space-y-3 text-[14px] leading-[1.72] text-foreground">
        {!markdownBody && (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.72] text-foreground">{text}</p>
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
              className="prose prose-zinc max-w-none break-words dark:prose-invert prose-headings:mb-2 prose-headings:mt-4 prose-headings:tracking-[-0.02em] prose-p:my-0 prose-p:leading-7 prose-pre:my-3 prose-pre:rounded-[18px] prose-pre:border prose-pre:border-border/45 prose-pre:bg-background/88 prose-pre:px-4 prose-pre:py-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-blockquote:border-l-border/60 prose-blockquote:text-muted-foreground prose-blockquote:italic prose-code:rounded prose-code:bg-background/75 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.92em]"
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

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReplyDuration } from '@/plugins/chat/reply-timing';
import type { ThreadWorkPresentation } from '@/plugins/chat/thread-work';

export function AssistantWorkSummary({ work, expanded, onToggle }: {
  work: ThreadWorkPresentation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation('chat');
  const duration = useReplyDuration(work.timing);
  return (
    <button
      type="button"
      data-chat-local-geometry-anchor="true"
      data-chat-work-key={work.key}
      data-chat-work-summary="true"
      aria-expanded={expanded}
      className="inline-flex max-w-full items-center gap-1.5 text-left text-[13px] leading-6 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border/50"
      onClick={onToggle}
    >
      <span>{duration ? t('work.duration', { duration }) : t('work.process')}</span>
      {work.toolCount > 0 ? <span className="text-muted-foreground/75">{t('work.tools_count', { count: work.toolCount })}</span> : null}
      {expanded ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
    </button>
  );
}

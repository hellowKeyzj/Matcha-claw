import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, MoreHorizontal, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { SessionGoal, SessionGoalUpdate } from '@/types/session-goal';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';

type Props = {
  goal: SessionGoal | null;
  busy: boolean;
  runActive: boolean;
  disabled: boolean;
  error: string | null;
  onEdit: () => void;
  onAction: (update: SessionGoalUpdate | { action: 'clear' }) => void;
  onRefresh: () => void;
};

export function ChatGoalDock({ goal, busy, runActive, disabled, error, onEdit, onAction, onRefresh }: Props) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const locked = busy || disabled || !goal;
  return (
    <section aria-label={t('goal.title')} className={`${CHAT_LAYOUT_TOKENS.runtimeDockRail} mb-2 rounded-2xl border border-border/50 bg-background px-3 py-2 text-xs`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Target aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{goal ? goal.objective : t('goal.unknown')}</span>
          {goal ? <span className="shrink-0 text-muted-foreground">{t(`goal.status.${goal.status}`)}</span> : null}
          <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={locked || goal?.status === 'complete'} onClick={onEdit}>{t('goal.edit')}</Button>
        {goal?.status === 'active' ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={locked} onClick={() => onAction({ action: 'pause' })}>{t('goal.pause')}</Button>
        ) : goal && goal.status !== 'complete' ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={locked || runActive} onClick={() => onAction({ action: 'resume' })}>{t('goal.resume')}</Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={locked} aria-label={t('goal.more')}><MoreHorizontal aria-hidden="true" className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={goal?.status === 'complete'} onSelect={() => onAction({ action: 'complete' })}>{t('goal.complete')}</DropdownMenuItem>
            <DropdownMenuItem disabled={goal?.status === 'blocked' || goal?.status === 'complete'} onSelect={() => onAction({ action: 'block' })}>{t('goal.block')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ action: 'clear' })}>{t('goal.clear')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded ? <div id={detailsId} className="mt-2 space-y-2 border-t border-border/40 pt-2">
        {goal ? <>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words" data-chat-composer-wheel-local="true">{goal.objective}</p>
          {goal.lastStatusNote ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{t('goal.note')}: {goal.lastStatusNote}</p> : null}
          <p className="text-muted-foreground">{t('goal.tokens', { count: goal.tokensUsed })}{goal.tokenBudget !== undefined ? ` · ${t('goal.budget', { count: goal.tokenBudget })}` : ''}</p>
        </> : null}
        <Button type="button" variant="link" size="sm" className="h-auto text-xs" disabled={busy} onClick={onRefresh}>{t('goal.refresh')}</Button>
      </div> : null}
      {error ? <div role="alert" className="mt-2 flex items-center gap-2 text-destructive"><span>{t(`goal.errors.${error}`, { defaultValue: t('goal.errors.unknown') })}</span><Button type="button" variant="link" className="h-auto text-xs" onClick={onRefresh}>{t('goal.refresh')}</Button></div> : null}
    </section>
  );
}

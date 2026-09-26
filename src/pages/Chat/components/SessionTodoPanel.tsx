import { memo, useId, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, Circle, CircleDot, ListTodo, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import type { TodoItem } from '../../../types/session/task-snapshot';

const EMPTY_TODOS: TodoItem[] = [];

export const SessionTodoPanel = memo(function SessionTodoPanel({
  sessionKey,
}: {
  sessionKey: string;
}) {
  const { t } = useTranslation('chat');
  const id = useId().replace(/:/g, '');
  const popoverId = `session-todos-${id}`;
  const anchorName = `--session-todos-${id}`;
  const [panelState, setPanelState] = useState({ sessionKey, expanded: false });
  const expanded = panelState.sessionKey === sessionKey && panelState.expanded;
  const todos = useTaskSnapshotStore((state) => (
    sessionKey ? state.getTodoList(sessionKey) : EMPTY_TODOS
  ));
  const totalCount = todos.length;
  const completedCount = todos.filter((todo) => todo.status === 'completed').length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;
  const summary = t('todoPanel.summary', { completed: completedCount, total: totalCount });

  if (totalCount === 0) {
    return null;
  }

  return (
    <div data-testid="session-todo-panel" className="shrink-0">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        popoverTarget={popoverId}
        style={{ anchorName } as CSSProperties}
        className="h-8 gap-1.5 rounded-md px-2 text-xs tabular-nums data-[state=open]:bg-secondary data-[state=open]:text-foreground motion-reduce:transition-none"
        data-state={expanded ? 'open' : 'closed'}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        aria-label={`${expanded ? t('todoPanel.collapse') : t('todoPanel.expand')} · ${summary}`}
      >
        {allCompleted
          ? <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
          : <ListTodo className="h-3.5 w-3.5" aria-hidden="true" />}
        <span>{summary}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform duration-150 motion-reduce:transition-none', expanded && 'rotate-180')} aria-hidden="true" />
      </Button>

      <div
        key={sessionKey}
        id={popoverId}
        popover="auto"
        role="dialog"
        aria-label={summary}
        onToggle={(event) => setPanelState({ sessionKey, expanded: event.newState === 'open' })}
        style={{
          positionAnchor: anchorName,
          top: 'anchor(bottom)',
          right: '12px',
          bottom: 'auto',
          left: 'auto',
          positionTryFallbacks: 'flip-block',
          margin: '8px 0',
        } as CSSProperties}
        className="fixed w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/70 bg-popover p-0 text-popover-foreground shadow-elevated"
      >
        {expanded ? (
          <>
            <div className="px-5 pb-2 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold tracking-tight">{t('todoPanel.title')}</h2>
                <button
                  type="button"
                  popoverTarget={popoverId}
                  popoverTargetAction="hide"
                  aria-label={t('todoPanel.collapse')}
                  className="-mr-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{allCompleted ? t('todoPanel.allCompleted') : t('todoPanel.progress')}</span>
                <span className="tabular-nums"><span className="font-medium text-foreground">{completedCount}</span><span className="mx-1">/</span>{totalCount}</span>
              </div>
              <div
                role="progressbar"
                aria-label={t('todoPanel.progress')}
                aria-valuemin={0}
                aria-valuemax={totalCount}
                aria-valuenow={completedCount}
                className="mt-2.5 h-1 overflow-hidden rounded-full bg-secondary"
              >
                <div className="h-full origin-left rounded-full bg-emerald-600 transition-transform duration-200 motion-reduce:transition-none dark:bg-emerald-400" style={{ transform: `scaleX(${completedCount / totalCount})` }} />
              </div>
            </div>
            <ul className="max-h-[min(24rem,60dvh)] divide-y divide-border/40 overflow-y-auto overscroll-contain px-5 pb-2">
              {todos.map((todo, index) => {
                const completed = todo.status === 'completed';
                const active = todo.status === 'in_progress';
                const cancelled = todo.status === 'deleted';
                const statusLabel = t(`todoPanel.status.${todo.status}`);
                return (
                  <li
                    key={`${todo.id ?? `todo-${index + 1}`}:${index}`}
                    className="flex items-start gap-3 py-3.5"
                  >
                    <span className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center',
                      completed ? 'rounded-full bg-emerald-600 text-white dark:bg-emerald-400 dark:text-black'
                        : active ? 'text-sky-700 dark:text-sky-400' : 'text-muted-foreground',
                    )}>
                      {completed ? <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                        : active ? <CircleDot className="h-4 w-4" aria-hidden="true" />
                          : cancelled ? <XCircle className="h-4 w-4" aria-hidden="true" />
                            : <Circle className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
                    </span>
                    <p className={cn(
                      'min-w-0 flex-1 break-words text-[13px] leading-5',
                      completed || cancelled ? 'text-muted-foreground line-through decoration-border' : 'text-foreground',
                      active && 'font-medium',
                    )}>
                      {todo.content}
                    </p>
                    {active
                      ? <span className="shrink-0 rounded-md bg-sky-50 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300">{statusLabel}</span>
                      : <span className="sr-only">{statusLabel}</span>}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
});

import { memo, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Circle, ListTodo, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import type { TodoItem } from '../../../../runtime-host/shared/session-adapter-types';

const EMPTY_TODOS: TodoItem[] = [];

function isActiveTodo(todo: TodoItem): boolean {
  return todo.status === 'in_progress';
}

function isCompletedTodo(todo: TodoItem): boolean {
  return todo.status === 'completed';
}

function isCancelledTodo(todo: TodoItem): boolean {
  return todo.status === 'deleted';
}

export const SessionTodoPanel = memo(function SessionTodoPanel({
  sessionKey,
}: {
  sessionKey: string;
}) {
  const { t } = useTranslation('chat');
  const [panelState, setPanelState] = useState({ sessionKey, expanded: false });
  const expanded = panelState.sessionKey === sessionKey && panelState.expanded;
  const todos = useTaskSnapshotStore((state) => (
    sessionKey ? state.getTodoList(sessionKey) : EMPTY_TODOS
  ));
  const totalCount = todos.length;
  const completedCount = todos.filter(isCompletedTodo).length;
  const currentTodo = todos.find(isActiveTodo) ?? null;
  const allCompleted = totalCount > 0 && completedCount === totalCount;

  if (totalCount === 0) {
    return null;
  }

  return (
    <div data-testid="session-todo-panel" className="w-full min-w-0">
      <div className={cn(
        'ml-auto overflow-hidden border border-border/55 bg-background/95 shadow-[0_14px_40px_rgba(15,23,42,0.10)] backdrop-blur-xl transition-[width]',
        expanded ? 'w-full max-w-[56rem] rounded-lg' : 'w-fit rounded-full',
      )}>
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-2 bg-muted/42 px-3 text-xs font-medium text-foreground/82 hover:bg-muted/62',
            expanded ? 'w-full justify-between' : 'w-fit justify-center',
          )}
          onClick={() => setPanelState((value) => (
            value.sessionKey === sessionKey
              ? { sessionKey, expanded: !value.expanded }
              : { sessionKey, expanded: true }
          ))}
          aria-expanded={expanded}
          aria-label={expanded ? t('todoPanel.collapse') : t('todoPanel.expand')}
        >
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <ListTodo className="h-3.5 w-3.5" />
            {t('todoPanel.summary', { completed: completedCount, total: totalCount })}
          </span>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        {expanded ? (
          <div className="px-3 py-3">
            <p className="mb-2 truncate text-xs text-muted-foreground">
              {allCompleted
                ? t('todoPanel.allCompleted')
                : currentTodo
                  ? currentTodo.activeForm || currentTodo.content
                  : t('todoPanel.inProgress')}
            </p>
            <div className="divide-y divide-border/35 rounded-md border border-border/45 bg-card/50">
              {todos.map((todo, index) => {
                const completed = isCompletedTodo(todo);
                const active = isActiveTodo(todo);
                const cancelled = isCancelledTodo(todo);
                return (
                  <div
                    key={`${todo.id ?? `todo-${index + 1}`}:${index}`}
                    className="grid min-h-9 grid-cols-[2.5rem_minmax(0,1fr)_5.5rem] items-center gap-2 px-2 text-xs leading-5"
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {todo.id ?? String(index + 1).padStart(2, '0')}
                    </span>
                    <span className={cn(
                      'min-w-0 truncate',
                      completed || cancelled
                        ? 'text-muted-foreground line-through decoration-muted-foreground/45'
                        : 'text-foreground/86',
                    )}>
                      {todo.content}
                    </span>
                    <span className="inline-flex items-center justify-end gap-1.5 text-muted-foreground">
                      {completed ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : active ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      ) : cancelled ? (
                        <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span>
                        {completed
                          ? t('todoPanel.status.completed')
                          : active
                            ? t('todoPanel.status.in_progress')
                            : cancelled
                              ? t('todoPanel.status.deleted')
                              : t('todoPanel.status.pending')}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

import type { ReactNode } from 'react';
import { FileText, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type RuntimeStatusTone = 'success' | 'pending' | 'warning' | 'destructive' | 'neutral';

type RuntimeStatusAction = {
  id: string;
  label: string;
  icon: 'refresh' | 'repair' | 'logs';
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
};

export type RuntimeStatusItem = {
  id: string;
  title: string;
  status: string;
  tone: RuntimeStatusTone;
  actions: RuntimeStatusAction[];
  activity?: ReactNode;
  details?: ReactNode;
};

const RUNTIME_STATUS_TONE_CLASS_NAMES: Record<RuntimeStatusTone, { dot: string; pill: string }> = {
  success: {
    dot: 'bg-emerald-500 ring-4 ring-emerald-500/10',
    pill: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200',
  },
  pending: {
    dot: 'bg-amber-500 ring-4 ring-amber-500/10',
    pill: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200',
  },
  warning: {
    dot: 'bg-orange-500 ring-4 ring-orange-500/10',
    pill: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-200',
  },
  destructive: {
    dot: 'bg-destructive ring-4 ring-destructive/10',
    pill: 'border-destructive/25 bg-destructive/10 text-destructive',
  },
  neutral: {
    dot: 'bg-muted-foreground ring-4 ring-muted',
    pill: 'border-border bg-secondary text-muted-foreground',
  },
};

export function RuntimeStatusDot({ tone }: { tone: RuntimeStatusTone }) {
  return (
    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', RUNTIME_STATUS_TONE_CLASS_NAMES[tone].dot)} />
  );
}

function RuntimeStatusPill({ tone, children }: { tone: RuntimeStatusTone; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs font-medium', RUNTIME_STATUS_TONE_CLASS_NAMES[tone].pill)}>
      {children}
    </span>
  );
}

function RuntimeStatusActionIcon({ action }: { action: RuntimeStatusAction }) {
  if (action.loading) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  }
  if (action.icon === 'repair') {
    return <Wrench className="h-3.5 w-3.5" />;
  }
  if (action.icon === 'logs') {
    return <FileText className="h-3.5 w-3.5" />;
  }
  return <RefreshCw className="h-3.5 w-3.5" />;
}

function RuntimeStatusActionButton({ action }: { action: RuntimeStatusAction }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 w-20 justify-center px-3 text-xs shadow-none"
      onClick={action.onClick}
      disabled={action.disabled}
    >
      <RuntimeStatusActionIcon action={action} />
      {action.label}
    </Button>
  );
}

export function RuntimeStatusList({ items }: { items: RuntimeStatusItem[] }) {
  return (
    <div className="overflow-hidden rounded-[1rem] border border-border/80 bg-background/45" role="list">
      {items.map((item, index) => (
        <div
          key={item.id}
          role="listitem"
          className={cn(
            'grid gap-3 px-4 py-3.5 sm:grid-cols-[8rem_auto_minmax(0,1fr)] sm:items-center',
            index > 0 && 'border-t border-border/70',
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <RuntimeStatusDot tone={item.tone} />
            <span className="truncate text-sm font-medium tracking-[-0.01em] text-foreground">{item.title}</span>
          </div>
          <div className="sm:justify-self-start">
            <RuntimeStatusPill tone={item.tone}>{item.status}</RuntimeStatusPill>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-self-end">
            {item.activity}
            {item.actions.map((action) => <RuntimeStatusActionButton key={action.id} action={action} />)}
          </div>
          {item.details ? <div className="space-y-2 sm:col-span-3 sm:pl-5">{item.details}</div> : null}
        </div>
      ))}
    </div>
  );
}

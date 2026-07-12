import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface RemoteFleetTargetPreviewEmptyStateProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly tone?: 'neutral' | 'warning';
}

export function RemoteFleetTargetPreviewEmptyState({
  icon,
  title,
  description,
  tone = 'neutral',
}: RemoteFleetTargetPreviewEmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-dashed px-4 py-5 text-sm',
        tone === 'warning'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100'
          : 'border-border/70 bg-muted/30 text-muted-foreground',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border',
            tone === 'warning'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
              : 'border-border/70 bg-background text-foreground',
          )}
        >
          {icon}
        </div>
        <div className="space-y-1">
          <p className={cn('font-medium', tone === 'warning' ? 'text-amber-900 dark:text-amber-100' : 'text-foreground')}>
            {title}
          </p>
          <p className="leading-6">{description}</p>
        </div>
      </div>
    </div>
  );
}

export default RemoteFleetTargetPreviewEmptyState;

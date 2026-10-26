import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface RemoteFleetTargetPreviewStatusBadgeProps {
  readonly status?: string;
}

type StatusAppearance = {
  readonly badgeClassName: string;
  readonly dotClassName: string;
};

function resolveStatusAppearance(status?: string): StatusAppearance {
  const normalizedStatus = status?.toLowerCase();

  if (!normalizedStatus || normalizedStatus === 'unknown') {
    return {
      badgeClassName: 'border-border/80 bg-background text-muted-foreground',
      dotClassName: 'bg-muted-foreground/70',
    };
  }

  if (['available', 'ready', 'active', 'connected', 'online', 'running'].includes(normalizedStatus)) {
    return {
      badgeClassName: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
      dotClassName: 'bg-emerald-600 dark:bg-emerald-300',
    };
  }

  if (['draining', 'queued', 'pending', 'starting', 'stopping'].includes(normalizedStatus)) {
    return {
      badgeClassName: 'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-200',
      dotClassName: 'bg-amber-600 dark:bg-amber-300',
    };
  }

  if (['retired', 'disabled', 'stopped'].includes(normalizedStatus)) {
    return {
      badgeClassName: 'border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-200',
      dotClassName: 'bg-slate-500 dark:bg-slate-300',
    };
  }

  if (['offline', 'failed', 'error', 'unhealthy', 'revoked'].includes(normalizedStatus)) {
    return {
      badgeClassName: 'border-rose-500/20 bg-rose-500/10 text-rose-800 dark:text-rose-200',
      dotClassName: 'bg-rose-600 dark:bg-rose-300',
    };
  }

  return {
    badgeClassName: 'border-sky-500/20 bg-sky-500/10 text-sky-800 dark:text-sky-200',
    dotClassName: 'bg-sky-600 dark:bg-sky-300',
  };
}

export function RemoteFleetTargetPreviewStatusBadge({ status }: RemoteFleetTargetPreviewStatusBadgeProps) {
  const appearance = resolveStatusAppearance(status);

  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1.5 border shadow-none',
        appearance.badgeClassName,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', appearance.dotClassName)} />
      {status || 'unknown'}
    </Badge>
  );
}

export default RemoteFleetTargetPreviewStatusBadge;

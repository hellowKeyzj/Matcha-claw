import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TASK_CENTER_SURFACE_CARD_CLASS } from '@/components/task-center/styles';
import { cn } from '@/lib/utils';

interface TaskCenterStatCardProps {
  value: number;
  label: string;
  icon: LucideIcon;
  iconWrapClassName?: string;
  iconClassName?: string;
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}

export function TaskCenterStatCard({
  value,
  label,
  icon: Icon,
  iconWrapClassName,
  iconClassName,
  active = false,
  onClick,
  ariaLabel,
}: TaskCenterStatCardProps) {
  const content = (
    <Card className={cn(TASK_CENTER_SURFACE_CARD_CLASS, 'transition-colors', active && 'border-primary bg-primary/5')}>
      <CardContent className="pt-6">
        <div className="flex items-center gap-4">
          <div className={cn('rounded-full p-3', iconWrapClassName)}>
            <Icon className={cn('h-6 w-6', iconClassName)} />
          </div>
          <div>
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-sm text-muted-foreground">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  if (!onClick) {
    return content;
  }

  return (
    <button
      type="button"
      className="text-left"
      aria-label={ariaLabel || label}
      aria-pressed={active}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

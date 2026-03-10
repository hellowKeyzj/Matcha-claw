import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PaneEdgeToggleProps {
  side: 'left' | 'right';
  title: string;
  ariaLabel: string;
  onClick?: () => void;
  icon: ReactNode;
}

export function PaneEdgeToggle({
  side,
  title,
  ariaLabel,
  onClick,
  icon,
}: PaneEdgeToggleProps) {
  const isLeft = side === 'left';

  return (
    <div
      className={cn(
        'group absolute top-1/2 z-20 h-16 w-6 -translate-y-1/2',
        isLeft ? 'left-0' : 'right-0',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-1/2 h-12 w-[2.5px] -translate-y-1/2 rounded-full bg-border',
          isLeft ? 'left-0' : 'right-0',
        )}
      />
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'pointer-events-none absolute top-1/2 h-12 w-2 -translate-y-1/2 rounded-sm border border-border/70 bg-background/90 p-0 text-muted-foreground opacity-0 shadow-none transition-all duration-150',
          isLeft ? 'left-0' : 'right-0',
          'group-hover:pointer-events-auto group-hover:opacity-100',
        )}
        onClick={onClick}
        title={title}
        aria-label={ariaLabel}
      >
        {icon}
      </Button>
    </div>
  );
}

import type { CSSProperties, MouseEventHandler } from 'react';
import { cn } from '@/lib/utils';

interface VerticalPaneResizerProps {
  testId?: string;
  ariaLabel: string;
  onMouseDown: MouseEventHandler<HTMLDivElement>;
  variant?: 'line' | 'subtle-border';
  className?: string;
  style?: CSSProperties;
}

export function VerticalPaneResizer({
  testId,
  ariaLabel,
  onMouseDown,
  variant = 'line',
  className,
  style,
}: VerticalPaneResizerProps) {
  return (
    <div
      data-testid={testId}
      className={cn('group relative w-1.5 shrink-0 cursor-col-resize bg-transparent', className)}
      style={style}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
    >
      {variant === 'line' ? (
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/60" />
      ) : (
        <>
          <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 bg-border/12 transition-colors duration-150 group-hover:bg-border/22" />
          <div className="absolute inset-y-0 left-1/2 flex w-[3px] -translate-x-1/2 justify-between">
            <div className="w-px bg-border/55 transition-colors duration-150 group-hover:bg-border/80" />
            <div className="w-px bg-border/35 transition-colors duration-150 group-hover:bg-border/65" />
          </div>
        </>
      )}
    </div>
  );
}

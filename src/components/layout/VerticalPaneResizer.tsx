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
        <div className="absolute inset-y-4 left-1/2 w-[0.5px] -translate-x-1/2 rounded-full bg-[var(--divider-line)] transition-colors group-hover:bg-[var(--divider-line-hover)]" />
      ) : (
        <div className="absolute inset-y-0 left-1/2 w-[0.5px] -translate-x-1/2 bg-[var(--divider-line)] transition-colors duration-150 group-hover:bg-[var(--divider-line-hover)]" />
      )}
    </div>
  );
}

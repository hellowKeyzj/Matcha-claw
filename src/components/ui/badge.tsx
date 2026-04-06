/* eslint-disable react-refresh/only-export-components */
/**
 * Badge Component
 * Based on shadcn/ui badge
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex min-w-0 max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-pill)] border px-2.5 py-1 text-[11px] font-semibold tracking-[0.01em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring/15 focus:ring-offset-0',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground',
        secondary:
          'border-border bg-secondary text-secondary-foreground',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-input bg-card text-foreground',
        success:
          'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200',
        warning:
          'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };

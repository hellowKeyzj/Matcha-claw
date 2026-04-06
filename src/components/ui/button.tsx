/* eslint-disable react-refresh/only-export-components */
/**
 * Button Component
 * Based on shadcn/ui button
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-pill)] border border-transparent text-sm font-medium tracking-[-0.01em] ring-offset-background transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/15 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:shadow-[var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-whisper hover:bg-primary/92 hover:shadow-elevated',
        destructive:
          'bg-destructive text-destructive-foreground shadow-whisper hover:bg-destructive/90',
        outline:
          'border-input bg-card text-foreground shadow-whisper hover:border-border hover:bg-secondary',
        secondary:
          'border-border bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'bg-transparent text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground',
        link: 'rounded-none border-transparent bg-transparent px-0 text-[hsl(var(--ring))] shadow-none hover:text-foreground hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3.5 text-xs',
        lg: 'h-11 px-6 text-sm',
        icon: 'h-10 w-10 rounded-full p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };

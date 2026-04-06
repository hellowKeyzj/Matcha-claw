/**
 * Switch Component
 * Based on shadcn/ui switch
 */
import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-[background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:border-border/80 data-[state=unchecked]:bg-muted/70',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        'pointer-events-none block h-[18px] w-[18px] shrink-0 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] ring-0 transition-[transform,background-color] will-change-transform data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-[2px] data-[state=unchecked]:bg-zinc-300 dark:data-[state=unchecked]:bg-zinc-200'
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };

import { forwardRef, type HTMLAttributes, type WheelEvent } from 'react';
import { cn } from '@/lib/utils';
import { handleStableWheel } from './stable-scroll-core';

type StableScrollAreaProps = HTMLAttributes<HTMLDivElement>;

export const StableScrollArea = forwardRef<HTMLDivElement, StableScrollAreaProps>(function StableScrollArea(
  { className, onWheelCapture, ...props },
  ref,
) {
  const handleWheelCapture = (event: WheelEvent<HTMLDivElement>) => {
    if (handleStableWheel(event.nativeEvent, event.currentTarget)) {
      return;
    }
    onWheelCapture?.(event);
  };

  return (
    <div
      {...props}
      ref={ref}
      data-stable-scroll
      className={cn('overflow-y-auto overscroll-contain [scrollbar-gutter:stable]', className)}
      onWheelCapture={handleWheelCapture}
    />
  );
});

import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[96px] w-full rounded-[calc(var(--radius-interactive)+2px)] border bg-[hsl(var(--shell-surface))] px-4 py-3 text-[15px] ring-offset-background transition-[border-color,box-shadow,background-color,color] duration-150 [border-color:hsl(var(--shell-border))] placeholder:text-[hsl(var(--shell-text-muted))] placeholder:opacity-90 hover:bg-[hsl(var(--shell-surface-hover))] hover:[border-color:hsl(var(--shell-border-strong))] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/15 focus-visible:ring-offset-0 focus-visible:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }

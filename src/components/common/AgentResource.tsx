import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function AgentPageSection({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b [border-color:hsl(var(--shell-border))]">
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2 pb-3">{actions}</div>}
    </div>
  );
}

export function AgentPageToolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex min-w-0 flex-wrap items-center gap-3', className)} {...props} />;
}

export function AgentResourceGrid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3', className)} {...props} />;
}

export function AgentResourceCard({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <article className={cn('group relative flex min-w-0 flex-col overflow-hidden rounded-[1.25rem] border bg-[hsl(var(--shell-surface-muted))] p-5 shadow-none transition-[border-color,background-color] duration-200 ease-out [border-color:hsl(var(--shell-border))] hover:bg-[hsl(var(--shell-surface-hover))] hover:[border-color:hsl(var(--shell-border-strong))] focus-within:[border-color:hsl(var(--shell-border-strong))] motion-reduce:transition-none', className)} {...props} />;
}

export function AgentResourceIcon({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-[1rem] border bg-[hsl(var(--shell-surface))] text-[hsl(var(--shell-icon))] shadow-none [border-color:hsl(var(--shell-border))]', className)} {...props} />;
}

export function AgentResourcePill({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-full bg-[hsl(var(--shell-surface))] px-2.5 text-[11px] text-[hsl(var(--shell-text-muted))] ring-1 ring-[hsl(var(--shell-border))]', className)} {...props} />;
}

export function AgentResourceFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-auto flex items-center justify-between gap-3 rounded-2xl bg-[hsl(var(--shell-surface))] px-3 py-2 text-xs text-[hsl(var(--shell-text-muted))] ring-1 ring-[hsl(var(--shell-border))]', className)} {...props} />;
}

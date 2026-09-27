import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { Bot, Box, Cable, Puzzle } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { preloadLazyRouteForPath } from '@/lib/route-preload';
import { isGatewayOperational } from '@/lib/gateway-status';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { prewarmPluginsData } from '@/stores/plugins-store';

const modules = [
  { to: '/subagents', key: 'sidebar.subagents', icon: Bot },
  { to: '/skills', key: 'sidebar.skills', icon: Puzzle },
  { to: '/plugins', key: 'sidebar.plugins', icon: Box },
  { to: '/connectors', key: 'sidebar.connectors', icon: Cable },
] as const;

const moduleLocations = new Map<string, string>();
const moduleScrollPositions = new Map<string, number>();

function prefetchModule(path: string) {
  void preloadLazyRouteForPath(path);
  if (!isGatewayOperational(useGatewayStore.getState().status)) return;
  if (path === '/skills') void useSkillsStore.getState().fetchSkills({ silent: true });
  if (path === '/plugins') void prewarmPluginsData();
}

export function AgentPage({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const { pathname, search } = useLocation();
  const pageRef = useRef<HTMLDivElement>(null);
  const currentLocation = pathname + search;
  const currentModule = modules.find((module) => module.to === pathname) ?? modules[0];

  useLayoutEffect(() => {
    moduleLocations.set(pathname, currentLocation);
  }, [currentLocation, pathname]);

  useLayoutEffect(() => {
    const scroller = pageRef.current?.closest<HTMLElement>('[data-page-scroll]');
    if (!scroller) return;
    const scrollTop = moduleScrollPositions.get(pathname) ?? 0;
    scroller.scrollTop = scrollTop;

    let observer: ResizeObserver | undefined;
    let timeoutId: number | undefined;
    if (scrollTop > 0 && pageRef.current && typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        if (scroller.scrollTop >= scrollTop) {
          observer?.disconnect();
          return;
        }
        scroller.scrollTop = scrollTop;
      });
      observer.observe(pageRef.current);
      timeoutId = window.setTimeout(() => observer?.disconnect(), 1500);
    }

    return () => {
      if (typeof timeoutId === 'number') window.clearTimeout(timeoutId);
      observer?.disconnect();
      moduleScrollPositions.set(pathname, scroller.scrollTop);
    };
  }, [pathname]);

  return (
    <div ref={pageRef} className="min-w-0 space-y-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4 pb-1">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t(currentModule.key)}</h1>
        <nav aria-label={t('sidebar.subagents')} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full border bg-[hsl(var(--shell-surface-muted))] p-1 [border-color:hsl(var(--shell-border))]">
          {modules.map(({ to, key, icon: Icon }) => (
            <NavLink
              key={to}
              to={to === pathname ? currentLocation : (moduleLocations.get(to) ?? to)}
              onMouseEnter={() => prefetchModule(to)}
              onFocus={() => prefetchModule(to)}
              className={({ isActive }) => cn(
                'inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[hsl(var(--shell-text-muted))] transition-colors hover:bg-[hsl(var(--shell-surface-hover))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                isActive && 'bg-[hsl(var(--shell-surface))] text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {t(key)}
            </NavLink>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}

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

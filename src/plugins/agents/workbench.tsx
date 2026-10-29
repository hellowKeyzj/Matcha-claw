import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { preloadApplicationPath } from '@/app/navigation';
import { useContributions, usePluginHost } from '@/plugin-host/react';
import { agentWorkbenchPages, type AgentWorkbenchPageContribution } from '@/plugins/agents/extensions';
import { RuntimeScopeSelector } from '@/plugins/runtime/RuntimeScopeSelector';

const moduleLocations = new Map<string, string>();
const moduleScrollPositions = new Map<string, number>();

export function AgentPage({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const host = usePluginHost();
  const contributions = useContributions(agentWorkbenchPages);
  const modules = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const { pathname, search } = useLocation();
  const pageRef = useRef<HTMLDivElement>(null);
  const currentLocation = pathname + search;
  const currentModule = modules.find((module) => module.to === pathname) ?? modules[0];

  const prefetchModule = (module: AgentWorkbenchPageContribution) => {
    void preloadApplicationPath(host, module.to);
    void module.prefetch?.();
  };

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
      <header className="flex min-h-11 items-center justify-between gap-4">
        <h1 className="shrink-0 text-2xl font-semibold tracking-[-0.035em] text-foreground">{currentModule && t(currentModule.label)}</h1>
        <div className="flex min-w-0 items-center gap-6">
          <nav aria-label={t('sidebar.subagents')} className="inline-flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-full border bg-[hsl(var(--shell-surface-muted))] p-1 [border-color:hsl(var(--shell-border))]">
            {modules.map((module) => (
              <NavLink
                key={module.id}
                to={module.to === pathname ? currentLocation : (moduleLocations.get(module.to) ?? module.to)}
                onMouseEnter={() => prefetchModule(module)}
                onFocus={() => prefetchModule(module)}
                className={({ isActive }) => cn(
                  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[hsl(var(--shell-text-muted))] transition-colors hover:bg-[hsl(var(--shell-surface-hover))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                  isActive && 'bg-[hsl(var(--shell-surface))] text-foreground',
                )}
              >
                <module.icon className="size-4" aria-hidden="true" />
                {t(module.label)}
              </NavLink>
            ))}
          </nav>
          <RuntimeScopeSelector />
        </div>
      </header>
      {children}
    </div>
  );
}

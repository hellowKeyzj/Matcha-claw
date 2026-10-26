import { Suspense, type ReactElement } from 'react';
import { matchRoutes, Navigate, Route, Routes } from 'react-router-dom';
import { applicationPages, type PageContribution } from './extensions';
import type { PluginHost } from '@/plugin-host/core';
import { useContributions } from '@/plugin-host/react';
import { useDelayedFlag } from '@/lib/use-delayed-flag';

export function RouteLoadingFallback() {
  const visible = useDelayedFlag(true, 160);
  if (!visible) {
    return null;
  }
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      加载中...
    </div>
  );
}

export function resolvePageContribution(
  pages: readonly PageContribution[],
  path: string,
): PageContribution | undefined {
  const pathname = path.split(/[?#]/, 1)[0];
  return matchRoutes([...pages], pathname)?.[0]?.route;
}

export async function preloadRoute(host: PluginHost, path: string): Promise<void> {
  const pages = host.get(applicationPages);
  const visited = new Set<string>();
  let page = resolvePageContribution(pages, path);
  while (page && !visited.has(page.id)) {
    visited.add(page.id);
    if (page.preload) await page.preload();
    page = page.redirectTo ? resolvePageContribution(pages, page.redirectTo) : undefined;
  }
}

export function ApplicationRoutes({ layout, login, register }: {
  layout: ReactElement;
  login: ReactElement;
  register: ReactElement;
}) {
  const pages = useContributions(applicationPages);
  return (
    <Routes>
      <Route path="/login" element={login} />
      <Route path="/register" element={register} />
      <Route element={layout}>
        {pages.map((page) => (
          <Route
            key={page.id}
            path={page.path}
            element={page.redirectTo ? <Navigate to={page.redirectTo} replace /> : page.component ? (
              <Suspense fallback={<RouteLoadingFallback />}>
                <page.component />
              </Suspense>
            ) : null}
          />
        ))}
      </Route>
    </Routes>
  );
}

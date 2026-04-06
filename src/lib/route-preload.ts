import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type PreloadableLazyComponent<T extends ComponentType<unknown>> = LazyExoticComponent<T> & {
  preload: () => Promise<{ default: T }>;
};

function lazyWithPreload<T extends ComponentType<unknown>>(
  loader: () => Promise<{ default: T }>,
): PreloadableLazyComponent<T> {
  const Component = lazy(loader) as PreloadableLazyComponent<T>;
  Component.preload = loader;
  return Component;
}

export const SetupRoute = lazyWithPreload(() => import('../pages/Setup'));
export const SkillsRoute = lazyWithPreload(() => import('../pages/Skills'));
export const SecurityRoute = lazyWithPreload(() => import('../pages/Security'));
export const SettingsRoute = lazyWithPreload(() => import('../pages/Settings'));
export const DashboardRoute = lazyWithPreload(() => import('../pages/Dashboard'));
export const ChannelsRoute = lazyWithPreload(() => import('../pages/Channels'));
export const SubAgentsRoute = lazyWithPreload(() => import('../pages/SubAgents'));
export const TasksRoute = lazyWithPreload(() => import('../pages/Tasks'));
export const PluginsRoute = lazyWithPreload(() => import('../pages/Plugins'));
export const ProvidersRoute = lazyWithPreload(() =>
  import('../pages/Providers').then((module) => ({ default: module.ProvidersPage })),
);
export const TeamsRoute = lazyWithPreload(() => import('../pages/Teams'));
export const TeamChatRoute = lazyWithPreload(() => import('../pages/Teams/TeamChat'));

function normalizePath(path: string): string {
  if (!path) {
    return '';
  }
  const [withoutHash] = path.split('#');
  const [withoutQuery] = withoutHash.split('?');
  return withoutQuery;
}

function resolveRoutePreloader(path: string): (() => Promise<unknown>) | null {
  const normalizedPath = normalizePath(path);
  if (normalizedPath.startsWith('/settings')) {
    return () => SettingsRoute.preload();
  }
  if (normalizedPath.startsWith('/security')) {
    return () => SecurityRoute.preload();
  }
  if (normalizedPath.startsWith('/skills')) {
    return () => SkillsRoute.preload();
  }
  if (normalizedPath.startsWith('/setup')) {
    return () => SetupRoute.preload();
  }
  if (normalizedPath.startsWith('/dashboard')) {
    return () => DashboardRoute.preload();
  }
  if (normalizedPath.startsWith('/channels')) {
    return () => ChannelsRoute.preload();
  }
  if (normalizedPath.startsWith('/subagents')) {
    return () => SubAgentsRoute.preload();
  }
  if (normalizedPath.startsWith('/tasks') || normalizedPath.startsWith('/cron')) {
    return () => TasksRoute.preload();
  }
  if (normalizedPath.startsWith('/providers')) {
    return () => ProvidersRoute.preload();
  }
  if (normalizedPath.startsWith('/plugins')) {
    return () => PluginsRoute.preload();
  }
  if (normalizedPath.startsWith('/teams/')) {
    return () => TeamChatRoute.preload();
  }
  if (normalizedPath.startsWith('/teams')) {
    return () => TeamsRoute.preload();
  }
  return null;
}

export function preloadLazyRouteForPath(path: string): Promise<unknown> | null {
  const preloader = resolveRoutePreloader(path);
  if (!preloader) {
    return null;
  }
  return preloader();
}

let criticalRoutePreloadStarted = false;

export function preloadCriticalLazyRoutes(): void {
  if (criticalRoutePreloadStarted) {
    return;
  }
  criticalRoutePreloadStarted = true;
  void SkillsRoute.preload();
  void SecurityRoute.preload();
  void SettingsRoute.preload();
  void DashboardRoute.preload();
  void TasksRoute.preload();
}

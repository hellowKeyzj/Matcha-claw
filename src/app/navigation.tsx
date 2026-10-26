import type { PluginHost } from '@/plugin-host/core';
import { applicationNavigation } from './extensions';
import { preloadRoute } from './routes';

export async function preloadApplicationPath(host: PluginHost, path: string): Promise<void> {
  const pathname = path.split(/[?#]/, 1)[0];
  await Promise.all([
    preloadRoute(host, path),
    ...host.get(applicationNavigation)
      .filter((item) => item.to === pathname)
      .map((item) => item.prefetch?.()),
  ]);
}

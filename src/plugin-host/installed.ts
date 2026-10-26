import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { hostAppPluginCatalog, hostAppPluginImport, hostAppPluginRequest } from '@/lib/host-api';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import type { AppPluginCatalog, InstalledAppPlugin } from '@/types/desktop/app-plugin';
import type { ApplicationPlugin, PluginHost } from './core';

interface InstalledPluginView {
  catalog: AppPluginCatalog;
  error: string | null;
  loading: boolean;
}

let view: InstalledPluginView = { catalog: { revision: -1, plugins: [] }, error: null, loading: true };
const listeners = new Set<() => void>();
const applied = new Map<string, { record: InstalledAppPlugin; plugin: ApplicationPlugin }>();
let binding: { host: PluginHost; create: (record: InstalledAppPlugin) => ApplicationPlugin } | null = null;
let refresh: Promise<void> | null = null;
let refreshRequested = false;

function publish(next: InstalledPluginView): void {
  view = next;
  for (const listener of listeners) listener();
}

function applyCatalog(catalog: AppPluginCatalog): void {
  if (!binding || catalog.revision < view.catalog.revision) return;
  const { host, create } = binding;
  const next = new Map<string, { record: InstalledAppPlugin; plugin: ApplicationPlugin }>();
  for (const record of catalog.plugins) {
    const previous = applied.get(record.manifest.id);
    const plugin = previous?.record.digest === record.digest && previous.record.enabled === record.enabled
      ? previous.plugin
      : create(record);
    next.set(record.manifest.id, { record, plugin });
  }
  // Commit contribution withdrawal before reporting a package disabled or uninstalled.
  flushSync(() => {
    host.replaceInstalled([...next.values()].map(({ plugin }) => plugin));
    applied.clear();
    for (const [id, entry] of next) applied.set(id, entry);
    publish({ catalog, error: null, loading: false });
  });
}

export async function refreshInstalledAppPlugins(): Promise<void> {
  refreshRequested = true;
  if (refresh) return refresh;
  refresh = (async () => {
    do {
      refreshRequested = false;
      const observer = binding;
      try {
        const catalog = await hostAppPluginCatalog();
        if (binding === observer) applyCatalog(catalog);
      } catch (error) {
        if (binding !== observer) continue;
        publish({ ...view, loading: false, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    } while (refreshRequested && binding);
  })();
  try { await refresh; } finally { refresh = null; }
}

export function observeInstalledAppPlugins(
  host: PluginHost,
  create: (record: InstalledAppPlugin) => ApplicationPlugin,
): () => void {
  const observer = { host, create };
  binding = observer;
  const resync = () => { void refreshInstalledAppPlugins().catch(() => {}); };
  const changed = subscribeHostEvent('app-plugins:changed', resync);
  const recovered = subscribeBrowserRecovery(resync);
  resync();
  return () => {
    changed();
    recovered();
    if (binding !== observer) return;
    binding = null;
    applied.clear();
    host.replaceInstalled([]);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => view;

export function useInstalledAppPlugins(): InstalledPluginView {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export async function importAppPlugin(packageBase64: string, digest: string): Promise<void> {
  await hostAppPluginImport(packageBase64, digest);
  await refreshInstalledAppPlugins();
}

export async function setAppPluginEnabled(record: InstalledAppPlugin, enabled: boolean): Promise<void> {
  await hostAppPluginRequest('enabled', { id: record.manifest.id, digest: record.digest, enabled });
  await refreshInstalledAppPlugins();
}

export async function rollbackAppPlugin(record: InstalledAppPlugin): Promise<void> {
  await hostAppPluginRequest('rollback', { id: record.manifest.id, digest: record.digest });
  await refreshInstalledAppPlugins();
}

export async function uninstallAppPlugin(record: InstalledAppPlugin): Promise<void> {
  await hostAppPluginRequest('uninstall', { id: record.manifest.id, digest: record.digest });
  await refreshInstalledAppPlugins();
}

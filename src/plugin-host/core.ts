import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface ExtensionPoint<T> {
  readonly id: string;
  readonly valueType?: T;
}

export function defineExtensionPoint<T>(id: string): ExtensionPoint<T> {
  return { id };
}

export interface ExtensionContribution {
  readonly point: ExtensionPoint<unknown>;
  readonly value: unknown;
}

export function contribute<T>(point: ExtensionPoint<T>, value: NoInfer<T>): ExtensionContribution {
  return { point, value };
}

export type PluginCleanup = (reason?: 'page-exit') => void;

export interface ApplicationPlugin {
  readonly id: string;
  readonly requires?: readonly string[];
  readonly extensionPoints?: readonly ExtensionPoint<unknown>[];
  readonly contributes?: readonly ExtensionContribution[];
  readonly activate?: () => void | PluginCleanup;
}

export function definePlugin(plugin: ApplicationPlugin): ApplicationPlugin {
  return plugin;
}

export interface PluginHost {
  readonly plugins: readonly ApplicationPlugin[];
  get<T>(point: ExtensionPoint<T>): readonly T[];
  subscribe(point: ExtensionPoint<unknown>, listener: () => void): () => void;
  replaceInstalled(plugins: readonly ApplicationPlugin[]): void;
  start(): PluginCleanup;
}

const EMPTY_CONTRIBUTIONS: readonly never[] = Object.freeze([]);

function resolvePlugins(plugins: readonly ApplicationPlugin[]) {
  const byId = new Map<string, ApplicationPlugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) throw new Error(`Duplicate application plugin: ${plugin.id}`);
    byId.set(plugin.id, plugin);
  }
  const ordered: ApplicationPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (plugin: ApplicationPlugin) => {
    if (visited.has(plugin.id)) return;
    if (visiting.has(plugin.id)) throw new Error(`Cyclic application plugin dependency: ${plugin.id}`);
    visiting.add(plugin.id);
    for (const id of plugin.requires ?? []) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error(`Plugin ${plugin.id} requires ${id}`);
      visit(dependency);
    }
    visiting.delete(plugin.id);
    visited.add(plugin.id);
    ordered.push(plugin);
  };
  plugins.forEach(visit);
  const points = new Map<string, ExtensionPoint<unknown>>();
  for (const plugin of ordered) {
    for (const point of plugin.extensionPoints ?? []) {
      if (points.has(point.id)) throw new Error(`Duplicate extension point: ${point.id}`);
      points.set(point.id, point);
    }
  }
  const values = new Map<string, readonly unknown[]>();
  for (const plugin of ordered) {
    for (const { point, value } of plugin.contributes ?? []) {
      if (points.get(point.id) !== point) throw new Error(`Plugin ${plugin.id} contributes to undeclared point ${point.id}`);
      const entries = values.get(point.id) as unknown[] | undefined;
      if (entries) entries.push(value);
      else values.set(point.id, [value]);
    }
  }
  for (const entries of values.values()) Object.freeze(entries);
  return { ordered: Object.freeze(ordered), values };
}

export function createPluginHost(plugins: readonly ApplicationPlugin[]): PluginHost {
  const builtins = [...plugins];
  let snapshot = resolvePlugins(builtins);
  const listeners = new Map<string, Set<() => void>>();
  const cleanups = new Map<string, PluginCleanup>();
  let started = false;

  const publish = (next: ReturnType<typeof resolvePlugins>) => {
    const changed = new Set([...snapshot.values.keys(), ...next.values.keys()]);
    for (const id of changed) {
      const before = snapshot.values.get(id) ?? EMPTY_CONTRIBUTIONS;
      const after = next.values.get(id) ?? EMPTY_CONTRIBUTIONS;
      if (before.length === after.length && before.every((value, index) => value === after[index])) {
        next.values.set(id, before);
        changed.delete(id);
      }
    }
    snapshot = next;
    for (const id of changed) {
      for (const listener of listeners.get(id) ?? []) listener();
    }
  };

  const stop: PluginCleanup = (reason) => {
    started = false;
    const errors: unknown[] = [];
    for (const plugin of [...snapshot.ordered].reverse()) {
      const cleanup = cleanups.get(plugin.id);
      cleanups.delete(plugin.id);
      try { cleanup?.(reason); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Application plugin cleanup failed');
  };

  return {
    get plugins() { return snapshot.ordered; },
    get<T>(point: ExtensionPoint<T>): readonly T[] {
      return (snapshot.values.get(point.id) ?? EMPTY_CONTRIBUTIONS) as readonly T[];
    },
    subscribe(point, listener) {
      let entries = listeners.get(point.id);
      if (!entries) listeners.set(point.id, entries = new Set());
      entries.add(listener);
      return () => {
        entries.delete(listener);
        if (!entries.size) listeners.delete(point.id);
      };
    },
    replaceInstalled(installed) {
      // External adapters own their resources in mounted contributions, not global activation.
      if (installed.some((plugin) => plugin.activate)) {
        throw new Error('Installed plugins must use contribution-owned lifecycles');
      }
      publish(resolvePlugins([...builtins, ...installed]));
    },
    start() {
      if (started) throw new Error('Application plugin host is already started');
      started = true;
      try {
        for (const plugin of snapshot.ordered) {
          const cleanup = plugin.activate?.();
          if (cleanup) cleanups.set(plugin.id, cleanup);
        }
      } catch (error) {
        try { stop(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Application plugin activation failed', { cause: cleanupError });
        }
        throw error;
      }
      return stop;
    },
  };
}

export type PreloadableComponent<Props extends object> = LazyExoticComponent<ComponentType<Props>> & {
  preload: () => Promise<{ default: ComponentType<Props> }>;
};

export function lazyWithPreload<Props extends object>(
  loader: () => Promise<{ default: ComponentType<Props> }>,
): PreloadableComponent<Props> {
  const component = lazy(loader) as PreloadableComponent<Props>;
  component.preload = loader;
  return component;
}

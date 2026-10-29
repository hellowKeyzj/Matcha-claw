import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import '../../src/styles/globals.css';
import 'katex/dist/katex.min.css';
import { coreFixture, coreIpc } from './core.mjs';

const params = new URLSearchParams(location.search);
const context = { scenarioId: params.get('scene') ?? 'chat-empty', route: decodeURIComponent(location.hash.slice(1) || '/'), url: '' };
const diagnostics = { ready: false, missing: [] as string[], fixtureErrors: [] as string[], calls: [] as string[], error: null as string | null };
Object.assign(window, { __design: diagnostics });
localStorage.setItem('matchaclaw-settings', JSON.stringify({ state: { theme: 'light', language: 'zh', autoCheckUpdate: false, devModeUnlocked: true }, version: 0 }));
document.documentElement.className = 'light';

const loaders = import.meta.glob(['./settings.mjs', './chat.mjs', './workflows.mjs', './tools.mjs', './fleet.mjs', './knowledge.mjs', './account-providers.mjs']);
const modules = await Promise.all(Object.values(loaders).map((load) => load())) as Record<string, unknown>[];
const httpHandlers = modules.flatMap((module) => Object.entries(module).filter(([name]) => name.endsWith('Fixture')).map(([, value]) => value as typeof coreFixture));
const ipcHandlers = modules.flatMap((module) => Object.entries(module).filter(([name]) => name.endsWith('Ipc')).map(([, value]) => value as typeof coreIpc));
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const emit = (name: string, payload: unknown) => listeners.get(name)?.forEach((listener) => listener(payload));
Object.assign(window, {
  electron: {
    platform: 'win32', traceEnabled: false,
    openExternal: () => Promise.resolve(),
    ipcRenderer: {
      on: (name: string, callback: (...args: unknown[]) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(callback);
        return () => listeners.get(name)?.delete(callback);
      },
      off: (name: string, callback: (...args: unknown[]) => void) => listeners.get(name)?.delete(callback),
      send: () => {},
      invoke: async (channel: string, ...args: unknown[]) => {
        try {
          if (channel !== 'hostapi:fetch') {
            if (channel === 'window:setRightDockWidth') return await (window as unknown as { __designResizeDock: (...args: unknown[]) => Promise<unknown> }).__designResizeDock(...args);
            for (const handler of [...ipcHandlers, coreIpc]) {
              const result = await handler(channel, args, context);
              if (result !== undefined) return structuredClone(result);
            }
          } else {
            const request = args[0] as { path: string; body?: string };
            const url = new URL(request.path, 'http://design.invalid');
            const requestContext = { ...context, url: url.href };
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            diagnostics.calls.push(`${url.pathname}${body?.operationId ? `:${body.operationId}` : ''}`);
            for (const handler of [...httpHandlers, coreFixture]) {
              const result = await handler(url.pathname, body, requestContext);
              if (result !== undefined) {
                const status = result?.__designHttpStatus ?? 200;
                return { ok: true, data: { status, ok: status < 400, json: structuredClone(result?.__designHttpStatus ? result.json : result) } };
              }
            }
          }
          const request = args[0] as { path?: string; body?: string } | undefined;
          const message = `${channel} ${request?.path ?? ''} ${request?.body ?? ''}`;
          if (!diagnostics.missing.includes(message)) diagnostics.missing.push(message);
          throw new Error(`Missing design fixture: ${message}`);
        } catch (error) {
          diagnostics.fixtureErrors.push(`${channel} ${String(error)}`);
          if (channel === 'hostapi:fetch') return { ok: false, error: { code: 'UNAVAILABLE', message: String(error) } };
          throw error;
        }
      },
    },
  },
  __designEmit: emit,
});

let cleanup: (() => void) | undefined;
try {
  const [app, { default: i18n }, { useSettingsStore }, { useAccountStore }, { useGatewayStore }, { useLicenseStore }, { useRuntimeEndpointsStore }, { useProviderStore }, { applicationPluginsHost }, { PluginHostProvider }] = await Promise.all([
    import('../../src/App'), import('../../src/i18n'), import('../../src/plugins/settings/store'), import('../../src/plugins/account/stores/account'),
    import('../../src/plugins/runtime/store'), import('../../src/plugins/account/stores/license'), import('../../src/plugins/runtime/directory'), import('../../src/plugins/providers/stores/providers'),
    import('../../src/app/plugins'), import('../../src/plugin-host/react'),
  ]);
  const stopPlugins = applicationPluginsHost.start();
  let root: ReturnType<typeof createRoot> | undefined;
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) stopPlugins();
  };
  cleanup = () => {
    window.removeEventListener('pagehide', onPageHide);
    try { root?.unmount(); } finally { stopPlugins(); }
  };
  window.addEventListener('pagehide', onPageHide);
  if (import.meta.hot) import.meta.hot.dispose(cleanup);
  await i18n.changeLanguage('zh');
  await Promise.all([useSettingsStore.getState().init(), useAccountStore.getState().init(), useGatewayStore.getState().init(), useLicenseStore.getState().refresh(), useRuntimeEndpointsStore.getState().refresh(), useProviderStore.getState().init()]);
  for (const module of modules) {
    for (const [name, seed] of Object.entries(module)) {
      if (name.startsWith('seed') && typeof seed === 'function') await seed(context);
    }
  }
  root = createRoot(document.getElementById('root')!);
  root.render(<PluginHostProvider host={applicationPluginsHost}><HashRouter><app.default /></HashRouter></PluginHostProvider>);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  diagnostics.ready = true;
} catch (cause) {
  let error = cause;
  try { cleanup?.(); } catch (cleanupError) {
    error = new AggregateError([error, cleanupError], 'Design export initialization and cleanup failed');
  }
  diagnostics.error = error instanceof Error ? error.stack ?? error.message : String(error);
  document.getElementById('root')!.textContent = diagnostics.error;
  console.error(error);
}

import { useEffect } from 'react';
import type { ApplicationLifecycleProps } from '@/app/extensions';
import { isTraceEnabled, startupTrace } from '@/lib/trace-logger';
import { useSettingsStore } from './store';
import { useUpdateStore } from './update/store';
import { UpdateNotifier } from './update/UpdateNotifier';

export function SettingsLifecycle({ hostReady }: ApplicationLifecycleProps) {
  const initSettings = useSettingsStore((state) => state.init);

  useEffect(() => {
    if (!hostReady) return;
    if (!isTraceEnabled()) {
      void initSettings();
      return;
    }
    const startedAt = performance.now();
    startupTrace('renderer.app', 'settings.init.start');
    void initSettings().finally(() => startupTrace('renderer.app', 'settings.init.end', () => ({
      durationMs: Math.round(performance.now() - startedAt),
      initialized: useSettingsStore.getState().initialized,
    })));
    return () => startupTrace('renderer.app', 'settings.init.cleanup');
  }, [hostReady, initSettings]);

  return null;
}

export function UpdateLifecycle() {
  const initUpdate = useUpdateStore((state) => state.init);
  const subscribeUpdate = useUpdateStore((state) => state.subscribe);

  useEffect(() => {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tracing = isTraceEnabled();
    const startedAt = tracing ? performance.now() : 0;
    if (tracing) startupTrace('renderer.app', 'update.init.start');
    const initialization = initUpdate();
    void initialization.then(() => {
      if (stopped) return;
      unsubscribe = subscribeUpdate();
      if (useSettingsStore.getState().autoCheckUpdate) {
        timer = setTimeout(() => {
          void useUpdateStore.getState().checkForUpdates().catch(() => {});
        }, 10_000);
      }
    });
    if (tracing) {
      void initialization.finally(() => startupTrace('renderer.app', 'update.init.end', () => ({
        durationMs: Math.round(performance.now() - startedAt),
        initialized: useUpdateStore.getState().isInitialized,
        outcome: useUpdateStore.getState().error ? 'error' : 'settled',
      })));
    }
    return () => {
      stopped = true;
      unsubscribe?.();
      clearTimeout(timer);
      if (tracing) startupTrace('renderer.app', 'update.init.cleanup');
    };
  }, [initUpdate, subscribeUpdate]);

  return <UpdateNotifier />;
}

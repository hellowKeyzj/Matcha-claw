import { useMemo, useSyncExternalStore } from 'react';
import i18n from '@/i18n';
import { hostApiFetch } from '@/lib/host-api';
import type { AppPluginManifest, InstalledAppPlugin } from '@/types/desktop/app-plugin';
import type { AppJson } from '@/types/desktop/app-plugin-sdk';
import type { AppDevelopmentAction } from './development-protocol';
import type { PluginDevelopmentSummary } from './development';

type DevelopmentCommand = { id: string; revision: number; entry: string } & (
  | { kind: 'inspect' }
  | { kind: 'act'; action: AppDevelopmentAction }
);
export type DevelopmentStatus = PluginDevelopmentSummary & {
  backendState: 'not-started' | 'ready' | 'error';
  logs: { seq: number; at: string; level: string; message: string }[];
  events: { seq: number; revision: number; topic: string; data: AppJson }[];
  commands: DevelopmentCommand[];
  installed?: InstalledAppPlugin;
  error?: string;
};
export type DevelopmentBundle = { revision: number; entry: string; html: string; manifest: AppPluginManifest; digest: string };

export function readDevelopmentStatus(developmentId: string, signal: AbortSignal): Promise<DevelopmentStatus> {
  return hostApiFetch<DevelopmentStatus>('/api/app-plugins/development-status', { method: 'POST', body: JSON.stringify({ developmentId }), signal });
}

type Observation = {
  snapshot: { status: DevelopmentStatus | null; error: string | null };
  subscribe: (listener: () => void) => () => void;
  read: () => Observation['snapshot'];
};
const observations = new Map<string, Observation>();
const empty = { status: null, error: null };
function observation(developmentId: string): Observation {
  const existing = observations.get(developmentId);
  if (existing) return existing;
  const listeners = new Set<() => void>();
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const value: Observation = {
    snapshot: empty,
    read: () => value.snapshot,
    subscribe: (listener) => {
      observations.set(developmentId, value);
      listeners.add(listener);
      if (!controller) {
        const lifetime = new AbortController();
        controller = lifetime;
        const poll = async () => {
          try {
            const status = await readDevelopmentStatus(developmentId, lifetime.signal);
            if (lifetime.signal.aborted) return;
            value.snapshot = { status, error: null };
          } catch (cause) {
            if (lifetime.signal.aborted) return;
            value.snapshot = { ...value.snapshot, error: cause instanceof Error ? cause.message : i18n.t('applicationPlugins:preview.statusFailed') };
          }
          for (const notify of listeners) notify();
          if (!lifetime.signal.aborted && value.snapshot.status?.state !== 'installed' && value.snapshot.status?.state !== 'stopped') timer = setTimeout(() => void poll(), 500);
        };
        void poll();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        controller?.abort();
        controller = null;
        clearTimeout(timer);
        if (observations.get(developmentId) === value) observations.delete(developmentId);
      };
    },
  };
  observations.set(developmentId, value);
  return value;
}

export function useDevelopmentStatus(developmentId: string) {
  const value = useMemo(() => observation(developmentId), [developmentId]);
  return useSyncExternalStore(value.subscribe, value.read, value.read);
}

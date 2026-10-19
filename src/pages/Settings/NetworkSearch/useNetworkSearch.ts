import { useCallback, useEffect, useRef, useState } from 'react';
import { AppError } from '@/lib/error-model';
import { fetchNetworkSearch, runNetworkSearchService, saveNetworkSearch } from '@/lib/network-search';
import type { SearchConfig, SearchSnapshot } from '@/types/network-search';

type SearchAction = 'refresh' | 'save' | 'prepare' | 'restart' | 'stop';
type SearchView = { snapshot: SearchSnapshot; draft: SearchConfig; draftRevision: number };

export function useNetworkSearch() {
  const [view, setView] = useState<SearchView | null>(null);
  const [pending, setPending] = useState<SearchAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const read = useRef<AbortController | null>(null);

  const receive = useCallback((snapshot: SearchSnapshot, saved = false) => {
    setView((current) => {
      if (current && snapshot.revision < current.snapshot.revision) return current;
      const hasDraft = current && JSON.stringify(current.draft) !== JSON.stringify(current.snapshot.config);
      return saved || !hasDraft || JSON.stringify(current.draft) === JSON.stringify(snapshot.config)
        ? { snapshot, draft: snapshot.config, draftRevision: snapshot.revision }
        : { ...current, snapshot };
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (!active || document.visibilityState === 'hidden') return;
      if (!read.current && !operation.current) {
        const controller = new AbortController();
        read.current = controller;
        try {
          const snapshot = await fetchNetworkSearch(controller.signal);
          if (!controller.signal.aborted && active) {
            receive(snapshot);
            setReadError(null);
          }
        } catch (failure) {
          if (!controller.signal.aborted && active) setReadError(failure);
        } finally {
          if (read.current === controller) read.current = null;
          if (active) setLoading(false);
        }
      }
      if (active && !document.hidden) timer = setTimeout(() => void refresh(), 5_000);
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') read.current?.abort();
      else void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void refresh();
    return () => {
      active = false;
      mounted.current = false;
      clearTimeout(timer);
      read.current?.abort();
      operation.current?.abort();
      read.current = null;
      operation.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [receive]);

  const run = async (action: SearchAction) => {
    if (operation.current || action === 'save' && !view) return;
    const controller = new AbortController();
    operation.current = controller;
    read.current?.abort();
    setPending(action);
    setError(null);
    setReadError(null);
    try {
      let snapshot: SearchSnapshot;
      if (action === 'refresh') snapshot = await fetchNetworkSearch(controller.signal);
      else if (action === 'save') {
        if (!view) return;
        snapshot = await saveNetworkSearch(view.draftRevision, view.draft, controller.signal);
      } else snapshot = await runNetworkSearchService(action, controller.signal);
      if (mounted.current && !controller.signal.aborted) receive(snapshot, action === 'save');
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(failure);
      // A failed apply can still have persisted desired state. Read it, never claim rollback.
      if (action !== 'refresh') {
        try {
          const snapshot = await fetchNetworkSearch(controller.signal);
          if (mounted.current && !controller.signal.aborted) receive(snapshot);
        } catch {
          // Keep the original operation error and the user's draft.
        }
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) { setPending(null); setLoading(false); }
    }
  };

  const updateDraft = (patch: Partial<SearchConfig>) => {
    setView((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
  };
  const discard = () => {
    setView((current) => current ? {
      ...current, draft: current.snapshot.config, draftRevision: current.snapshot.revision,
    } : current);
    setError(null);
  };

  return {
    snapshot: view?.snapshot ?? null,
    draft: view?.draft ?? null,
    dirty: !!view && JSON.stringify(view.draft) !== JSON.stringify(view.snapshot.config),
    conflict: !!view && view.draftRevision !== view.snapshot.revision
      || error instanceof AppError && error.details?.status === 409,
    pending, loading, error: error ?? readError, run, updateDraft, discard,
  };
}

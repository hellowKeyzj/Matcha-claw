import { useEffect, useRef, useState } from 'react';
import type { GenerationRecord } from '../document';
import { app, call, errorMessage } from './api';

export interface GenerationCloseState {
  phase: 'checking' | 'confirm' | 'cancelling';
  count: number;
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function useGenerationClose(documentId: string, pending: Set<Promise<unknown>>, readGenerations: () => Promise<GenerationRecord[]>, onError: (message: string) => void) {
  const [state, setState] = useState<GenerationCloseState | null>(null);
  const active = useRef<{ controller: AbortController; decide?: (confirmed: boolean) => void } | null>(null);

  useEffect(() => {
    const register = app().onCloseRequested;
    if (!register) return;
    const unregister = register(async (hostSignal) => {
      if (active.current) return false;
      const attempt = { controller: new AbortController(), decide: undefined as ((confirmed: boolean) => void) | undefined };
      active.current = attempt;
      const signal = AbortSignal.any([hostSignal, attempt.controller.signal]);
      let allowed = false;
      const release = () => {
        if (active.current === attempt) { active.current = null; setState(null); }
      };
      signal.addEventListener('abort', release, { once: true });
      setState({ phase: 'checking', count: 0 });
      async function read() {
        const records = await waitFor(readGenerations(), signal);
        signal.throwIfAborted();
        return records.filter((record) => record.state === 'running');
      }
      try {
        let running = await read();
        if (!running.length && !pending.size) { allowed = true; setState(null); return true; }
        setState({ phase: 'confirm', count: Math.max(running.length, pending.size) });
        const confirmed = await waitFor(new Promise<boolean>((resolve) => { attempt.decide = resolve; }), signal);
        attempt.decide = undefined;
        if (!confirmed) return false;
        setState({ phase: 'cancelling', count: Math.max(running.length, pending.size) });
        // A local call can be accepted before its first persisted generation record is visible.
        for (;;) {
          running = await read();
          await waitFor(Promise.all(running.map((record) => call('generation_cancel', { documentId, generationId: record.id }))), signal);
          running = await read();
          if (!running.length && !pending.size) { allowed = true; setState(null); return true; }
          await waitFor(new Promise<void>((resolve) => setTimeout(resolve, 100)), signal);
        }
      } catch (cause) {
        if (!signal.aborted) onError(errorMessage(cause));
        return false;
      } finally {
        if (!allowed) { signal.removeEventListener('abort', release); release(); }
      }
    });
    return () => {
      active.current?.controller.abort();
      active.current = null;
      unregister();
    };
  }, [documentId, pending, readGenerations, onError]);

  return {
    state,
    isClosing: () => active.current !== null,
    confirm: () => active.current?.decide?.(true),
    stay: () => active.current?.controller.abort(),
  };
}

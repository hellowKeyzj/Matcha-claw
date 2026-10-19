import { create } from 'zustand';
import { boardExecute } from '@/lib/board-api';
import { subscribeBrowserRecovery, subscribeHostEvent } from '@/lib/host-events';
import {
  boardIdentityKey,
  decodeBoardChangedEvent,
  decodeBoardCommandEvent,
  decodeBoardFailure,
  decodeBoardIdentity,
  type BoardCommand,
  type BoardFailure,
  type BoardIdentity,
  type BoardMethod,
  type BoardOperation,
  type BoardResult,
  type BoardSnapshot,
} from '@/types/board';

export interface BoardState {
  identity: BoardIdentity | null;
  snapshot: BoardSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  error: BoardFailure | null;
  activeTabId: string | null;
  command: BoardCommand | null;
  open(identity: BoardIdentity): Promise<void>;
  close(): void;
  refresh(): Promise<void>;
  execute<M extends BoardMethod>(operation: Extract<BoardOperation, { method: M }>): Promise<BoardResult<M>>;
  selectTab(tabId: string): void;
  clearCommand(): void;
}

type BoardObservation = {
  identity: BoardIdentity;
  key: string;
  cleanup: () => void;
  read: Promise<BoardSnapshot> | null;
  dirty: boolean;
  generation: number;
  revision: number;
};

function boardFailure(error: unknown): BoardFailure {
  try {
    if (error instanceof Error && 'code' in error) return decodeBoardFailure({ code: error.code, message: error.message });
    return decodeBoardFailure(error);
  } catch {
    return { code: 'unknown', message: 'Board operation outcome is unknown; refresh to confirm before trying again' };
  }
}

function failureError(failure: BoardFailure): Error & BoardFailure {
  return Object.assign(new Error(failure.message), failure);
}

const closedFailure: BoardFailure = { code: 'stale', message: 'The Board changed or closed; the previous operation may still complete' };

export const useBoardStore = create<BoardState>((set, get) => {
  let observation: BoardObservation | null = null;

  function applySnapshot(current: BoardObservation, snapshot: BoardSnapshot): void {
    if (observation !== current || snapshot.sessionKey !== current.identity.sessionKey || snapshot.revision < current.revision) return;
    current.revision = snapshot.revision;
    set((state) => {
      const requestedTab = state.command?.kind === 'focus_tab' ? state.command.tabId : state.activeTabId;
      return {
        snapshot,
        status: 'ready',
        error: state.error?.code === 'unknown' ? state.error : null,
        activeTabId: snapshot.tabs.some((tab) => tab.tabId === requestedTab)
          ? requestedTab : snapshot.tabs[0]?.tabId ?? null,
      };
    });
  }

  function readSnapshot(current: BoardObservation): Promise<BoardSnapshot> {
    current.dirty = true;
    if (current.read) return current.read;
    if (!get().snapshot) set({ status: 'loading' });
    current.read = (async () => {
      let result: BoardSnapshot | undefined;
      let failure: BoardFailure | null = null;
      try {
        do {
          current.dirty = false;
          const generation = current.generation;
          try {
            const snapshot = await boardExecute(current.identity, { method: 'board.get' });
            if (observation !== current) throw failureError(closedFailure);
            if (generation !== current.generation) continue;
            result = snapshot.revision < current.revision ? get().snapshot ?? undefined : snapshot;
            if (!result) throw failureError({ code: 'stale', message: 'Board snapshot is out of date; refresh to read the current revision' });
            applySnapshot(current, result);
            failure = null;
          } catch (error) {
            if (observation !== current) throw failureError(closedFailure);
            if (generation !== current.generation) continue;
            failure = boardFailure(error);
            set((state) => ({ status: 'unavailable', error: state.error?.code === 'unknown' ? state.error : failure }));
          }
        } while (current.dirty && observation === current);
        if (failure) throw failureError(failure);
        return result!;
      } finally {
        current.read = null;
      }
    })();
    return current.read;
  }

  async function refresh(): Promise<void> {
    const current = observation;
    if (!current) return;
    try {
      await readSnapshot(current);
    } catch {
      // readSnapshot records safe errors; a closed observation cannot write into its replacement.
    }
  }

  async function execute<M extends BoardMethod>(
    operation: Extract<BoardOperation, { method: M }>,
  ): Promise<BoardResult<M>> {
    const current = observation;
    if (!current) throw failureError({ code: 'unavailable', message: 'Open a Board before running this operation' });
    if (operation.method === 'board.get') return await readSnapshot(current) as BoardResult<M>;
    const generation = current.generation;
    set({ error: null });
    try {
      const result = await boardExecute<M>(current.identity, operation);
      if (observation !== current || generation !== current.generation) throw failureError(closedFailure);
      if (operation.method === 'board.update' || operation.method === 'board.widget.put' || operation.method === 'board.widget.grant') {
        applySnapshot(current, result as BoardSnapshot);
      }
      return result;
    } catch (error) {
      if (observation !== current || generation !== current.generation) throw failureError(closedFailure);
      const failure = boardFailure(error);
      set({ error: failure });
      if (failure.code === 'unknown') void refresh();
      throw failureError(failure);
    }
  }

  function close(): void {
    const previous = observation;
    observation = null;
    previous?.cleanup();
    set({ identity: null, snapshot: null, status: 'idle', error: null, activeTabId: null, command: null });
  }

  return {
    identity: null,
    snapshot: null,
    status: 'idle',
    error: null,
    activeTabId: null,
    command: null,
    open: async (identity) => {
      const key = boardIdentityKey(decodeBoardIdentity(identity));
      if (observation?.key === key) {
        await observation.read?.catch(() => undefined);
        return;
      }
      close();
      const current: BoardObservation = { identity, key, cleanup: () => {}, read: null, dirty: false, generation: 0, revision: -1 };
      observation = current;
      set({ identity, status: 'loading' });
      const changed = subscribeHostEvent<unknown>('board:changed', (payload) => {
        if (observation !== current) return;
        let event;
        try { event = decodeBoardChangedEvent(payload); } catch { return; }
        if (boardIdentityKey(event.identity) !== key || event.revision < current.revision) return;
        void refresh();
      });
      const command = subscribeHostEvent<unknown>('board:command', (payload) => {
        if (observation !== current) return;
        let event;
        try { event = decodeBoardCommandEvent(payload); } catch { return; }
        if (boardIdentityKey(event.identity) !== key) return;
        const command = event.command;
        set((state) => ({
          command,
          ...(command.kind === 'focus_tab' && state.snapshot?.tabs.some((tab) => tab.tabId === command.tabId)
            ? { activeTabId: command.tabId } : {}),
        }));
      });
      const invalidate = () => {
        if (observation !== current) return;
        current.generation += 1;
        set({ snapshot: null, status: 'loading', command: null });
        void refresh();
      };
      const resync = subscribeHostEvent<unknown>('board:resync', (payload) => {
        if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length === 0) invalidate();
      });
      const restart = subscribeHostEvent('runtime-host:restart', invalidate);
      const recovery = subscribeBrowserRecovery(() => {
        if (observation === current) void refresh();
      });
      current.cleanup = () => { changed(); command(); resync(); restart(); recovery(); };
      await refresh();
    },
    close,
    refresh,
    execute,
    selectTab: (tabId) => {
      if (get().snapshot?.tabs.some((tab) => tab.tabId === tabId)) set({ activeTabId: tabId });
    },
    clearCommand: () => set({ command: null }),
  };
});

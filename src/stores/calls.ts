import { create } from 'zustand';
import { getCall, getCallHistory, listCalls } from '@/lib/call-log';
import { decodeCallChanged } from '@/types/call-log/decode';
import { subscribeHostEvent } from '@/lib/host-events';
import type { CallHistory, CallPage, CallQuery, CallRecord } from '@/types/call-log';

interface CallsState {
  query: CallQuery;
  page: CallPage;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  detail: CallRecord | null;
  history: CallHistory;
  detailLoading: boolean;
  historyLoading: boolean;
  detailError: string | null;
  loadPage: (query: CallQuery) => Promise<void>;
  refresh: () => void;
  selectCall: (callId: string | null, refresh?: boolean) => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  subscribe: () => () => void;
}

export const useCallsStore = create<CallsState>((set, get) => {
  let pageRequest = 0;
  let detailRequest = 0;
  let pageAbort: AbortController | undefined;
  let detailAbort: AbortController | undefined;
  let pageDirty = false;
  let detailDirty = false;

  return {
    query: { limit: 50 },
    page: { items: [], next: null },
    loading: false,
    error: null,
    selectedId: null,
    detail: null,
    history: { items: [], next: null },
    detailLoading: false,
    historyLoading: false,
    detailError: null,
    loadPage: async (query) => {
      const request = ++pageRequest;
      pageAbort?.abort();
      pageAbort = new AbortController();
      pageDirty = false;
      const changed = JSON.stringify(query) !== JSON.stringify(get().query);
      set({ query, loading: true, error: null, ...(changed ? { page: { items: [], next: null } } : {}) });
      try {
        const page = await listCalls(query, pageAbort.signal);
        if (request === pageRequest) set({ page });
      } catch (error) {
        if (request === pageRequest) set({ error: String(error) });
      } finally {
        if (request === pageRequest) {
          set({ loading: false });
          if (pageDirty) get().refresh();
        }
      }
    },
    refresh: () => {
      if (get().loading) pageDirty = true;
      else void get().loadPage(get().query);
    },
    selectCall: async (callId, refresh = false) => {
      const previousHistory = get().history;
      const previousDetail = get().detail;
      const request = ++detailRequest;
      detailAbort?.abort();
      const abort = new AbortController();
      detailAbort = abort;
      detailDirty = false;
      const changed = callId !== get().selectedId;
      set({ selectedId: callId, detailLoading: callId !== null, historyLoading: false, detailError: null,
        ...(changed || !callId ? { detail: null, history: { items: [], next: null } } : {}) });
      if (!callId) return;
      try {
        const detail = await getCall(callId, abort.signal);
        if (request !== detailRequest) return;
        const afterRevision = refresh && !changed && previousDetail && previousHistory.next === null
          ? previousHistory.items[previousHistory.items.length - 1]?.revision
          : undefined;
        if (refresh && !changed && previousDetail && previousHistory.next !== null) {
          set({ detail });
        } else {
          const history = await getCallHistory(callId, detail.module, afterRevision, abort.signal);
          if (request === detailRequest) set({ detail, history: afterRevision === undefined ? history : {
            items: [...previousHistory.items, ...history.items], next: history.next,
          } });
        }
      } catch (error) {
        if (request === detailRequest) set({ detailError: String(error) });
      } finally {
        if (request === detailRequest) {
          set({ detailLoading: false });
          if (detailDirty) void get().selectCall(callId, true);
        }
      }
    },
    loadMoreHistory: async () => {
      const { detail, history, historyLoading, detailLoading } = get();
      if (!detail || history.next === null || historyLoading || detailLoading) return;
      const request = detailRequest;
      set({ historyLoading: true, detailError: null });
      try {
        const next = await getCallHistory(detail.callId, detail.module, history.next, detailAbort?.signal);
        if (request === detailRequest) set({ history: { items: [...history.items, ...next.items], next: next.next } });
      } catch (error) {
        if (request === detailRequest) set({ detailError: String(error) });
      } finally {
        if (request === detailRequest) set({ historyLoading: false });
      }
    },
    subscribe: () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          get().refresh();
          if (get().selectedId) {
            if (get().detailLoading) detailDirty = true;
            else void get().selectCall(get().selectedId, true);
          }
        }, 150);
      };
      const subscriptions = [
        subscribeHostEvent('call:changed', (payload) => {
          try { decodeCallChanged(payload); }
          catch (error) { console.warn('[calls] Invalid change notification', error); return; }
          refresh();
        }),
        subscribeHostEvent('calls:resync', refresh),
      ];
      return () => {
        for (const unsubscribe of subscriptions) unsubscribe();
        clearTimeout(timer);
        ++pageRequest;
        ++detailRequest;
        pageAbort?.abort();
        detailAbort?.abort();
        pageDirty = false;
        detailDirty = false;
        set({ loading: false, detailLoading: false, historyLoading: false });
      };
    },
  };
});

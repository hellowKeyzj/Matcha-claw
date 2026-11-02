import { useEffect, useRef, type RefObject } from 'react';
import type { IabUiCommand } from '@/types/desktop/iab';
import { iabCommand, onIabEvent, useIabStore } from './store';

let nativeTransition = Promise.resolve();

export function useNativeView(element: RefObject<HTMLDivElement | null>, visible: boolean, ownerId: string | null) {
  const hiddenOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!ownerId) return;
    if (visible) hiddenOwner.current = null;
    let disposed = false;
    let rectCache = '';
    let nativeVisible: boolean | null = null;
    let sending = false;
    let syncPending = false;
    let hideRequested = false;
    let frame = 0;
    let generation = 0;
    const send = (command: IabUiCommand, request?: number) => {
      const next = nativeTransition.then(async () => {
        if (useIabStore.getState().ownerId === ownerId && (request === undefined || (!disposed && request === generation))) await iabCommand(command);
      });
      nativeTransition = next.catch(() => {});
      return next;
    };
    const queueHide = () => {
      if (hiddenOwner.current === ownerId) return;
      hiddenOwner.current = ownerId;
      void send({ action: 'set-visible', visible: false }).catch(() => {});
    };
    if (!visible) { queueHide(); return; }
    const node = element.current;
    if (!node) return;
    const invalidate = () => { rectCache = ''; nativeVisible = null; generation++; };
    const hide = () => {
      if (hideRequested || nativeVisible === false && !sending) return;
      invalidate(); hideRequested = true;
      const request = generation;
      void send({ action: 'set-visible', visible: false }).then(() => {
        if (!disposed && request === generation) nativeVisible = false;
      }).catch(() => { if (!disposed && request === generation) hideRequested = false; });
    };
    const hasOpenOverlay = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open]')]
      .some((dialog) => dialog.getClientRects().length > 0 && dialog.getAttribute('aria-hidden') !== 'true');
    const sync = async () => {
      if (disposed) return;
      if (document.hidden || !node.isConnected || hasOpenOverlay()) { hide(); return; }
      const rect = node.getBoundingClientRect();
      const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      if (node.getClientRects().length === 0 || bounds.width <= 0 || bounds.height <= 0) { hide(); return; }
      hideRequested = false;
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (sending) { syncPending = true; return; }
      syncPending = false;
      if (rectCache === key && nativeVisible) return;
      const request = ++generation;
      sending = true;
      try {
        if (rectCache !== key) {
          await send({ action: 'set-bounds', bounds }, request);
          if (disposed || generation !== request) return;
          rectCache = key;
        }
        if (!nativeVisible) {
          await send({ action: 'set-visible', visible: true }, request);
          if (disposed || generation !== request) return;
          nativeVisible = true;
        }
      } catch { if (!disposed && generation === request) invalidate(); }
      finally {
        sending = false;
        if (syncPending && !disposed) void sync();
      }
    };
    const tick = () => { frame = 0; void sync(); };
    const schedule = () => { if (!disposed && !document.hidden && !frame) frame = requestAnimationFrame(tick); };
    const geometry = new ResizeObserver(schedule);
    geometry.observe(node);
    const observer = new MutationObserver(schedule);
    const observe = () => observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-hidden', 'data-state', 'style', 'class'] });
    const unsubscribe = onIabEvent((event) => {
      if (event.type !== 'tabs-changed' || event.snapshot.ownerId !== ownerId) return;
      if (event.snapshot.bounds.width <= 0 || event.snapshot.bounds.height <= 0 || (nativeVisible && !event.snapshot.visible)) { invalidate(); schedule(); }
    });
    const resize = () => { invalidate(); schedule(); };
    const updateVisibility = () => {
      cancelAnimationFrame(frame); frame = 0;
      observer.disconnect();
      if (document.hidden) hide();
      else { invalidate(); observe(); schedule(); }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => {
      disposed = true;
      invalidate();
      cancelAnimationFrame(frame);
      geometry.disconnect();
      observer.disconnect();
      unsubscribe();
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', updateVisibility);
      queueHide();
    };
  }, [element, visible, ownerId]);
}

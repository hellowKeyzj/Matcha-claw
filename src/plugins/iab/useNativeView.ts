import { useEffect } from 'react';
import type { IabViewPlacement } from '@/types/desktop/iab';
import { equalIabViews, iabCommand, reportIabError, useIabStore } from './store';

type ViewUpdate = { ownerId: string; views: IabViewPlacement[] };
let pending: ViewUpdate | null = null;
let sending = false;
let attempted: (ViewUpdate & { nativeViews: IabViewPlacement[] }) | null = null;

// One in-flight write and one latest layout, including across owner effect cleanup.
function syncNativeViews(update: ViewUpdate) {
  pending = update;
  void flushNativeViews();
}

async function flushNativeViews() {
  if (sending || !pending) return;
  const update = pending;
  pending = null;
  const current = useIabStore.getState();
  if (current.ownerId !== update.ownerId) return;
  // A close/crash can arrive while the previous layout write is in flight.
  update.views = update.views.filter((view) => current.tabs.some((tab) => tab.id === view.tabId && !tab.crash));
  if (equalIabViews(current.views, update.views)) return;
  if (attempted?.ownerId === update.ownerId && attempted.nativeViews === current.views && equalIabViews(attempted.views, update.views)) return;
  attempted = { ...update, nativeViews: current.views };
  sending = true;
  try { await iabCommand({ action: 'set-views', views: update.views }); }
  catch (error) { reportIabError(error); }
  finally { sending = false; if (pending) void flushNativeViews(); }
}

export function useNativeViews(isActive: boolean, ownerId: string | null) {
  useEffect(() => {
    if (!ownerId) return;
    const clear = () => syncNativeViews({ ownerId, views: [] });
    if (!isActive) { clear(); return; }
    let frame = 0;
    let disposed = false;
    const observed = new Set<HTMLElement>();
    const sync = () => {
      frame = 0;
      const current = useIabStore.getState();
      if (disposed || current.ownerId !== ownerId) return;
      if (document.hidden) { clear(); return; }
      const nodes = [...document.querySelectorAll<HTMLElement>('[data-iab-tab]')].filter((node) => node.dataset.iabOwner === ownerId);
      const overlays = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open], [data-workspace-drop-target]')];
      const nextObserved = new Set([...nodes, ...overlays]);
      for (const node of observed) if (!nextObserved.has(node)) { geometry.unobserve(node); observed.delete(node); }
      for (const node of nextObserved) if (!observed.has(node)) { geometry.observe(node); observed.add(node); }
      const blockers = overlays.filter((node) => node.getAttribute('aria-hidden') !== 'true' && node.checkVisibility({ visibilityProperty: true }))
        .map((node) => node.getBoundingClientRect());
      const views: IabViewPlacement[] = [];
      for (const node of nodes) {
        const tabId = node.dataset.iabTab!;
        if (node.dataset.iabVisible !== 'true' || !node.checkVisibility({ visibilityProperty: true }) || !current.tabs.some((tab) => tab.id === tabId && !tab.crash)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || blockers.some((blocker) => blocker.width > 0 && blocker.height > 0
          && blocker.left < rect.right && blocker.right > rect.left && blocker.top < rect.bottom && blocker.bottom > rect.top)) continue;
        views.push({ tabId, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      }
      syncNativeViews({ ownerId, views });
    };
    const schedule = () => { if (!disposed && !frame && !document.hidden) frame = requestAnimationFrame(sync); };
    const geometry = new ResizeObserver(schedule);
    const observer = new MutationObserver(schedule);
    const observe = () => observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['open', 'aria-hidden', 'data-state', 'style', 'class', 'hidden', 'inert', 'role', 'data-iab-owner', 'data-iab-tab', 'data-iab-visible', 'data-workspace-drop-target'] });
    const unsubscribe = useIabStore.subscribe((current, previous) => {
      if (current.ownerId !== ownerId) { clear(); return; }
      if (current.views !== previous.views || current.tabs !== previous.tabs) schedule();
    });
    const updateVisibility = () => {
      cancelAnimationFrame(frame); frame = 0;
      observer.disconnect();
      if (document.hidden) clear();
      else { attempted = null; observe(); schedule(); }
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      geometry.disconnect();
      observer.disconnect();
      unsubscribe();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('pagehide', clear);
      document.removeEventListener('visibilitychange', updateVisibility);
      clear();
    };
  }, [isActive, ownerId]);
}

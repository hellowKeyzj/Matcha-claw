import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { hostIabCommand, hostIabSnapshot } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { IabEvent, IabSnapshot, IabTab, IabUiCommand, IabUiResponse } from '@/types/desktop/iab';

interface IabState {
  ownerId: string | null;
  revision: number;
  tabs: IabSnapshot['tabs'];
  activeTabId: string | null;
}

export const useIabStore = create<IabState>(() => ({
  ownerId: null, revision: -1, tabs: [], activeTabId: null,
}));

let snapshotFlight: Promise<void> | null = null;
const eventListeners = new Set<(event: IabEvent) => void>();
export class IabProjectionDiscarded extends Error {}

// Display grouping is not Agent authorization; Main owns claims and access.
export function isIabTabVisible(tab: IabTab, sessionGroupId: string | null) {
  return tab.createdBy === null || tab.sessionGroupId === null || tab.sessionGroupId === sessionGroupId
    || sessionGroupId !== null && (tab.createdBy === sessionGroupId || tab.claimedBy === sessionGroupId);
}

function syncSnapshot(snapshot: IabSnapshot) {
  const current = useIabStore.getState();
  if ((current.revision >= 0 && snapshot.ownerId !== current.ownerId) || snapshot.revision < current.revision) return false;
  const previousTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const tabs = snapshot.tabs.map((tab) => {
    const previous = previousTabs.get(tab.id);
    if (!previous) return tab;
    const next = {
      ...tab,
      crash: shallow(previous.crash, tab.crash) ? previous.crash : tab.crash,
    };
    return shallow(previous, next) ? previous : next;
  });
  useIabStore.setState({
    ownerId: snapshot.ownerId, revision: snapshot.revision,
    tabs: shallow(current.tabs, tabs) ? current.tabs : tabs, activeTabId: snapshot.activeTabId,
  });
  return true;
}

export function refreshIabSnapshot(): Promise<void> {
  if (!snapshotFlight) snapshotFlight = hostIabSnapshot().then((snapshot) => {
    if (!syncSnapshot(snapshot) && snapshot.ownerId !== useIabStore.getState().ownerId) throw new IabProjectionDiscarded();
  }).finally(() => { snapshotFlight = null; });
  return snapshotFlight;
}

export async function iabCommand(command: IabUiCommand): Promise<IabUiResponse['result']> {
  if (useIabStore.getState().revision < 0) await refreshIabSnapshot();
  const ownerId = useIabStore.getState().ownerId;
  const response = await hostIabCommand({ command });
  if (ownerId !== useIabStore.getState().ownerId || response.ownerId !== ownerId) throw new IabProjectionDiscarded();
  if (response.result.resultType === 'error') throw new Error(response.result.message);
  if (response.result.resultType === 'snapshot') {
    if (!syncSnapshot(response.result.snapshot)) throw new IabProjectionDiscarded();
  } else if (response.revision < useIabStore.getState().revision && !['complete', 'opened', 'screenshot'].includes(response.result.resultType)) {
    throw new IabProjectionDiscarded();
  }
  return response.result;
}

export function observeIabEvents() {
  return subscribeHostEvent<IabEvent>('iab:event', (event) => {
    if (event.type === 'tabs-changed' && !syncSnapshot(event.snapshot)) return;
    const current = useIabStore.getState();
    if ('ownerId' in event && event.ownerId !== current.ownerId) return;
    if (event.type === 'overlay-state' && event.state && event.state.ownerId !== current.ownerId) return;
    if (event.type === 'find-result' && event.result.ownerId !== current.ownerId) return;
    for (const listener of eventListeners) listener(event);
  });
}

export function onIabEvent(listener: (event: IabEvent) => void) {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function reportIabError(error: unknown) {
  if (error instanceof IabProjectionDiscarded) return;
  const message = error instanceof Error ? error.message : String(error);
  const limit = message.match(/TAB_LIMIT_REACHED:\s*maxOpenTabs=(\d+);\s*openTabCount=(\d+)/);
  toast.error(limit ? i18n.t('iab:tabLimitReached', { maxOpenTabs: Number(limit[1]), openTabCount: Number(limit[2]) }) : message, { id: 'iab-action-error' });
}

export function normalizeIabAddress(value: string): string {
  const text = value.trim();
  if (!text || (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/?#\s:]+:\d+(?:[/?#]|$)/.test(text))) return text;
  if (!/\s/.test(text) && /^(localhost|\[[\da-f:]+\]|[^/?#]+\.[^/?#]+)(?:[/:?#]|$)/i.test(text)) {
    return `${/^(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(text) ? 'http' : 'https'}://${text}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { hostIabCommand, hostIabSnapshot } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import type { WorkspaceController } from '@/plugins/workspace/extensions';
import type { IabEvent, IabSnapshot, IabTab, IabUiCommand, IabUiResponse, IabViewPlacement } from '@/types/desktop/iab';
import { buildSessionIdentityKey } from '@/types/desktop/runtime-address';

type IabDisplayPromotion = {
  from: string;
  to: string;
  promise: Promise<IabUiResponse['result']>;
};

type IabOpening = {
  displayScope: string;
  promise: Promise<IabUiResponse['result']>;
  tab?: Pick<IabTab, 'ownerId' | 'id'>;
};

interface IabState {
  ownerId: string | null;
  revision: number;
  tabs: IabSnapshot['tabs'];
  activeTabId: string | null;
  views: IabViewPlacement[];
  pendingPromotions: IabDisplayPromotion[];
  openingTabs: IabOpening[];
}

export const useIabStore = create<IabState>(() => ({
  ownerId: null, revision: -1, tabs: [], activeTabId: null, views: [], pendingPromotions: [], openingTabs: [],
}));

export function equalIabViews(left: readonly IabViewPlacement[], right: readonly IabViewPlacement[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const bounds = new Map(right.map((view) => [view.tabId, view.bounds]));
  return left.every((view) => {
    const other = bounds.get(view.tabId);
    return other && view.bounds.x === other.x && view.bounds.y === other.y
      && view.bounds.width === other.width && view.bounds.height === other.height;
  });
}

let snapshotFlight: Promise<void> | null = null;
const eventListeners = new Set<(event: IabEvent) => void>();
export class IabProjectionDiscarded extends Error {}

export function buildIabDisplayScope(workspace: Pick<WorkspaceController, 'sessionIdentity' | 'scopeKey' | 'draftId'>) {
  return workspace.sessionIdentity ? buildSessionIdentityKey(workspace.sessionIdentity)
    : JSON.stringify([workspace.scopeKey, workspace.draftId ?? null]);
}

// Display grouping is not Agent authorization; Main owns claims and access.
export function isIabTabVisible(tab: IabTab, displayScope: string) {
  const display = tab.display;
  return display.kind === 'sessions' ? display.sessionIds.includes(displayScope)
    : display.scope === displayScope || useIabStore.getState().pendingPromotions.some((promotion) => promotion.to === displayScope && promotion.from === display.scope);
}

function syncSnapshot(snapshot: IabSnapshot, completedPromotion?: IabDisplayPromotion) {
  const current = useIabStore.getState();
  if (current.revision >= 0 && snapshot.ownerId !== current.ownerId) return false;
  const pendingPromotions = completedPromotion ? current.pendingPromotions.filter((entry) => entry !== completedPromotion) : current.pendingPromotions;
  if (snapshot.revision < current.revision) {
    // A newer projection already includes the confirmed Main promotion.
    if (completedPromotion) useIabStore.setState({ pendingPromotions });
    return !!completedPromotion;
  }
  const previousTabs = new Map(current.tabs.map((tab) => [tab.id, tab]));
  const tabs = snapshot.tabs.map((tab) => {
    const previous = previousTabs.get(tab.id);
    if (!previous) return tab;
    const display = tab.display.kind === 'sessions' && previous.display.kind === 'sessions'
      ? { ...tab.display, sessionIds: shallow(previous.display.sessionIds, tab.display.sessionIds) ? previous.display.sessionIds : tab.display.sessionIds }
      : tab.display;
    const next = {
      ...tab,
      display: shallow(previous.display, display) ? previous.display : display,
      crash: shallow(previous.crash, tab.crash) ? previous.crash : tab.crash,
    };
    return shallow(previous, next) ? previous : next;
  });
  const openingTabs = current.openingTabs.filter(({ tab: opened }) => !opened || tabs.some((tab) => tab.ownerId === opened.ownerId && tab.id === opened.id));
  useIabStore.setState({
    ownerId: snapshot.ownerId, revision: snapshot.revision,
    tabs: shallow(current.tabs, tabs) ? current.tabs : tabs, activeTabId: snapshot.activeTabId,
    views: equalIabViews(current.views, snapshot.views) ? current.views : snapshot.views, pendingPromotions,
    openingTabs: shallow(current.openingTabs, openingTabs) ? current.openingTabs : openingTabs,
  });
  return true;
}

export function refreshIabSnapshot(): Promise<void> {
  if (!snapshotFlight) snapshotFlight = hostIabSnapshot().then((snapshot) => {
    if (!syncSnapshot(snapshot) && snapshot.ownerId !== useIabStore.getState().ownerId) throw new IabProjectionDiscarded();
  }).finally(() => { snapshotFlight = null; });
  return snapshotFlight;
}

export function iabCommand(command: IabUiCommand): Promise<IabUiResponse['result']> {
  if (command.action === 'promote-display-scope') {
    const current = useIabStore.getState();
    const pending = current.pendingPromotions.find((entry) => entry.from === command.from && entry.to === command.to);
    if (pending) return pending.promise;
    // Opens already sent to the draft must settle before Main promotes it.
    const opening = current.openingTabs.filter((entry) => entry.displayScope === command.from).map((entry) => entry.promise);
    const promotion: IabDisplayPromotion = {
      from: command.from, to: command.to,
      promise: Promise.allSettled(opening).then(() => executeIabCommand(command, promotion)).catch((error: unknown) => {
        useIabStore.setState((state) => ({ openingTabs: state.openingTabs.filter((entry) => entry.displayScope !== command.from) }));
        throw error;
      }).finally(() => {
        const state = useIabStore.getState();
        if (state.pendingPromotions.includes(promotion)) useIabStore.setState({ pendingPromotions: state.pendingPromotions.filter((entry) => entry !== promotion) });
      }),
    };
    useIabStore.setState({ pendingPromotions: [...current.pendingPromotions, promotion] });
    return promotion.promise;
  }
  if (command.action === 'open') {
    const promotion = useIabStore.getState().pendingPromotions.find((entry) => entry.from === command.displayScope);
    const openingCommand = promotion ? { ...command, displayScope: promotion.to } : command;
    const opening: IabOpening = {
      displayScope: command.displayScope,
      promise: executeIabCommand(openingCommand).then((opened) => {
        if (opened.resultType !== 'opened') throw new Error(i18n.t('iab:failed'));
        const current = useIabStore.getState();
        const tab = current.tabs.find((entry) => entry.id === opened.tabId && entry.ownerId === current.ownerId);
        if (!tab) throw new IabProjectionDiscarded();
        useIabStore.setState((state) => ({ openingTabs: openingCommand.background
          ? state.openingTabs.filter((entry) => entry !== opening)
          : state.openingTabs.map((entry) => entry === opening ? { ...entry, tab: { ownerId: tab.ownerId, id: tab.id } } : entry) }));
        return opened;
      }).catch((error: unknown) => {
        useIabStore.setState((state) => ({ openingTabs: state.openingTabs.filter((entry) => entry !== opening) }));
        throw error;
      }),
    };
    useIabStore.setState((state) => ({ openingTabs: [...state.openingTabs, opening] }));
    return opening.promise;
  }
  return executeIabCommand(command);
}

async function executeIabCommand(command: IabUiCommand, completedPromotion?: IabDisplayPromotion): Promise<IabUiResponse['result']> {
  if (useIabStore.getState().revision < 0) await refreshIabSnapshot();
  const ownerId = useIabStore.getState().ownerId;
  const response = await hostIabCommand({ command });
  if (ownerId !== useIabStore.getState().ownerId || response.ownerId !== ownerId) throw new IabProjectionDiscarded();
  if (response.result.resultType === 'error') throw new Error(response.result.message);
  if (command.action === 'open') {
    // Drain a snapshot started before this open before confirming its revision.
    if (snapshotFlight) await snapshotFlight;
    if (useIabStore.getState().revision < response.revision) await refreshIabSnapshot();
    if (ownerId !== useIabStore.getState().ownerId) throw new IabProjectionDiscarded();
  }
  if (completedPromotion && response.result.resultType !== 'snapshot') throw new Error(i18n.t('iab:failed'));
  if (response.result.resultType === 'snapshot') {
    if (!syncSnapshot(response.result.snapshot, completedPromotion)) throw new IabProjectionDiscarded();
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

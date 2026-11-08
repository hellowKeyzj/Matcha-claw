import { useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { useWorkspace } from '@/plugins/workspace/context';
import { getProviderPane, isWorkspacePageRevealed } from '@/plugins/workspace/page-placement';
import type { IabEvent } from '@/types/desktop/iab';
import { browserPage, iabPageId } from './browser-page';
import { buildIabDisplayScope, iabCommand, isIabTabVisible, onIabEvent, refreshIabSnapshot, reportIabError, useIabStore } from './store';
import { useNativeViews } from './useNativeView';

export function IabWorkspace({ isActive }: ChatWorkspaceContentProps) {
  const workspace = useWorkspace();
  const { i18n: language } = useTranslation('iab');
  const ownerId = useIabStore((state) => state.ownerId);
  const tabs = useIabStore((state) => state.tabs);
  const activeTabId = useIabStore((state) => state.activeTabId);
  const pendingPromotions = useIabStore((state) => state.pendingPromotions);
  const openingTabs = useIabStore((state) => state.openingTabs);
  useNativeViews(isActive, ownerId);
  useEffect(() => {
    if (!isActive || !ownerId) return;
    const sync = () => void iabCommand({ action: 'set-presentation', theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', locale: language.language }).catch(() => {});
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [isActive, ownerId, language.language]);
  const { syncPages, scopeKey } = workspace;
  const displayScope = buildIabDisplayScope(workspace);
  const previousNative = useRef<{ ownerId: string | null; tabId: string | null; scopeKey: string }>({ ownerId: null, tabId: null, scopeKey });
  const showPage = useEffectEvent((event: Extract<IabEvent, { type: 'show-requested' }>) => {
    const current = useIabStore.getState();
    if (!isActive || current.ownerId !== event.ownerId) return;
    const tab = current.tabs.find((entry) => entry.id === event.tabId);
    if (tab && isIabTabVisible(tab, displayScope)) workspace.openPage(browserPage(tab, workspace));
  });
  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = onIabEvent((event) => { if (event.type === 'show-requested') showPage(event); });
    void refreshIabSnapshot().catch(reportIabError);
    return unsubscribe;
  }, [isActive]);
  const syncPageDescriptors = useEffectEvent(() => {
    if (!isActive) return;
    const { ownerId, tabs } = useIabStore.getState();
    if (ownerId) syncPages('iab', tabs.filter((tab) => isIabTabVisible(tab, displayScope)).map((tab) => browserPage(tab, workspace)));
  });
  useEffect(() => { syncPageDescriptors(); }, [isActive, ownerId, tabs, pendingPromotions, language.language, syncPages, scopeKey, displayScope]);
  const projectPages = useEffectEvent(() => {
    if (!isActive) return;
    const { ownerId, tabs, activeTabId, openingTabs } = useIabStore.getState();
    const previous = previousNative.current;
    previousNative.current = { ownerId, tabId: activeTabId, scopeKey };
    if (!ownerId) return;
    const visibleTabs = tabs.filter((tab) => isIabTabVisible(tab, displayScope));
    const completed = openingTabs.filter(({ tab: opened }) => opened);
    const requestedTabs = completed.map(({ tab: opened }) => visibleTabs.find((tab) => tab.ownerId === opened?.ownerId && tab.id === opened.id));
    const requestedTab = requestedTabs.filter((tab) => tab !== undefined).pop();
    if (completed.length) {
      const page = requestedTab && browserPage(requestedTab, workspace);
      const presented = page && isWorkspacePageRevealed(workspace, page.id);
      if (page && !presented) workspace.openPage(page);
      const consumed = completed.filter(({ displayScope: sourceScope }, index) => requestedTabs[index] ? presented : sourceScope !== displayScope);
      if (consumed.length) useIabStore.setState((state) => ({ openingTabs: state.openingTabs.filter((opening) => !consumed.includes(opening)) }));
      return;
    }
    const visibleNative = visibleTabs.some((tab) => tab.id === activeTabId);
    const nextTabId = visibleNative ? activeTabId : visibleTabs[0]?.id;
    if (!nextTabId) return;
    const nextPageId = iabPageId(ownerId, nextTabId);
    const pane = workspace.pagePlacements[nextPageId] ?? getProviderPane(workspace, 'iab');
    const selectedPageId = workspace.activePageIds[pane];
    if (workspace.activePageId === nextPageId) return;
    const selectedIab = workspace.pages.find((page) => page.id === selectedPageId)?.providerId === 'iab';
    const followsNative = visibleNative && previous.scopeKey === scopeKey && previous.ownerId === ownerId
      && previous.tabId !== activeTabId && previous.tabId !== null
      && (selectedPageId === nextPageId || selectedPageId === iabPageId(ownerId, previous.tabId));
    if ((pane === 'side' && workspace.activePageIds.main === null && workspace.activePageIds.side === null)
      || (selectedIab && (!visibleTabs.some((tab) => selectedPageId === iabPageId(ownerId, tab.id)) || followsNative))) {
      workspace.activatePage(nextPageId, { reveal: false });
    }
  });
  useEffect(() => { projectPages(); }, [isActive, ownerId, tabs, activeTabId, pendingPromotions, openingTabs, scopeKey, displayScope, workspace.pages, workspace.activePageId, workspace.activePageIds, workspace.pagePlacements, workspace.open, workspace.layout]);
  return null;
}

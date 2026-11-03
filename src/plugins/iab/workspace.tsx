import { useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { useWorkspace } from '@/plugins/workspace/context';
import type { IabEvent } from '@/types/desktop/iab';
import { buildSessionIdentityKey } from '@/types/desktop/runtime-address';
import { browserPage, iabPageId } from './browser-page';
import { iabCommand, isIabTabVisible, onIabEvent, refreshIabSnapshot, reportIabError, useIabStore } from './store';

export function IabWorkspace({ isActive }: ChatWorkspaceContentProps) {
  const workspace = useWorkspace();
  const { i18n: language } = useTranslation('iab');
  const ownerId = useIabStore((state) => state.ownerId);
  const tabs = useIabStore((state) => state.tabs);
  const activeTabId = useIabStore((state) => state.activeTabId);
  const { syncPages, scopeKey } = workspace;
  const sessionGroupId = workspace.sessionIdentity ? buildSessionIdentityKey(workspace.sessionIdentity) : null;
  const previousNative = useRef<{ ownerId: string | null; tabId: string | null; scopeKey: string }>({ ownerId: null, tabId: null, scopeKey });
  const showPage = useEffectEvent((event: Extract<IabEvent, { type: 'show-requested' }>) => {
    const current = useIabStore.getState();
    if (!isActive || current.ownerId !== event.ownerId) return;
    const tab = current.tabs.find((entry) => entry.id === event.tabId);
    if (tab && isIabTabVisible(tab, sessionGroupId)) workspace.openPage(browserPage(tab, workspace));
  });
  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = onIabEvent((event) => { if (event.type === 'show-requested') showPage(event); });
    void refreshIabSnapshot().catch(reportIabError);
    return () => { unsubscribe(); void iabCommand({ action: 'set-visible', visible: false }).catch(() => {}); };
  }, [isActive]);
  const projectPages = useEffectEvent(() => {
    if (!isActive) return;
    const { ownerId, tabs, activeTabId } = useIabStore.getState();
    const previous = previousNative.current;
    previousNative.current = { ownerId, tabId: activeTabId, scopeKey };
    if (!ownerId) return;
    const visibleTabs = tabs.filter((tab) => isIabTabVisible(tab, sessionGroupId));
    workspace.syncPages('iab', visibleTabs.map((tab) => browserPage(tab, workspace)));
    const visibleNative = visibleTabs.some((tab) => tab.id === activeTabId);
    const nextTabId = visibleNative ? activeTabId : visibleTabs[0]?.id;
    const selectedIab = workspace.pages.find((page) => page.id === workspace.activePageId)?.providerId === 'iab';
    if (nextTabId && (workspace.activePageId === null
      || (selectedIab && !visibleTabs.some((tab) => workspace.activePageId === iabPageId(ownerId, tab.id)))
      || (visibleNative && previous.scopeKey === scopeKey && previous.ownerId === ownerId && previous.tabId !== activeTabId && previous.tabId
        && workspace.activePageId === iabPageId(ownerId, previous.tabId) && visibleTabs.some((tab) => tab.id === previous.tabId)))) {
      workspace.activatePage(iabPageId(ownerId, nextTabId), { reveal: false });
    }
  });
  useEffect(() => { projectPages(); }, [isActive, ownerId, tabs, activeTabId, language.language, syncPages, scopeKey, sessionGroupId]);
  return null;
}

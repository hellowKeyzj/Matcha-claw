import { useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { useWorkspace } from '@/plugins/workspace/context';
import type { IabEvent } from '@/types/desktop/iab';
import { browserPage, iabPageId } from './browser-page';
import { iabCommand, onIabEvent, refreshIabSnapshot, reportIabError, useIabStore } from './store';

export function IabWorkspace({ isActive }: ChatWorkspaceContentProps) {
  const workspace = useWorkspace();
  const { i18n: language } = useTranslation('iab');
  const ownerId = useIabStore((state) => state.ownerId);
  const tabs = useIabStore((state) => state.tabs);
  const activeTabId = useIabStore((state) => state.activeTabId);
  const previousNative = useRef<{ ownerId: string | null; tabId: string | null }>({ ownerId: null, tabId: null });
  const { syncPages, scopeKey } = workspace;
  const showPage = useEffectEvent((event: Extract<IabEvent, { type: 'show-requested' }>) => {
    const current = useIabStore.getState();
    if (!isActive || current.ownerId !== event.ownerId) return;
    const tab = current.tabs.find((entry) => entry.id === event.tabId);
    if (tab) workspace.openPage(browserPage(tab, workspace));
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
    previousNative.current = { ownerId, tabId: activeTabId };
    if (!ownerId) return;
    workspace.syncPages('iab', tabs.map((tab) => browserPage(tab, workspace)));
    if (activeTabId && (workspace.activePageId === null || (previous.ownerId === ownerId && previous.tabId !== activeTabId && previous.tabId
      && workspace.activePageId === iabPageId(ownerId, previous.tabId) && tabs.some((tab) => tab.id === previous.tabId)))) {
      workspace.activatePage(iabPageId(ownerId, activeTabId), { reveal: false });
    }
  });
  useEffect(() => { projectPages(); }, [isActive, ownerId, tabs, activeTabId, language.language, syncPages, scopeKey]);
  return null;
}

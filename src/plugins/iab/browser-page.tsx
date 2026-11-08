import i18n from '@/i18n';
import type { WorkspaceController, WorkspacePage } from '@/plugins/workspace/extensions';
import type { IabTab } from '@/types/desktop/iab';
import { Favicon } from './Favicon';
import { IabToolLayer } from './IabToolLayer';
import { iabCommand, IabProjectionDiscarded, useIabStore } from './store';

export function iabPageId(ownerId: string, tabId: string) {
  return `iab:${ownerId}:${tabId}`;
}

export function browserPage(tab: IabTab, workspace: WorkspaceController): WorkspacePage {
  const id = iabPageId(tab.ownerId, tab.id);
  const previous = workspace.pages.find((page) => page.id === id);
  const title = tab.internalPage ? i18n.t(`iab:${tab.internalPage === 'downloads' ? 'downloadHistory' : 'history'}`)
    : tab.title.trim() && tab.title.trim() !== 'about:blank' ? tab.title.trim()
      : tab.url.trim() !== 'about:blank' ? tab.url.trim() : i18n.t('iab:newTab');
  if (previous) return previous.title === title ? previous : { ...previous, title };
  const icon: WorkspacePage['icon'] = (props) => <Favicon {...props} ownerId={tab.ownerId} tabId={tab.id} />;
  return {
    id, providerId: 'iab', icon, mount: 'active', promoteWithDraft: true, title,
    render: (props) => <IabToolLayer {...props} ownerId={tab.ownerId} tabId={tab.id} />,
    onSelect: async () => {
      const current = useIabStore.getState();
      if (current.ownerId !== tab.ownerId || !current.tabs.some((entry) => entry.id === tab.id && entry.ownerId === tab.ownerId)) throw new IabProjectionDiscarded();
      if (current.activeTabId !== tab.id) await iabCommand({ action: 'switch', tabId: tab.id });
    },
    onClose: async () => {
      const current = useIabStore.getState();
      if (current.ownerId !== tab.ownerId || !current.tabs.some((entry) => entry.id === tab.id && entry.ownerId === tab.ownerId)) throw new IabProjectionDiscarded();
      await iabCommand({ action: 'close', tabId: tab.id });
    },
  };
}

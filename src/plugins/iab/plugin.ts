import { Globe } from 'lucide-react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { buildIabDisplayScope, iabCommand, observeIabEvents, onIabEvent, reportIabError } from './store';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatWorkspaceContent, type ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { WORKSPACE_SESSION_PROMOTED_EVENT } from '@/plugins/workspace/actions';
import { workspaceLaunchers, type WorkspaceSessionPromotion } from '@/plugins/workspace/extensions';

const IabWorkspace = lazyWithPreload<ChatWorkspaceContentProps>(() => import('./workspace').then((module) => ({ default: module.IabWorkspace })));

export const iabPlugin = definePlugin({
  id: 'iab',
  requires: ['app-shell', 'chat', 'workspace'],
  contributes: [
    contribute(chatWorkspaceContent, { id: 'iab', order: 20, component: IabWorkspace }),
    contribute(workspaceLaunchers, { id: 'iab', order: 10, label: 'iab:browser', icon: Globe,
      execute: async (context) => {
        try {
          await iabCommand({ action: 'open', url: 'about:blank', displayScope: buildIabDisplayScope(context.workspace) });
        } catch (error) { reportIabError(error); }
      } }),
  ],
  activate() {
    const unsubscribe = observeIabEvents();
    const unsubscribeQuit = onIabEvent((event) => {
      if (event.type === 'quit-blocked') toast.error(i18n.t('iab:quitBlocked'), { id: 'iab-quit-blocked' });
    });
    const promote = (event: Event) => {
      const { fromScopeKey, draftId, toScopeKey } = (event as CustomEvent<WorkspaceSessionPromotion>).detail;
      void iabCommand({ action: 'promote-display-scope', from: JSON.stringify([fromScopeKey, draftId]), to: toScopeKey }).catch(reportIabError);
    };
    window.addEventListener(WORKSPACE_SESSION_PROMOTED_EVENT, promote);
    return () => { unsubscribe(); unsubscribeQuit(); window.removeEventListener(WORKSPACE_SESSION_PROMOTED_EVENT, promote); };
  },
});

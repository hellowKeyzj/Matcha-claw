import { Globe } from 'lucide-react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { observeIabEvents, onIabEvent } from './store';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatWorkspaceContent, type ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { workspaceLaunchers } from '@/plugins/workspace/extensions';

const IabWorkspace = lazyWithPreload<ChatWorkspaceContentProps>(() => import('./workspace').then((module) => ({ default: module.IabWorkspace })));

export const iabPlugin = definePlugin({
  id: 'iab',
  requires: ['app-shell', 'chat', 'workspace'],
  contributes: [
    contribute(chatWorkspaceContent, { id: 'iab', order: 20, component: IabWorkspace }),
    contribute(workspaceLaunchers, { id: 'iab', order: 10, label: 'iab:browser', icon: Globe,
      execute: async (context) => { const { openIabWorkspacePage } = await import('./browser-page'); await openIabWorkspacePage(context); } }),
  ],
  activate() {
    const unsubscribe = observeIabEvents();
    const unsubscribeQuit = onIabEvent((event) => {
      if (event.type === 'quit-blocked') toast.error(i18n.t('iab:quitBlocked'), { id: 'iab-quit-blocked' });
    });
    return () => { unsubscribe(); unsubscribeQuit(); };
  },
});

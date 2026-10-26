import { sidebarActions, sidebarFooter, sidebarPanels } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const NewChatAction = lazyWithPreload(() => import('./NewChatAction'));
const PendingBlockers = lazyWithPreload(() => import('./PendingBlockers'));
const DevConsoleFooter = lazyWithPreload(() => import('./DevConsoleFooter'));
const AccountFooter = lazyWithPreload(() => import('./AccountFooter'));

// Trusted sidebar composition; business state and mutations remain with their owners.
export const navigationPlugin = definePlugin({
  id: 'navigation',
  requires: ['app-shell'],
  contributes: [
    contribute(sidebarActions, { id: 'new-chat', order: 10, component: NewChatAction }),
    contribute(sidebarPanels, { id: 'pending-blockers', order: 10, component: PendingBlockers }),
    contribute(sidebarFooter, { id: 'dev-console', order: 10, component: DevConsoleFooter }),
    contribute(sidebarFooter, { id: 'account', order: 20, component: AccountFooter }),
  ],
});

import { ShieldCheck } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const AccessPage = lazyWithPreload(() => import('./page'));

export const accessPlugin = definePlugin({
  id: 'access',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationPages, { id: 'access', path: '/access', component: AccessPage, viewport: 'workspace', preload: AccessPage.preload }),
    contribute(applicationNavigation, { id: 'access', to: '/access', label: 'access:title', icon: ShieldCheck, order: 65, prefetch: AccessPage.preload }),
  ],
});

import { Home } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const DashboardPage = lazyWithPreload(() => import('./pages'));

export const dashboardPlugin = definePlugin({
  id: 'dashboard',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationPages, {
      id: 'dashboard',
      path: '/dashboard',
      component: DashboardPage,
      viewport: 'document',
      preload: DashboardPage.preload,
    }),
    contribute(applicationNavigation, {
      id: 'dashboard',
      to: '/dashboard',
      label: 'common:sidebar.dashboard',
      icon: Home,
      order: 80,
      prefetch: DashboardPage.preload,
    }),
  ],
});

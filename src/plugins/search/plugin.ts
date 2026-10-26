import { applicationSettings } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const NetworkSearchPage = lazyWithPreload(() => import('./pages'));

export const searchPlugin = definePlugin({
  id: 'search',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationSettings, {
      id: 'search',
      label: 'settings:networkSearch.title',
      order: 40,
      component: NetworkSearchPage,
      layout: 'workspace',
    }),
  ],
});

import { applicationSettings } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const CallsPage = lazyWithPreload(() => import('./pages'));

export const callsPlugin = definePlugin({
  id: 'calls',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationSettings, {
      id: 'calls',
      label: 'common:calls.title',
      order: 90,
      component: CallsPage,
    }),
  ],
});

import { Globe2 } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { WORLD_PAGES } from './navigation';

const WorldPage = lazyWithPreload(() => import('./pages'));

export const worldPlugin = definePlugin({
  id: 'world',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationPages, {
      id: 'world',
      path: '/world/*',
      component: WorldPage,
      viewport: 'workspace',
      preload: WorldPage.preload,
    }),
    contribute(applicationNavigation, {
      id: 'world',
      to: '/world',
      label: 'world:title',
      icon: Globe2,
      order: 70,
      children: WORLD_PAGES.map(({ path, key }) => ({ to: path, label: `world:${key}` })),
    }),
  ],
});

import { Box } from 'lucide-react';
import { applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { agentWorkbenchPages } from '@/plugins/agents/extensions';
import { nativePluginManagers } from './extensions';
import { matchaPluginManager, openClawPluginManager } from './managers';

const PluginsPage = lazyWithPreload(() => import('./page'));

export const nativePluginsPlugin = definePlugin({
  id: 'native-plugins',
  requires: ['app-shell', 'agents'],
  extensionPoints: [nativePluginManagers],
  contributes: [
    contribute(applicationPages, { id: 'native-plugins', path: '/plugins', component: PluginsPage, preload: PluginsPage.preload }),
    contribute(agentWorkbenchPages, {
      id: 'native-plugins', to: '/plugins', label: 'common:sidebar.plugins', icon: Box, order: 30,
      prefetch: () => import('./store').then(({ prefetchPluginsData }) => prefetchPluginsData()),
    }),
    contribute(nativePluginManagers, openClawPluginManager),
    contribute(nativePluginManagers, matchaPluginManager),
  ],
});

import { definePlugin } from '@/plugin-host/core';

export const applicationPluginsPlugin = definePlugin({
  id: 'application-plugins',
  requires: ['app-shell'],
});

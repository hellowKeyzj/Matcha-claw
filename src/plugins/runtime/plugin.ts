import { definePlugin } from '@/plugin-host/core';
import { subscribeGatewayState } from './store';

export const runtimePlugin = definePlugin({
  id: 'runtime',
  requires: ['app-shell'],
  activate: subscribeGatewayState,
});

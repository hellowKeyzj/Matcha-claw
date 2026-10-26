import { Radio } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { channelPresentations } from './extensions';
import { builtinChannelPresentations } from './presentations';
import { subscribeChannelHostEvents } from './host-observation';

const ChannelsPage = lazyWithPreload(() => import('./page'));

export const channelsPlugin = definePlugin({
  id: 'channels',
  requires: ['app-shell'],
  extensionPoints: [channelPresentations],
  contributes: [
    contribute(applicationPages, { id: 'channels', path: '/channels', component: ChannelsPage, preload: ChannelsPage.preload }),
    contribute(applicationNavigation, { id: 'channels', to: '/channels', label: 'common:sidebar.channels', icon: Radio, order: 50 }),
    ...builtinChannelPresentations.map((presentation) => contribute(channelPresentations, presentation)),
  ],
  activate: subscribeChannelHostEvents,
});

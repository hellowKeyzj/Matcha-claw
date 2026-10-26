import { applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { fleetRegistrationTargets } from './extensions';
import {
  containerRegistrationTarget,
  customRegistrationTarget,
  k8sRegistrationTarget,
  sshRegistrationTarget,
  vmRegistrationTarget,
} from './registration/targets';

const FleetPage = lazyWithPreload(() => import('./page'));

export const fleetPlugin = definePlugin({
  id: 'fleet',
  requires: ['app-shell'],
  extensionPoints: [fleetRegistrationTargets],
  contributes: [
    contribute(applicationPages, {
      id: 'fleet',
      path: '/remote-fleet',
      component: FleetPage,
      viewport: 'document',
      preload: FleetPage.preload,
    }),
    contribute(fleetRegistrationTargets, sshRegistrationTarget),
    contribute(fleetRegistrationTargets, containerRegistrationTarget),
    contribute(fleetRegistrationTargets, k8sRegistrationTarget),
    contribute(fleetRegistrationTargets, customRegistrationTarget),
    contribute(fleetRegistrationTargets, vmRegistrationTarget),
  ],
});

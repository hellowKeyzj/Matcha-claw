import { KeyRound } from 'lucide-react';
import { applicationLifecycle, applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { providerContributions } from './contributions';
import { providerAuthMethods, providerForms, providerModelSources, providerVendors } from './extensions';

const ProvidersPage = lazyWithPreload(async () => ({ default: (await import('./page')).ProvidersPage }));
const ProvidersLifecycle = lazyWithPreload(async () => ({ default: (await import('./lifecycle')).ProvidersLifecycle }));

export const providersPlugin = definePlugin({
  id: 'providers',
  requires: ['app-shell'],
  extensionPoints: [providerVendors, providerAuthMethods, providerForms, providerModelSources],
  contributes: [
    ...providerContributions,
    contribute(applicationPages, { id: 'providers', path: '/providers', component: ProvidersPage, preload: ProvidersPage.preload }),
    contribute(applicationNavigation, { id: 'providers', to: '/providers', label: 'settings:aiProviders.title', icon: KeyRound, order: 40, prefetch: ProvidersPage.preload }),
    contribute(applicationLifecycle, { id: 'providers', order: 40, component: ProvidersLifecycle }),
  ],
});

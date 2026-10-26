import { lazy } from 'react';
import { applicationLifecycle, applicationPages, applicationSettings } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const SettingsPage = lazyWithPreload(() => import('./page'));
const GatewaySection = lazy(() => import('./gateway/GatewaySection'));
const AppearanceSection = lazy(() => import('./AppearanceSection'));
const BrowserSection = lazy(() => import('./BrowserSection'));
const UpdatesSection = lazy(() => import('./update/UpdatesSection'));
const AdvancedSection = lazy(() => import('./AdvancedSection'));
const DiagnosticsSection = lazy(() => import('./DiagnosticsSection'));
const SettingsLifecycle = lazy(() => import('./lifecycle').then((module) => ({ default: module.SettingsLifecycle })));
const UpdateLifecycle = lazy(() => import('./lifecycle').then((module) => ({ default: module.UpdateLifecycle })));

export const settingsPlugin = definePlugin({
  id: 'settings',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationPages, { id: 'settings', path: '/settings/*', component: SettingsPage, preload: SettingsPage.preload }),
    // State and page-lifetime observations survive section switches, not route exits.
    contribute(applicationSettings, { id: 'gateway', label: 'settings:gateway.runtimeTitle', order: 10, component: GatewaySection, keepMounted: true }),
    contribute(applicationSettings, { id: 'appearance', label: 'settings:appearance.title', order: 20, component: AppearanceSection, keepMounted: true }),
    contribute(applicationSettings, { id: 'browser', label: 'settings:gateway.browser.title', order: 30, component: BrowserSection, keepMounted: true }),
    contribute(applicationSettings, { id: 'updates', label: 'settings:updates.title', order: 50, component: UpdatesSection }),
    contribute(applicationSettings, { id: 'advanced', label: 'settings:advanced.title', order: 60, component: AdvancedSection, keepMounted: true }),
    contribute(applicationSettings, { id: 'diagnostics', label: 'settings:diagnostics.title', order: 80, component: DiagnosticsSection, keepMounted: true }),
    contribute(applicationLifecycle, { id: 'settings-initialize', order: 20, component: SettingsLifecycle }),
    contribute(applicationLifecycle, { id: 'settings-update', order: 30, component: UpdateLifecycle }),
  ],
});

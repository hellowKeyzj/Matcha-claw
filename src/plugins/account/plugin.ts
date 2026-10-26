import { applicationLifecycle, applicationSettings } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';

const LicenseSection = lazyWithPreload(async () => ({ default: (await import('./settings/LicenseSection')).LicenseSection }));
const AccountLifecycle = lazyWithPreload(async () => ({ default: (await import('./lifecycle')).AccountLifecycle }));

export const accountPlugin = definePlugin({
  id: 'account',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationSettings, {
      id: 'license',
      label: 'settings:license.title',
      order: 70,
      component: LicenseSection,
    }),
    contribute(applicationLifecycle, {
      id: 'account',
      order: 10,
      component: AccountLifecycle,
    }),
  ],
});

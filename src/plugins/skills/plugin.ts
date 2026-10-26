import { createElement } from 'react';
import { Puzzle } from 'lucide-react';
import { applicationPages } from '@/app/extensions';
import { agentWorkbenchPages } from '@/plugins/agents/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { skillSources, skillTransfers, type SkillOwnerProps } from './extensions';
import { observeSkillCloudAccount } from './stores/sealed-skills';

const SkillsPage = lazyWithPreload(async () => {
  const [page] = await Promise.all([
    import('./page'),
    import('./sources/installed'),
    import('./sources/sealed-installed'),
    import('./sources/clawhub'),
    import('./transfers/plain'),
    import('./transfers/sealed'),
  ]);
  return page;
});
const InstalledOwner = lazyWithPreload(async () => ({ default: (await import('./sources/installed')).InstalledOwner }));
const InstalledSkillsView = lazyWithPreload(async () => ({ default: (await import('./sources/installed')).InstalledSkillsView }));
const InstalledToolbar = lazyWithPreload(async () => ({ default: (await import('./sources/installed')).InstalledToolbar }));
const InstalledHeaderActions = lazyWithPreload(async () => ({ default: (await import('./sources/installed')).InstalledHeaderActions }));
const InstalledBadge = lazyWithPreload(async () => ({ default: (await import('./sources/installed')).InstalledBadge }));
const SealedInstalledOwner = lazyWithPreload(async () => ({ default: (await import('./sources/sealed-installed')).SealedInstalledOwner }));
const SealedInstalledView = lazyWithPreload(async () => ({ default: (await import('./sources/sealed-installed')).SealedInstalledView }));
const SealedInstalledToolbar = lazyWithPreload(async () => ({ default: (await import('./sources/sealed-installed')).SealedInstalledToolbar }));
const SealedInstalledHeaderActions = lazyWithPreload(async () => ({ default: (await import('./sources/sealed-installed')).SealedInstalledHeaderActions }));
const CloudMineView = lazyWithPreload(async () => ({ default: (await import('./sources/cloud')).CloudMineView }));
const CloudMarketView = lazyWithPreload(async () => ({ default: (await import('./sources/cloud')).CloudMarketView }));
const CloudMineToolbar = lazyWithPreload(async () => ({ default: (await import('./sources/cloud')).CloudMineToolbar }));
const CloudMarketToolbar = lazyWithPreload(async () => ({ default: (await import('./sources/cloud')).CloudMarketToolbar }));
const CloudMineHeaderActions = lazyWithPreload(async () => ({ default: (await import('./sources/cloud')).CloudMineHeaderActions }));
const CloudMarketHeaderActions = lazyWithPreload(async () => ({ default: (await import('./sources/cloud')).CloudMarketHeaderActions }));
const ClawHubOwner = lazyWithPreload(async () => ({ default: (await import('./sources/clawhub')).ClawHubOwner }));
const ClawHubView = lazyWithPreload(async () => ({ default: (await import('./sources/clawhub')).ClawHubView }));
const ClawHubToolbar = lazyWithPreload(async () => ({ default: (await import('./sources/clawhub')).ClawHubToolbar }));
const ClawHubHeaderActions = lazyWithPreload(async () => ({ default: (await import('./sources/clawhub')).ClawHubHeaderActions }));
const PlainTransferOwner = lazyWithPreload(async () => ({ default: (await import('./transfers/plain')).PlainTransferOwner }));
const PlainImportEntry = lazyWithPreload(async () => ({ default: (await import('./transfers/plain')).PlainImportEntry }));
const SealedTransferOwner = lazyWithPreload(async () => ({ default: (await import('./transfers/sealed')).SealedTransferOwner }));
const SealedTransferEntries = lazyWithPreload(async () => ({ default: (await import('./transfers/sealed')).SealedTransferEntries }));
const SealedUploadMenuItem = lazyWithPreload(async () => ({ default: (await import('./transfers/sealed')).SealedUploadMenuItem }));

function LocalSourceOwner(props: SkillOwnerProps) {
  return createElement(InstalledOwner, props, createElement(SealedInstalledOwner, props));
}

export const skillsPlugin = definePlugin({
  id: 'skills',
  requires: ['app-shell', 'agents'],
  extensionPoints: [skillSources, skillTransfers],
  activate: observeSkillCloudAccount,
  contributes: [
    contribute(applicationPages, { id: 'skills', path: '/skills', component: SkillsPage, preload: SkillsPage.preload }),
    contribute(agentWorkbenchPages, {
      id: 'skills', to: '/skills', label: 'common:sidebar.skills', icon: Puzzle, order: 20,
      prefetch: async () => (await import('./prefetch')).prefetchSkills(),
    }),
    contribute(skillSources, {
      id: 'local',
      owner: LocalSourceOwner,
      views: [
        { id: 'all', area: 'main', label: 'tabs.installed', order: 10, component: InstalledSkillsView, toolbar: InstalledToolbar, headerActions: InstalledHeaderActions, badge: InstalledBadge },
        { id: 'installed', area: 'packages', label: 'sealed.tabs.installed', order: 10, component: SealedInstalledView, toolbar: SealedInstalledToolbar, headerActions: SealedInstalledHeaderActions },
      ],
    }),
    contribute(skillSources, {
      id: 'cloud',
      views: [
        { id: 'mine', area: 'packages', label: 'sealed.tabs.mine', order: 20, component: CloudMineView, toolbar: CloudMineToolbar, headerActions: CloudMineHeaderActions },
        { id: 'market', area: 'packages', label: 'sealed.tabs.market', order: 30, component: CloudMarketView, toolbar: CloudMarketToolbar, headerActions: CloudMarketHeaderActions },
      ],
    }),
    contribute(skillSources, {
      id: 'clawhub',
      owner: ClawHubOwner,
      views: [
        { id: 'marketplace', area: 'main', label: 'tabs.marketplace', order: 30, component: ClawHubView, toolbar: ClawHubToolbar, headerActions: ClawHubHeaderActions },
      ],
    }),
    contribute(skillTransfers, {
      id: 'plain',
      owner: PlainTransferOwner,
      toolbarEntries: [{ viewId: 'marketplace', component: PlainImportEntry }],
    }),
    contribute(skillTransfers, {
      id: 'sealed',
      owner: SealedTransferOwner,
      toolbarEntries: [{ viewId: 'installed', component: SealedTransferEntries }],
      packageMenuItems: SealedUploadMenuItem,
    }),
  ],
});

import { Cast, TakeNotes } from '@serenity-js/core';
import { test as serenityTest } from '@serenity-js/playwright-test';
import { join } from 'node:path';
import { profileMode } from '../config/electron.js';
import { UseElectron } from '../abilities/use-electron.ability.js';
import { UseChat } from '../abilities/use-chat.ability.js';
import { UseSessionCapabilities } from '../abilities/use-session-capabilities.ability.js';
import { ExternalConnectors } from '../abilities/external-connectors.ability.js';
import { ProviderValidation } from '../abilities/provider-validation.ability.js';
import { SessionCatalog } from '../abilities/session-catalog.ability.js';
import { SessionLifecycle } from '../abilities/session-lifecycle.ability.js';
import { UseSecurityPolicy } from '../abilities/security-policy.ability.js';
import { TasksLifecycle } from '../abilities/tasks-lifecycle.ability.js';
import { UseMatchaHistory } from '../abilities/matcha-history.ability.js';
import { TeamLifecycle } from '../abilities/team-lifecycle.ability.js';
import { UseTeamBoundaries } from '../abilities/team-boundaries.ability.js';
import { Subagents } from '../abilities/subagents.ability.js';
import { ScheduledTasks } from '../abilities/scheduled-tasks.ability.js';
import { Channels } from '../abilities/channels.ability.js';
import { ChannelControl } from '../abilities/channel-control.ability.js';
import { DiagnosticsArchive } from '../abilities/diagnostics-archive.ability.js';
import { UseProxy } from '../abilities/proxy.ability.js';
import { WorldAuthoring } from '../abilities/world-authoring.ability.js';
import { WorldWorkspace } from '../abilities/world-workspace.ability.js';
import { WorldEvaluation } from '../abilities/world-evaluation.ability.js';
import { WorldCompilation } from '../abilities/world-compilation.ability.js';
import { WorldMaterials } from '../abilities/world-materials.ability.js';
import { WorldOrderEvaluation } from '../abilities/world-order-evaluation.ability.js';
import { WorldPackageSetup } from '../abilities/world-package-setup.ability.js';
import { WorldOrderSetup } from '../abilities/world-order-setup.ability.js';
import { WorldOrderAccess } from '../abilities/world-order-access.ability.js';
import { WorldSources } from '../abilities/world-sources.ability.js';
import { WorldActions } from '../abilities/world-actions.ability.js';
import { WorldViews } from '../abilities/world-views.ability.js';
import { WorldRules } from '../abilities/world-rules.ability.js';
import { WorldPackageTrust } from '../abilities/world-package-trust.ability.js';
import { WorldMaterialsSetup } from '../abilities/world-materials-setup.ability.js';
import { WorldStorage } from '../abilities/world-storage.ability.js';
import { WorldArchive } from '../abilities/world-archive.ability.js';
import { IabTestSite } from '../abilities/iab-test-site.ability.js';
import { IabBrowserTools } from '../abilities/iab-browser-tools.ability.js';
import { IabDesktop } from '../abilities/iab-desktop.ability.js';
import { IabBrowser } from '../abilities/iab-browser.ability.js';
import { IabAgent } from '../abilities/iab-agent.ability.js';
import { IabWorkspace } from '../abilities/iab-workspace.ability.js';
import { IabWorkspaceRaces } from '../abilities/iab-workspace-races.ability.js';

type ElectronWorkerFixtures = { sharedElectron: UseElectron };
type ElectronTestFixtures = { electronEvidence: void };

export const test = serenityTest.extend<ElectronTestFixtures, ElectronWorkerFixtures>({
  sharedElectron: [async ({}, use, info) => {
    if (info.config.workers !== 1 || info.config.fullyParallel || info.config.maxFailures !== 1
      || info.config.projects.length !== 1 || info.project.retries !== 0 || info.project.repeatEach !== 1) {
      throw new Error('Shared Electron E2E requires one project, workers=1, fullyParallel=false, retries=0, repeatEach=1, maxFailures=1');
    }
    const owner = await UseElectron.start(join(info.project.outputDir, `shared-electron-${info.workerIndex}`));
    let primaryFailure: unknown;
    try {
      if (profileMode === 'licensed') {
        await owner.enterLocalApp();
        await new UseSessionCapabilities(owner).waitForSessionCatalog(180_000);
      }
      await use(owner);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
        await owner.close();
      } catch (cleanupFailure) {
        throw new AggregateError(primaryFailure === undefined ? [cleanupFailure] : [primaryFailure, cleanupFailure],
          'Shared Electron cleanup failed; the original setup or execution failure is retained');
      }
    }
  }, { scope: 'worker', timeout: 270_000 }],

  browser: [async ({ sharedElectron }, use) => {
    try {
      await use(await sharedElectron.connectBrowser());
    } finally {
      await sharedElectron.disconnectBrowser();
    }
  }, { scope: 'worker' }],

  actors: async ({ sharedElectron }, use) => {
    const iabSite = new IabTestSite(sharedElectron.outputDirectory, sharedElectron.profileRoot);
    const iabTools = new IabBrowserTools(sharedElectron);
    const iabDesktop = new IabDesktop(sharedElectron);
    try {
      await use(Cast.where(actor => actor.whoCan(
      sharedElectron, sharedElectron.browsing,
      new UseChat(sharedElectron), new UseSessionCapabilities(sharedElectron),
      new ExternalConnectors(sharedElectron), new ProviderValidation(sharedElectron),
      new SessionCatalog(sharedElectron), new SessionLifecycle(sharedElectron),
      new UseSecurityPolicy(sharedElectron), new TasksLifecycle(sharedElectron), new UseMatchaHistory(sharedElectron),
      new TeamLifecycle(sharedElectron), new UseTeamBoundaries(sharedElectron), new Subagents(sharedElectron),
      new ScheduledTasks(sharedElectron), new Channels(sharedElectron), new ChannelControl(sharedElectron),
      new DiagnosticsArchive(sharedElectron), new UseProxy(sharedElectron), new WorldAuthoring(sharedElectron),
      new WorldWorkspace(sharedElectron), new WorldEvaluation(sharedElectron), new WorldCompilation(sharedElectron),
      new WorldMaterials(sharedElectron), new WorldOrderEvaluation(sharedElectron),
      new WorldPackageSetup(sharedElectron), new WorldOrderSetup(sharedElectron), new WorldOrderAccess(sharedElectron),
      new WorldSources(sharedElectron), new WorldActions(sharedElectron), new WorldViews(sharedElectron),
      new WorldRules(sharedElectron), new WorldPackageTrust(sharedElectron), new WorldMaterialsSetup(sharedElectron),
      new WorldStorage(sharedElectron), new WorldArchive(sharedElectron),
      iabSite, iabTools, iabDesktop, new IabBrowser(sharedElectron, iabSite, iabTools, iabDesktop), new IabAgent(sharedElectron, iabSite),
      new IabWorkspace(sharedElectron, iabSite, iabTools, iabDesktop),
      new IabWorkspaceRaces(sharedElectron, iabSite, iabTools, iabDesktop),
      TakeNotes.usingAnEmptyNotepad(),
      )));
    } finally {
      await iabSite.close();
    }
  },

  electronEvidence: [async ({ sharedElectron }, use, info) => {
    await sharedElectron.beginScenario(info);
    try {
      await use();
    } finally {
      await sharedElectron.endScenario(info);
    }
  }, { auto: true }],
});

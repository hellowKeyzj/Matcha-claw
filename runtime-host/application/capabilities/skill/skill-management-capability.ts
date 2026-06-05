import type { ClawHubService } from '../../skills/clawhub';
import type { SkillsService } from '../../skills/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const SKILL_MANAGEMENT_CAPABILITY_ID = 'skill.management';

export const skillManagementCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'skills.updateConfig', title: 'Update skill configuration' },
  { id: 'skills.updateState', title: 'Update skill state' },
  { id: 'skills.updateBatchState', title: 'Update skill state batch' },
  { id: 'skills.importLocal', title: 'Import local skill' },
  { id: 'skills.exportBundles', title: 'Export skill bundles' },
  { id: 'skills.importBundles', title: 'Import skill bundles' },
  { id: 'skills.refreshStatus', title: 'Refresh skill status' },
  { id: 'clawhub.login', title: 'Log in to ClawHub' },
  { id: 'clawhub.openReadme', title: 'Open ClawHub skill readme' },
  { id: 'clawhub.openPath', title: 'Open ClawHub skill path' },
  { id: 'clawhub.install', title: 'Install ClawHub skill' },
  { id: 'clawhub.uninstall', title: 'Uninstall ClawHub skill' },
] as const;

export function createSkillManagementCapabilityOperationRoutes(deps: {
  skillsService: Pick<SkillsService, 'updateConfig' | 'updateState' | 'updateBatchState' | 'importLocal' | 'exportBundles' | 'importBundles' | 'refreshStatus'>;
  clawHubService: Pick<ClawHubService, 'login' | 'openReadme' | 'openPath' | 'install' | 'uninstall'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.updateConfig',
      handle: (context) => deps.skillsService.updateConfig(context.domainInput),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.updateState',
      handle: (context) => deps.skillsService.updateState(context.domainInput),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.updateBatchState',
      handle: (context) => deps.skillsService.updateBatchState(context.domainInput),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.importLocal',
      handle: (context) => deps.skillsService.importLocal(context.domainInput),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.exportBundles',
      handle: async (context) => ({
        status: 200,
        data: await deps.skillsService.exportBundles(context.domainInput),
      }),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.importBundles',
      handle: (context) => deps.skillsService.importBundles(context.domainInput),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'skills.refreshStatus',
      handle: async () => ({
        status: 200,
        data: await deps.skillsService.refreshStatus(),
      }),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'clawhub.login',
      handle: async () => ({
        status: 200,
        data: await deps.clawHubService.login(),
      }),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'clawhub.openReadme',
      handle: async (context) => {
        const locator = readSkillLocator(context.domainInput);
        return {
          status: 200,
          data: await deps.clawHubService.openReadme(locator.skillKeyOrSlug, locator.slug, locator.baseDir),
        };
      },
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'clawhub.openPath',
      handle: async (context) => {
        const locator = readSkillLocator(context.domainInput);
        return {
          status: 200,
          data: await deps.clawHubService.openPath(locator.skillKeyOrSlug, locator.slug, locator.baseDir),
        };
      },
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'clawhub.install',
      handle: (context) => ({
        status: 202,
        data: deps.clawHubService.install(context.domainInput),
      }),
    },
    {
      capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId: 'clawhub.uninstall',
      handle: (context) => ({
        status: 202,
        data: deps.clawHubService.uninstall(context.domainInput),
      }),
    },
  ];
}

function readSkillLocator(payload: Record<string, unknown>): {
  readonly skillKeyOrSlug: string;
  readonly slug?: string;
  readonly baseDir?: string;
} {
  const slug = typeof payload.slug === 'string' ? payload.slug : undefined;
  return {
    skillKeyOrSlug: typeof payload.skillKey === 'string' ? payload.skillKey : (slug ?? ''),
    ...(slug ? { slug } : {}),
    ...(typeof payload.baseDir === 'string' ? { baseDir: payload.baseDir } : {}),
  };
}


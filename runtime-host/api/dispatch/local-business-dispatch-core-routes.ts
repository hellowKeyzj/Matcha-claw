import { PROVIDER_VENDOR_DEFINITIONS } from '../../application/providers/provider-registry';
import { handleChannelRoute } from '../routes/channel-routes';
import { handleCronAndUsageRoute } from '../routes/cron-routes';
import { handleLicenseRoute } from '../routes/license-routes';
import { handleOpenClawRoute } from '../routes/openclaw-routes';
import { handleProviderRoute } from '../routes/provider-routes';
import { handleRuntimeHostRoute } from '../routes/runtime-host-routes';
import { handleSettingsRoute } from '../routes/settings-routes';
import { handleSkillsRoute } from '../routes/skills-routes';
import {
  SubagentTemplateService,
} from '../../application/openclaw/templates';
import { handleWorkbenchRoute } from '../routes/workbench-routes';
import {
  getOpenClawConfigDir,
  getOpenClawDirPath,
  getOpenClawStatus,
  readOpenClawConfigJson,
} from '../storage/paths';
import {
  accountToStatusLocal,
  normalizeProviderAccountLocal,
  normalizeProviderFallbackAccountLocal,
  sortProviderAccountsLocal,
  validateProviderApiKeyLocal,
} from '../../application/providers/account-runtime';
import {
  deleteChannelConfigLocal as deleteOpenClawChannelConfigLocal,
  getChannelFormValuesLocal as getOpenClawChannelFormValuesLocal,
  listConfiguredChannelsLocal as listOpenClawConfiguredChannelsLocal,
  saveChannelConfigLocal as saveOpenClawChannelConfigLocal,
  setChannelEnabledLocal as setOpenClawChannelEnabledLocal,
  validateChannelConfigLocal as validateOpenClawChannelConfigLocal,
  validateChannelCredentialsLocal as validateOpenClawChannelCredentialsLocal,
} from '../../application/channels/channel-runtime';
import {
  buildProviderEnvMap,
  syncGatewayConfigLocal,
  syncProviderAuthBootstrapLocal,
} from '../../application/runtime-host/bootstrap';
import { syncProxyConfigToOpenClaw } from '../../application/openclaw/openclaw-proxy-sync';
import { syncBrowserModeToOpenClaw } from '../../application/openclaw/openclaw-provider-config-service';
import { collectDiagnosticsBundleLocal } from '../../application/support/diagnostics';
import { completeBrowserOAuthLocal, completeDeviceOAuthLocal } from '../../application/providers/oauth-runtime';
import { readProviderStoreLocal, writeProviderStoreLocal } from '../storage/provider-store';
import {
  getAllSettingsLocal,
  resetSettingsLocal,
  setSettingValueLocal,
  setSettingsPatchLocal,
} from '../../application/settings/store';
import {
  getAllSkillConfigsLocal,
  listEffectiveSkillsLocal,
  updateSkillConfigLocal,
} from '../../application/skills/store';
import type {
  LocalBusinessDispatchContext,
  LocalBusinessHandlerEntry,
} from './local-business-dispatch-types';

export function createCoreLocalBusinessHandlers(
  context: LocalBusinessDispatchContext,
): LocalBusinessHandlerEntry[] {
  const subagentTemplates = new SubagentTemplateService();
  return [
    {
      key: 'workbench',
      handle: (request) => handleWorkbenchRoute(request.method, request.routePath, {
        buildLocalRuntimeState: context.buildLocalRuntimeState,
      }),
    },
    {
      key: 'runtime_host',
      handle: async (request) => await handleRuntimeHostRoute(request.method, request.routePath, request.payload, {
        createHealthPayload: () => {
          const state = context.buildLocalRuntimeState();
          return {
            success: true,
            state,
            health: context.buildLocalRuntimeHealth(state),
          };
        },
        buildTransportStatsSnapshot: () => ({
          success: true,
          generatedAt: Date.now(),
          stats: context.buildTransportStatsSnapshot(),
        }),
        syncGatewayConfigLocal,
        buildProviderEnvMap,
        syncProviderAuthBootstrapLocal,
        collectDiagnosticsBundleLocal,
      }),
    },
    {
      key: 'cron_usage',
      handle: (request) => handleCronAndUsageRoute(request.method, request.routePath, request.routeUrl, request.payload, {
        openclawBridge: context.openclawBridge,
      }),
    },
    {
      key: 'license',
      handle: (request) => handleLicenseRoute(request.method, request.routePath, request.payload, {
        requestParentShellAction: context.requestParentShellAction,
        mapParentTransportResponse: context.mapParentTransportResponse,
      }),
    },
    {
      key: 'settings',
      handle: (request) => handleSettingsRoute(request.method, request.routePath, request.payload, {
        getAllSettingsLocal,
        setSettingsPatchLocal,
        resetSettingsLocal,
        setSettingValueLocal,
        syncProxyConfigToOpenClaw,
        syncBrowserModeToOpenClaw,
        requestParentShellAction: context.requestParentShellAction,
      }),
    },
    {
      key: 'provider',
      handle: (request) => handleProviderRoute(request.method, request.routePath, request.routeUrl, request.payload, {
        readProviderStoreLocal,
        writeProviderStoreLocal,
        sortProviderAccountsLocal,
        accountToStatusLocal,
        normalizeProviderAccountLocal,
        normalizeProviderFallbackAccountLocal,
        validateProviderApiKeyLocal,
        requestParentShellAction: context.requestParentShellAction,
        mapParentTransportResponse: context.mapParentTransportResponse,
        providerVendorDefinitions: PROVIDER_VENDOR_DEFINITIONS,
        completeBrowserOAuthLocal,
        completeDeviceOAuthLocal,
      }),
    },
    {
      key: 'channel',
      handle: (request) => handleChannelRoute(request.method, request.routePath, request.routeUrl, request.payload, {
        openclawBridge: context.openclawBridge,
        listConfiguredChannelsLocal: listOpenClawConfiguredChannelsLocal,
        validateChannelConfigLocal: validateOpenClawChannelConfigLocal,
        validateChannelCredentialsLocal: validateOpenClawChannelCredentialsLocal,
        requestParentShellAction: context.requestParentShellAction,
        mapParentTransportResponse: context.mapParentTransportResponse,
        saveChannelConfigLocal: saveOpenClawChannelConfigLocal,
        setChannelEnabledLocal: setOpenClawChannelEnabledLocal,
        getChannelFormValuesLocal: getOpenClawChannelFormValuesLocal,
        deleteChannelConfigLocal: deleteOpenClawChannelConfigLocal,
      }),
    },
    {
      key: 'openclaw',
      handle: (request) => handleOpenClawRoute(request.method, request.routePath, {
        readOpenClawConfigJson,
        getOpenClawStatus,
        getOpenClawDirPath,
        getOpenClawConfigDir,
        getSubagentTemplateCatalogFromSources: () => subagentTemplates.listCatalog(),
        getSubagentTemplateFromSources: (templateId) => subagentTemplates.getTemplate(templateId),
      }),
    },
    {
      key: 'skills',
      handle: (request) => handleSkillsRoute(request.method, request.routePath, request.payload, {
        getAllSkillConfigsLocal,
        updateSkillConfigLocal,
        listEffectiveSkillsLocal,
      }),
    },
  ];
}

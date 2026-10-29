import { createPluginHost } from '@/plugin-host/core';
import { observeInstalledAppPlugins } from '@/plugins/application-plugins/installed';
import { applicationPluginsPlugin } from '@/plugins/application-plugins/plugin';
import { applicationShellPlugin } from './extensions';
import { runtimePlugin } from '@/plugins/runtime/plugin';
import { accountPlugin } from '@/plugins/account/plugin';
import { settingsPlugin } from '@/plugins/settings/plugin';
import { navigationPlugin } from '@/plugins/navigation/plugin';
import { chatPlugin } from '@/plugins/chat/plugin';
import { messageRenderingPlugin } from '@/plugins/message-rendering/plugin';
import { filesPlugin, createInstalledReaderPlugin } from '@/plugins/files/plugin';
import { surfacesPlugin } from '@/plugins/surfaces/plugin';
import { providersPlugin } from '@/plugins/providers/plugin';
import { channelsPlugin } from '@/plugins/channels/plugin';
import { connectorsPlugin, createInstalledConnectorPlugin } from '@/plugins/connectors/plugin';
import { agentsPlugin } from '@/plugins/agents/plugin';
import { skillsPlugin } from '@/plugins/skills/plugin';
import { nativePluginsPlugin } from '@/plugins/native-plugins/plugin';
import { teamsPlugin } from '@/plugins/teams/plugin';
import { tasksPlugin } from '@/plugins/tasks/plugin';
import { wikiPlugin } from '@/plugins/wiki/plugin';
import { worldPlugin } from '@/plugins/world/plugin';
import { fleetPlugin } from '@/plugins/fleet/plugin';
import { securityPlugin } from '@/plugins/security/plugin';
import { dashboardPlugin } from '@/plugins/dashboard/plugin';
import { callsPlugin } from '@/plugins/calls/plugin';
import { searchPlugin } from '@/plugins/search/plugin';

export const applicationPluginsHost = createPluginHost([
  applicationShellPlugin,
  applicationPluginsPlugin,
  runtimePlugin,
  accountPlugin,
  settingsPlugin,
  navigationPlugin,
  filesPlugin,
  messageRenderingPlugin,
  surfacesPlugin,
  providersPlugin,
  agentsPlugin,
  skillsPlugin,
  nativePluginsPlugin,
  connectorsPlugin,
  channelsPlugin,
  chatPlugin,
  teamsPlugin,
  tasksPlugin,
  wikiPlugin,
  worldPlugin,
  fleetPlugin,
  securityPlugin,
  dashboardPlugin,
  callsPlugin,
  searchPlugin,
]);

export function observeApplicationPluginPackages(): () => void {
  return observeInstalledAppPlugins(applicationPluginsHost, (record) => {
    const reader = createInstalledReaderPlugin(record);
    const connector = createInstalledConnectorPlugin(record);
    return {
      id: `installed:${record.manifest.id}`,
      requires: [...(reader.requires ?? []), ...(connector.requires ?? [])],
      contributes: [...(reader.contributes ?? []), ...(connector.contributes ?? [])],
    };
  });
}

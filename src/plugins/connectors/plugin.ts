import { lazy } from 'react';
import { Cable } from 'lucide-react';
import { applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload, type ApplicationPlugin } from '@/plugin-host/core';
import { appConnectorSourceId, type InstalledAppPlugin } from '@/types/desktop/app-plugin';
import { agentWorkbenchPages } from '@/plugins/agents/extensions';
import { chatComposerActions, type ChatComposerPanelProps } from '@/plugins/chat/extensions';
import { connectorForms } from './extensions';
import { httpForm, mcpHttpForm, mcpStdioForm, processForm, sdkForm } from './form';

const ConnectorsPage = lazyWithPreload(() => import('./page'));
const SessionStatusPanel = lazyWithPreload<ChatComposerPanelProps>(() => import('./session-status-panel').then((module) => ({ default: module.SessionStatusPanel })));
const McpStdioFields = lazy(() => import('./transport-fields').then((module) => ({ default: module.McpStdioFields })));
const McpHttpFields = lazy(() => import('./transport-fields').then((module) => ({ default: module.McpHttpFields })));
const CliFields = lazy(() => import('./transport-fields').then((module) => ({ default: module.ProcessFields })));
const SdkFields = lazy(() => import('./transport-fields').then((module) => ({ default: module.SdkFields })));
const HttpFields = lazy(() => import('./transport-fields').then((module) => ({ default: module.HttpFields })));

export const connectorsPlugin = definePlugin({
  id: 'connectors',
  requires: ['app-shell', 'agents', 'chat'],
  extensionPoints: [connectorForms],
  contributes: [
    contribute(applicationPages, {
      id: 'connectors', path: '/connectors', component: ConnectorsPage, preload: ConnectorsPage.preload,
    }),
    contribute(agentWorkbenchPages, {
      id: 'connectors', to: '/connectors', label: 'common:sidebar.connectors', icon: Cable, order: 40,
    }),
    contribute(chatComposerActions, {
      id: 'connectors', order: 50, icon: Cable, control: 'connectors', panel: SessionStatusPanel,
      resolve: ({ t, disabled, sessionIdentity }) => ({ label: t('input.connectors'), disabled: disabled || !sessionIdentity }),
      execute: ({ openPanel }) => openPanel('connectors'),
    }),
    contribute(connectorForms, {
      id: 'mcp-stdio', kind: 'mcp-stdio', privateFields: ['command', 'args', 'cwd', 'env'], component: McpStdioFields, ...mcpStdioForm,
    }),
    contribute(connectorForms, {
      id: 'mcp-http', kind: 'mcp-http', privateFields: ['headers'], component: McpHttpFields, ...mcpHttpForm,
    }),
    contribute(connectorForms, {
      id: 'cli', kind: 'cli', privateFields: ['command', 'args', 'cwd', 'env'], component: CliFields, ...processForm,
    }),
    contribute(connectorForms, {
      id: 'sdk', kind: 'sdk', privateFields: ['config'], component: SdkFields, ...sdkForm,
    }),
    contribute(connectorForms, {
      id: 'http', kind: 'http', privateFields: ['headers'], component: HttpFields, ...httpForm,
    }),
  ],
});

export function createInstalledConnectorPlugin(record: InstalledAppPlugin): ApplicationPlugin {
  return definePlugin({
    id: `installed:${record.manifest.id}`,
    requires: ['connectors'],
    contributes: record.enabled ? (record.manifest.contributes.connectors ?? []).map((platform) => {
      const sourceId = appConnectorSourceId(record.manifest.id, platform.id);
      return contribute(connectorForms, {
        id: sourceId,
        sourceId,
        platform,
        kind: platform.kind,
        privateFields: ['headers'],
        component: McpHttpFields,
        ...mcpHttpForm,
        create: (form, programs) => ({ ...mcpHttpForm.create(form, programs), sourceId }),
      });
    }) : [],
  });
}

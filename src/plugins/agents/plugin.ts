import { lazy } from 'react';
import { Bot } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { agentEditorRuntimes, agentWorkbenchPages } from './extensions';

const SubAgentsPage = lazyWithPreload(() => import('./pages'));
const OpenClawEditor = lazy(() => import('./editor/openclaw'));
const MatchaEditor = lazy(() => import('./editor/matcha'));

export const agentsPlugin = definePlugin({
  id: 'agents',
  requires: ['app-shell'],
  extensionPoints: [agentWorkbenchPages, agentEditorRuntimes],
  contributes: [
    contribute(agentEditorRuntimes, {
      id: 'openclaw',
      matches: (endpoint) => endpoint.kind !== 'native-runtime' || endpoint.runtimeAdapterId !== 'matcha-agent',
      usesModelCatalog: true,
      supportsSkillConfig: true,
      owner: OpenClawEditor,
    }),
    contribute(agentEditorRuntimes, {
      id: 'matcha-agent',
      matches: (endpoint) => endpoint.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'matcha-agent',
      usesModelCatalog: false,
      supportsSkillConfig: false,
      owner: MatchaEditor,
    }),
    contribute(applicationPages, {
      id: 'agents',
      path: '/subagents',
      component: SubAgentsPage,
      preload: SubAgentsPage.preload,
    }),
    contribute(applicationNavigation, {
      id: 'agents',
      to: '/subagents',
      label: 'common:sidebar.subagents',
      icon: Bot,
      order: 20,
      activePaths: ['/subagents', '/skills', '/plugins', '/connectors'],
      prefetch: () => import('./services/subagent-template-catalog').then(
        ({ prefetchSubagentTemplateCatalog }) => prefetchSubagentTemplateCatalog(),
      ),
    }),
    contribute(agentWorkbenchPages, {
      id: 'agents',
      to: '/subagents',
      label: 'common:sidebar.subagents',
      icon: Bot,
      order: 10,
    }),
  ],
});

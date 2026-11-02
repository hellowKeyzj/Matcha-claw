import { lazy } from 'react';
import { contribute, definePlugin } from '@/plugin-host/core';
import { workspaceLaunchers, workspacePanels } from './extensions';

const WorkspacePanel = lazy(() => import('./WorkspacePanel').then((module) => ({ default: module.WorkspacePanel })));

export const workspacePlugin = definePlugin({
  id: 'workspace',
  requires: ['app-shell'],
  extensionPoints: [workspaceLaunchers, workspacePanels],
  contributes: [contribute(workspacePanels, { id: 'workspace', component: WorkspacePanel })],
});

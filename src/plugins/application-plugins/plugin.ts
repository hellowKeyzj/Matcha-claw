import { createElement } from 'react';
import { AppWindow, Puzzle } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload, type ApplicationPlugin } from '@/plugin-host/core';
import { chatWorkspaceContent, type ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { imagePreviewActions, type ImagePreviewAction } from '@/plugins/message-rendering/extensions';
import { workspaceLaunchers } from '@/plugins/workspace/extensions';
import type { InstalledAppPlugin } from '@/types/desktop/app-plugin';
import { ImageEditorAction } from './ImageEditorAction';
import { applicationWorkspacePage } from './application-workspace';
import { developmentRecoveryPage } from './development-workspace';
import type { InstalledApplicationProps } from './InstalledApplication';

const ApplicationsPage = lazyWithPreload(() => import('./page'));
const DevelopmentPreview = lazyWithPreload(() => import('./DevelopmentPreview'));
const DevelopmentWorkspace = lazyWithPreload<ChatWorkspaceContentProps>(() => import('./DevelopmentWorkspace'));
const InstalledApplication = lazyWithPreload<InstalledApplicationProps>(() => import('./InstalledApplication').then((module) => ({ default: module.InstalledApplication })));

export function applicationPath(pluginId: string, applicationId: string): string {
  return `/applications/${encodeURIComponent(pluginId)}/${encodeURIComponent(applicationId)}`;
}

export function createInstalledApplicationPlugin(record: InstalledAppPlugin): ApplicationPlugin {
  return definePlugin({
    id: `installed:${record.manifest.id}`,
    requires: ['app-shell', 'chat', 'message-rendering', 'workspace'],
    contributes: record.enabled ? (record.manifest.contributes.applications ?? []).flatMap((application) => {
      const id = `installed:${record.manifest.id}:application:${application.id}`;
      const path = applicationPath(record.manifest.id, application.id);
      const editor = application.imageEditor;
      const imageAction: ImagePreviewAction | undefined = editor ? {
        id: `${id}:image-editor`,
        component: (props) => createElement(ImageEditorAction, {
          ...props, record, application,
          label: editor.label, translations: editor.translations, tool: editor.tool, action: imageAction!,
        }),
      } : undefined;
      const component = function ApplicationView() {
        return createElement(InstalledApplication, { pluginId: record.manifest.id, digest: record.digest, entry: application.entry, title: application.name });
      };
      return [
        ...(imageAction ? [contribute(imagePreviewActions, imageAction)] : []),
        ...(application.placement !== 'chat-panel' ? [
          contribute(applicationPages, { id, path, component, viewport: 'workspace' }),
          contribute(applicationNavigation, { id, to: path, label: application.name, icon: AppWindow, order: 90 }),
        ] : []),
        ...(application.placement === 'chat-panel' || application.placement === 'both' ? [
          contribute(workspaceLaunchers, { id, order: 50, icon: AppWindow, label: application.name, defaultLabel: application.name,
            execute: ({ workspace }) => workspace.openPage(applicationWorkspacePage(record, application)) }),
        ] : []),
      ];
    }) : [],
  });
}

export const applicationPluginsPlugin = definePlugin({
  id: 'application-plugins',
  requires: ['app-shell', 'chat', 'workspace'],
  contributes: [
    contribute(applicationPages, { id: 'applications', path: '/applications', component: ApplicationsPage, preload: ApplicationsPage.preload }),
    contribute(applicationPages, { id: 'application-development', path: '/applications/development/:developmentId', component: DevelopmentPreview, preload: DevelopmentPreview.preload, viewport: 'workspace' }),
    contribute(chatWorkspaceContent, { id: 'application-development', order: 30, component: DevelopmentWorkspace }),
    contribute(workspaceLaunchers, { id: 'application-development', order: 40, icon: Puzzle, label: 'applicationPlugins:preview.title',
      execute: ({ workspace }) => workspace.openPage(developmentRecoveryPage()) }),
    contribute(applicationNavigation, { id: 'applications', to: '/applications', label: 'applicationPlugins:title', icon: Puzzle, order: 89 }),
  ],
});

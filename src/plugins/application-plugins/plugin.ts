import { createElement } from 'react';
import { Puzzle } from 'lucide-react';
import { AppsNavigationIcon } from '@/components/icons/navigation';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { contribute, definePlugin, lazyWithPreload, type ApplicationPlugin } from '@/plugin-host/core';
import { chatWorkspaceContent, type ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { imagePreviewActions, messageContextTags, type ImagePreviewAction } from '@/plugins/message-rendering/extensions';
import { workspaceLaunchers } from '@/plugins/workspace/extensions';
import type { InstalledAppPlugin } from '@/types/desktop/app-plugin';
import { ImageEditorAction } from './ImageEditorAction';
import { applicationPath, applicationWorkspacePage } from './application-workspace';
import { applicationIcon } from './application-icon';
import { ApplicationRoute } from './ApplicationRoute';
export { applicationPath } from './application-workspace';
import { developmentRecoveryPage } from './development-workspace';

const ApplicationsPage = lazyWithPreload(() => import('./page'));
const DevelopmentPreview = lazyWithPreload(() => import('./DevelopmentPreview'));
const DevelopmentWorkspace = lazyWithPreload<ChatWorkspaceContentProps>(() => import('./DevelopmentWorkspace'));

export function createInstalledApplicationPlugin(record: InstalledAppPlugin): ApplicationPlugin {
  return definePlugin({
    id: `installed:${record.manifest.id}`,
    requires: ['app-shell', 'chat', 'message-rendering', 'workspace'],
    contributes: record.enabled ? [
      ...(record.manifest.contributes.chat ? [contribute(messageContextTags, {
        pluginId: record.manifest.id, digest: record.digest, tag: record.manifest.contributes.chat.contextTag,
      })] : []),
      ...(record.manifest.contributes.applications ?? []).flatMap((application) => {
        const id = `installed:${record.manifest.id}:application:${application.id}`;
        const path = applicationPath(record.manifest.id, application.id);
        const icon = applicationIcon(application.icon);
        const editor = application.imageEditor;
        const imageAction: ImagePreviewAction | undefined = editor ? {
          id: `${id}:image-editor`,
          component: (props) => createElement(ImageEditorAction, {
            ...props, record, application,
            label: editor.label, translations: editor.translations, tool: editor.tool, action: imageAction!,
          }),
        } : undefined;
        return [
          ...(imageAction ? [contribute(imagePreviewActions, imageAction)] : []),
          ...(application.placement !== 'chat-panel' ? [
            contribute(applicationPages, { id, path, component: ApplicationRoute, viewport: 'workspace' }),
          ] : []),
          ...(application.placement === 'chat-panel' || application.placement === 'both' ? [
            contribute(workspaceLaunchers, { id, order: 50, icon, label: application.name, defaultLabel: application.name,
              execute: ({ workspace }) => workspace.openPage(applicationWorkspacePage(record, application)) }),
          ] : []),
        ];
      }),
    ] : [],
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
    contribute(applicationNavigation, { id: 'applications', to: '/applications', label: 'applicationPlugins:title', icon: AppsNavigationIcon, order: 89 }),
  ],
});

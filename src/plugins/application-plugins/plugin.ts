import { createElement } from 'react';
import { useTranslation } from 'react-i18next';
import { AppWindow, Maximize2, Minimize2, Puzzle, X } from 'lucide-react';
import { applicationNavigation, applicationPages } from '@/app/extensions';
import { Button } from '@/components/ui/button';
import { contribute, definePlugin, lazyWithPreload, type ApplicationPlugin } from '@/plugin-host/core';
import { stageComposerPrompt } from '@/plugins/chat/composer-actions';
import { chatSidePanels, type ChatPanelProps } from '@/plugins/chat/extensions';
import { imagePreviewActions, type ImagePreviewAction } from '@/plugins/message-rendering/extensions';
import type { InstalledAppPlugin } from '@/types/desktop/app-plugin';
import type { AppComposeRequest, AppComposeSource } from '@/types/desktop/app-plugin-sdk';
import { ImageEditorAction } from './ImageEditorAction';
import type { InstalledApplicationProps } from './InstalledApplication';

const ApplicationsPage = lazyWithPreload(() => import('./page'));
const InstalledApplication = lazyWithPreload<InstalledApplicationProps>(() => import('./InstalledApplication').then((module) => ({ default: module.InstalledApplication })));

export function applicationPath(pluginId: string, applicationId: string): string {
  return `/applications/${encodeURIComponent(pluginId)}/${encodeURIComponent(applicationId)}`;
}

export function createInstalledApplicationPlugin(record: InstalledAppPlugin): ApplicationPlugin {
  return definePlugin({
    id: `installed:${record.manifest.id}`,
    requires: ['app-shell', 'chat', 'message-rendering'],
    contributes: record.enabled ? (record.manifest.contributes.applications ?? []).flatMap((application) => {
      const id = `installed:${record.manifest.id}:application:${application.id}`;
      const path = applicationPath(record.manifest.id, application.id);
      const editor = application.imageEditor;
      const imageAction: ImagePreviewAction | undefined = editor ? {
        id: `${id}:image-editor`,
        component: (props) => createElement(ImageEditorAction, {
          ...props,
          pluginId: record.manifest.id, digest: record.digest, panelId: id,
          label: editor.label, translations: editor.translations, tool: editor.tool, action: imageAction!,
        }),
      } : undefined;
      const component = function ApplicationView() {
        return createElement(InstalledApplication, { pluginId: record.manifest.id, digest: record.digest, entry: application.entry, title: application.name });
      };
      const chatComponent = function ApplicationChatPanel({ sessionIdentity, layout, onLayoutChange, onClose, registerCloseHandler }: ChatPanelProps) {
        const { t } = useTranslation('common');
        const fullscreenLabel = t(layout.fullscreen ? 'imagePreview.exitFullscreen' : 'imagePreview.fullscreen');
        return createElement('div', { className: 'relative h-full min-h-0' },
          createElement('div', { className: 'absolute right-3 top-3 z-10 flex items-center gap-2 rounded-xl bg-background p-1 shadow-[0_2px_8px_#0000001a]' },
            createElement(Button, { type: 'button', variant: 'ghost', size: 'icon', className: 'h-8 w-8', title: fullscreenLabel, 'aria-label': fullscreenLabel, 'aria-pressed': layout.fullscreen, onClick: () => onLayoutChange({ fullscreen: !layout.fullscreen, composer: layout.fullscreen ? undefined : 'dock' }) },
              createElement(layout.fullscreen ? Minimize2 : Maximize2, { className: 'h-4 w-4', 'aria-hidden': true })),
            createElement(Button, { type: 'button', variant: 'ghost', size: 'icon', className: 'h-8 w-8', title: t('imagePreview.closePanel'), 'aria-label': t('imagePreview.closePanel'), onClick: onClose },
              createElement(X, { className: 'h-4 w-4', 'aria-hidden': true }))),
          createElement('div', { className: 'h-full min-h-0' },
            createElement(InstalledApplication, {
              pluginId: record.manifest.id, digest: record.digest, entry: application.entry, title: application.name,
              sessionIdentity, registerCloseHandler,
              onCompose: sessionIdentity ? (request: AppComposeRequest, source: AppComposeSource, signal: AbortSignal) => stageComposerPrompt(sessionIdentity, request, source, signal) : undefined,
            })));
      };
      return [
        ...(imageAction ? [contribute(imagePreviewActions, imageAction)] : []),
        ...(application.placement !== 'chat-panel' ? [
          contribute(applicationPages, { id, path, component, viewport: 'workspace' }),
          contribute(applicationNavigation, { id, to: path, label: application.name, icon: AppWindow, order: 90 }),
        ] : []),
        ...(application.placement === 'chat-panel' || application.placement === 'both' ? [
          contribute(chatSidePanels, { id, order: 50, keepMounted: true, icon: AppWindow, label: application.name, defaultLabel: application.name, component: chatComponent }),
        ] : []),
      ];
    }) : [],
  });
}

export const applicationPluginsPlugin = definePlugin({
  id: 'application-plugins',
  requires: ['app-shell'],
  contributes: [
    contribute(applicationPages, { id: 'applications', path: '/applications', component: ApplicationsPage, preload: ApplicationsPage.preload }),
    contribute(applicationNavigation, { id: 'applications', to: '/applications', label: 'applicationPlugins:title', icon: Puzzle, order: 89 }),
  ],
});

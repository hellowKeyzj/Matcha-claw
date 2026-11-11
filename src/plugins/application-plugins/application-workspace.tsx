import { createElement, useEffect, useLayoutEffect, useRef } from 'react';
import { applicationIcon } from './application-icon';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import i18n from '@/i18n';
import { lazyWithPreload } from '@/plugin-host/core';
import { stageComposerPrompt, type ComposerTarget } from '@/plugins/chat/composer-actions';
import { useWorkspace } from '@/plugins/workspace/context';
import type { WorkspacePage, WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { AppApplicationManifest, InstalledAppPlugin } from '@/types/desktop/app-plugin';
import type { AppComposeRequest, AppComposeSource } from '@/types/desktop/app-plugin-sdk';
import { useInstalledAppPlugins } from './installed';
import type { InstalledApplicationProps } from './InstalledApplication';
import { createApplicationOpenChannel, type ApplicationOpenChannel, type ApplicationOpenRequest } from './application-open';

const InstalledApplication = lazyWithPreload<InstalledApplicationProps>(() => import('./InstalledApplication').then((module) => ({ default: module.InstalledApplication })));
const openChannels = new WeakMap<WorkspacePage['render'], ApplicationOpenChannel>();

export function applicationPath(pluginId: string, applicationId: string): string {
  return `/applications/${encodeURIComponent(pluginId)}/${encodeURIComponent(applicationId)}`;
}

function useOpenApplication(record: InstalledAppPlugin, placement: 'page' | 'chat-panel') {
  const { catalog } = useInstalledAppPlugins();
  const workspace = useWorkspace();
  const currentWorkspace = useRef(workspace);
  useLayoutEffect(() => { currentWorkspace.current = workspace; }, [workspace]);
  const navigate = useNavigate();
  return async (request: ApplicationOpenRequest): Promise<void> => {
    const current = catalog.plugins.find(plugin => plugin.enabled && plugin.manifest.id === record.manifest.id && plugin.digest === record.digest);
    const application = current?.manifest.contributes.applications?.find(entry => entry.id === request.applicationId);
    if (!current || !application || placement === 'page' && application.scope !== 'workspace'
      || !(placement === 'page' ? application.placement !== 'chat-panel' : application.placement === 'chat-panel' || application.placement === 'both')) {
      throw new Error(i18n.t('common:appFrame.invalidRequest'));
    }
    const workspace = currentWorkspace.current;
    const page = applicationWorkspacePage(current, application, request, placement);
    const existing = workspace.pages.find(entry => entry.id === page.id);
    if (existing) {
      const channel = openChannels.get(existing.render);
      if (!channel) throw new Error(i18n.t('common:appFrame.unavailable'));
      channel.open(request);
      workspace.activatePage(existing.id);
    } else flushSync(() => workspace.openPage(page));
    if (placement === 'page') navigate(applicationPath(current.manifest.id, application.id));
  };
}

function ApplicationWorkspacePage({ record, application, pageId, applicationOpen, placement, sessionIdentity, workspaceDraftId, registerCloseHandler }: WorkspacePageProps & {
  record: InstalledAppPlugin;
  application: AppApplicationManifest;
  pageId: string;
  applicationOpen: ApplicationOpenChannel;
  placement: 'page' | 'chat-panel';
}) {
  const { catalog } = useInstalledAppPlugins();
  const { removePage } = useWorkspace();
  const onOpenApplication = useOpenApplication(record, placement);
  const available = catalog.plugins.some((plugin) => plugin.enabled && plugin.manifest.id === record.manifest.id && plugin.digest === record.digest
    && plugin.manifest.contributes.applications?.some((entry) => entry.id === application.id && entry.entry === application.entry));
  useEffect(() => { if (!available) removePage(pageId); }, [available, pageId, removePage]);
  if (!available) return null;
  const props = { pluginId: record.manifest.id, digest: record.digest, entry: application.entry, title: application.name,
    applicationId: application.id, applicationOpen, onOpenApplication, registerCloseHandler };
  if (application.scope === 'workspace') return <InstalledApplication {...props} />;
  const target: ComposerTarget | undefined = sessionIdentity ? { kind: 'session', identity: sessionIdentity }
    : workspaceDraftId ? { kind: 'draft', id: workspaceDraftId } : undefined;
  return <InstalledApplication {...props} sessionIdentity={sessionIdentity} workspaceDraftId={workspaceDraftId}
    onCompose={target ? (request: AppComposeRequest, source: AppComposeSource, signal: AbortSignal) => stageComposerPrompt(target, request, source, signal) : undefined} />;
}

export function applicationWorkspacePageId(record: InstalledAppPlugin, application: AppApplicationManifest): string {
  return JSON.stringify([`application:${record.manifest.id}`, application.id]);
}

export function applicationWorkspacePage(record: InstalledAppPlugin, application: AppApplicationManifest, initial?: ApplicationOpenRequest, placement: 'page' | 'chat-panel' = 'chat-panel'): WorkspacePage {
  const providerId = `application:${record.manifest.id}`;
  const id = applicationWorkspacePageId(record, application);
  const applicationOpen = createApplicationOpenChannel(initial);
  const page: WorkspacePage = {
    id, providerId, title: application.name, icon: applicationIcon(application.icon),
    ...(application.scope === 'workspace' ? { lifetime: 'workspace' as const } : { promoteWithDraft: true }),
    render: (props) => createElement(ApplicationWorkspacePage, { ...props, record, application, pageId: id, applicationOpen, placement }),
  };
  openChannels.set(page.render, applicationOpen);
  return page;
}

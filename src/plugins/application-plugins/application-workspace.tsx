import { createElement, useEffect } from 'react';
import { AppWindow } from 'lucide-react';
import { lazyWithPreload } from '@/plugin-host/core';
import { stageComposerPrompt, type ComposerTarget } from '@/plugins/chat/composer-actions';
import { useWorkspace } from '@/plugins/workspace/context';
import type { WorkspacePage, WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { AppApplicationManifest, InstalledAppPlugin } from '@/types/desktop/app-plugin';
import type { AppComposeRequest, AppComposeSource } from '@/types/desktop/app-plugin-sdk';
import { useInstalledAppPlugins } from './installed';
import type { InstalledApplicationProps } from './InstalledApplication';

const InstalledApplication = lazyWithPreload<InstalledApplicationProps>(() => import('./InstalledApplication').then((module) => ({ default: module.InstalledApplication })));

function ApplicationWorkspacePage({ record, application, pageId, sessionIdentity, workspaceDraftId, registerCloseHandler }: WorkspacePageProps & {
  record: InstalledAppPlugin;
  application: AppApplicationManifest;
  pageId: string;
}) {
  const { catalog } = useInstalledAppPlugins();
  const { removePage } = useWorkspace();
  const available = catalog.plugins.some((plugin) => plugin.enabled && plugin.manifest.id === record.manifest.id && plugin.digest === record.digest
    && plugin.manifest.contributes.applications?.some((entry) => entry.id === application.id && entry.entry === application.entry));
  useEffect(() => { if (!available) removePage(pageId); }, [available, pageId, removePage]);
  if (!available) return null;
  if (application.scope === 'workspace') return <InstalledApplication pluginId={record.manifest.id} digest={record.digest} entry={application.entry} title={application.name}
    registerCloseHandler={registerCloseHandler} />;
  const target: ComposerTarget | undefined = sessionIdentity ? { kind: 'session', identity: sessionIdentity }
    : workspaceDraftId ? { kind: 'draft', id: workspaceDraftId } : undefined;
  return <InstalledApplication pluginId={record.manifest.id} digest={record.digest} entry={application.entry} title={application.name}
    sessionIdentity={sessionIdentity} workspaceDraftId={workspaceDraftId} registerCloseHandler={registerCloseHandler}
    onCompose={target ? (request: AppComposeRequest, source: AppComposeSource, signal: AbortSignal) => stageComposerPrompt(target, request, source, signal) : undefined} />;
}

export function applicationWorkspacePage(record: InstalledAppPlugin, application: AppApplicationManifest): WorkspacePage {
  const providerId = `application:${record.manifest.id}`;
  const id = JSON.stringify([providerId, application.id]);
  return {
    id, providerId, title: application.name, icon: AppWindow,
    ...(application.scope === 'workspace' ? { lifetime: 'workspace' as const } : { promoteWithDraft: true }),
    render: (props) => createElement(ApplicationWorkspacePage, { ...props, record, application, pageId: id }),
  };
}

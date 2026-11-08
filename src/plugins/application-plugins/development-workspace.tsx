import { createElement, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Puzzle } from 'lucide-react';
import i18n from '@/i18n';
import { Button } from '@/components/ui/button';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeBrowserRecovery } from '@/lib/host-events';
import { lazyWithPreload } from '@/plugin-host/core';
import { useWorkspace } from '@/plugins/workspace/context';
import type { WorkspaceController, WorkspacePage, WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { AppApplicationManifest } from '@/types/desktop/app-plugin';
import type { PluginDevelopmentSummary } from './development';
import { readDevelopmentStatus, useDevelopmentStatus } from './development-status';
import type { DevelopmentPreviewContentProps } from './DevelopmentPreview';

const DevelopmentPreviewContent = lazyWithPreload<DevelopmentPreviewContentProps>(() => import('./DevelopmentPreview').then((module) => ({ default: module.DevelopmentPreviewContent })));

function DevelopmentEntryPage({ developmentId, applicationId, entry, pageId, ...props }: WorkspacePageProps & { developmentId: string; applicationId?: string; entry?: string; pageId: string }) {
  const { pages, activatePage, removePage, openPage } = useWorkspace();
  const { status } = useDevelopmentStatus(developmentId);
  const page = pages.find((candidate) => candidate.id === pageId);
  const commandSeen = useRef<string | null>(null);
  const command = status?.commands.find((candidate) => candidate.revision === status.revision && candidate.entry === entry);
  useEffect(() => {
    if (!command || commandSeen.current === command.id) return;
    commandSeen.current = command.id;
    activatePage(pageId);
  }, [command, pageId, activatePage]);
  const application = status?.manifest?.contributes.applications?.find((candidate) => candidate.id === applicationId);
  const title = application?.name ?? status?.manifest?.name;
  const lifetime = application?.scope === 'workspace' ? 'workspace' : undefined;
  const removed = status?.state === 'active' && !!status.manifest && applicationId !== undefined && (!application || application.entry !== entry);
  useEffect(() => {
    if (removed) removePage(pageId);
    else if (page && title && (page.title !== title || page.lifetime !== lifetime)) openPage({ ...page, title, lifetime }, { activate: false });
  }, [removed, title, lifetime, page, pageId, removePage, openPage]);
  return removed ? null : <DevelopmentPreviewContent developmentId={developmentId} entry={entry} embedded visible={props.visible} registerCloseHandler={props.registerCloseHandler} />;
}

export async function openDevelopmentPages(workspace: WorkspaceController, developmentId: string, signal: AbortSignal): Promise<void> {
  const status = await readDevelopmentStatus(developmentId, signal);
  signal.throwIfAborted();
  if (!status.manifest) return;
  const providerId = `application-development:${developmentId}`;
  const applications = status.manifest.contributes.applications ?? [];
  const pages = applications.length
    ? applications.map((application) => developmentPage(developmentId, application.name, application))
    : [developmentPage(developmentId, status.manifest.name)];
  workspace.syncPages(providerId, pages);
  workspace.openPage(pages[0]);
}

function developmentPage(developmentId: string, title: string, application?: AppApplicationManifest): WorkspacePage {
  const providerId = `application-development:${developmentId}`;
  const id = JSON.stringify([providerId, application?.id ?? null]);
  return {
    id, providerId, title, icon: Puzzle, badge: 'preview', lifetime: application?.scope === 'workspace' ? 'workspace' : undefined,
    render: (props) => createElement(DevelopmentEntryPage, { ...props, developmentId, applicationId: application?.id, entry: application?.entry, pageId: id }),
  };
}

function DevelopmentRecovery({ visible }: WorkspacePageProps) {
  const { t } = useTranslation('applicationPlugins');
  const workspace = useWorkspace();
  const [developments, setDevelopments] = useState<PluginDevelopmentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useMemo(() => ({ visible, refresh }), [visible, refresh]);
  const [completed, setCompleted] = useState<typeof request | null>(null);
  const loading = visible && completed !== request;
  const [selected, setSelected] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const openSelected = useEffectEvent((developmentId: string, signal: AbortSignal) => openDevelopmentPages(workspace, developmentId, signal));
  useEffect(() => {
    if (!visible) return;
    return subscribeBrowserRecovery(() => setRefresh((value) => value + 1));
  }, [visible]);
  useEffect(() => {
    if (!request.visible) return;
    const controller = new AbortController();
    void hostApiFetch<{ developments: PluginDevelopmentSummary[] }>('/api/app-plugins/development-list', { method: 'POST', body: '{}', signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setDevelopments(result.developments); setPageIndex(0); setError(null); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('preview.listFailed')); })
      .finally(() => { if (!controller.signal.aborted) setCompleted(request); });
    return () => controller.abort();
  }, [request, t]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void openSelected(selected, controller.signal)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('preview.statusFailed')); })
      .finally(() => { if (!controller.signal.aborted) setSelected(null); });
    return () => controller.abort();
  }, [selected, t]);
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
      <h2 className="flex-1 text-sm font-semibold">{t('preview.title')}</h2>
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{t('preview.refresh')}</Button>
    </header>
    {error && <p role="alert" className="px-4 py-3 text-sm text-destructive">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {loading ? <p role="status" className="text-sm text-muted-foreground">{t('preview.loading')}</p>
        : developments.length ? <><ul className="space-y-2">{developments.slice(pageIndex * 40, (pageIndex + 1) * 40).map((development) => <li key={development.developmentId}>
          <Button variant="outline" className="h-auto w-full justify-start whitespace-normal py-3 text-left" disabled={selected !== null} onClick={() => setSelected(development.developmentId)}>
            {development.manifest?.name ?? development.developmentId} · {t(`preview.state.${development.state}`)}
          </Button>
        </li>)}</ul>{developments.length > 40 && <div className="mt-3 flex gap-2"><Button variant="ghost" disabled={pageIndex === 0} onClick={() => setPageIndex((value) => value - 1)}>{t('preview.previous')}</Button><Button variant="ghost" disabled={(pageIndex + 1) * 40 >= developments.length} onClick={() => setPageIndex((value) => value + 1)}>{t('preview.next')}</Button></div>}</> : <p role="status" className="text-sm text-muted-foreground">{t('preview.empty')}</p>}
    </div>
  </div>;
}

const renderRecovery = (props: WorkspacePageProps) => createElement(DevelopmentRecovery, props);
export function developmentRecoveryPage(): WorkspacePage {
  return { id: 'application-development:recovery', providerId: 'application-development', title: i18n.t('applicationPlugins:preview.title'), icon: Puzzle, render: renderRecovery };
}


import { Suspense, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { WorkspaceProvider, useWorkspace } from '@/plugins/workspace/context';
import type { WorkspaceCloseHandler, WorkspacePage } from '@/plugins/workspace/extensions';
import type { AppApplicationManifest, InstalledAppPlugin } from '@/types/desktop/app-plugin';
import { applicationPath, applicationWorkspacePage, applicationWorkspacePageId } from './application-workspace';
import { useInstalledAppPlugins } from './installed';

function ApplicationPageContent({ page, ...props }: { page: WorkspacePage } & Parameters<WorkspacePage['render']>[0]) {
  return page.render(props);
}

function ApplicationPage({ page, visible, panelId, tabId }: { page: WorkspacePage; visible: boolean; panelId: string; tabId: string }) {
  const workspace = useWorkspace();
  const registration = useRef(workspace.registerCloseHandler);
  useLayoutEffect(() => { registration.current = workspace.registerCloseHandler; }, [workspace.registerCloseHandler]);
  const registerCloseHandler = useCallback((handler: WorkspaceCloseHandler) => registration.current(page.id, handler), [page.id]);
  return <div hidden={!visible} inert={!visible} className="h-full min-h-0" role="tabpanel" id={panelId} aria-labelledby={tabId}>
    <Suspense fallback={null}><ApplicationPageContent page={page} visible={visible} width={window.innerWidth} layout={workspace.layout}
      onLayoutChange={workspace.setLayout} onClose={() => { void workspace.closePage(page.id); }} registerCloseHandler={registerCloseHandler} /></Suspense>
  </div>;
}

function ApplicationRoutePages({ record, application }: { record: InstalledAppPlugin; application: AppApplicationManifest }) {
  const { t } = useTranslation('workspace');
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const id = useId();
  const [closedPageId, setClosedPageId] = useState<string | null>(null);
  const selectPage = (page: WorkspacePage) => {
    workspace.activatePage(page.id);
    const target = record.manifest.contributes.applications?.find(entry => applicationWorkspacePageId(record, entry) === page.id);
    if (target) navigate(applicationPath(record.manifest.id, target.id));
  };
  const closePage = async (page: WorkspacePage) => {
    await workspace.closePage(page.id);
    setClosedPageId(page.id);
  };
  const finishClose = useEffectEvent(() => {
    if (!closedPageId) return;
    setClosedPageId(null);
    if (workspace.pages.some(page => page.id === closedPageId)) return;
    const next = workspace.pages.find(page => page.id === workspace.activePageId);
    if (next) selectPage(next);
    else navigate('/applications');
  });
  useEffect(() => { finishClose(); }, [closedPageId]);
  const selectRoute = useEffectEvent(() => {
    const page = applicationWorkspacePage(record, application, undefined, 'page');
    if (workspace.pages.some(entry => entry.id === page.id)) workspace.activatePage(page.id);
    else workspace.openPage(page);
  });
  useEffect(() => { selectRoute(); }, [record, application]);
  return <div className="flex h-full min-h-0 flex-col">
    <div role="tablist" aria-label={record.manifest.name} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1"
      onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = tabs.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus();
      }}>
      {workspace.pages.map(page => <div key={page.id} className="flex shrink-0 items-center rounded-md bg-secondary">
        <button type="button" role="tab" id={`${id}-tab-${page.id}`} aria-controls={`${id}-panel-${page.id}`} tabIndex={workspace.activePageId === page.id ? 0 : -1}
          aria-selected={workspace.activePageId === page.id} className="flex items-center gap-2 px-3 py-2 text-sm" onClick={() => selectPage(page)}>{page.icon && <page.icon className="size-4 shrink-0" aria-hidden={true} />}{page.title}</button>
        <Button type="button" variant="ghost" size="icon" className="mr-1 h-6 w-6" aria-label={t('closePage', { title: page.title })}
          onClick={() => closePage(page)}><X aria-hidden="true" className="h-3 w-3" /></Button>
      </div>)}
    </div>
    <div className="min-h-0 flex-1">{workspace.pages.map(page => <ApplicationPage key={page.id} page={page} visible={workspace.activePageId === page.id} tabId={`${id}-tab-${page.id}`} panelId={`${id}-panel-${page.id}`} />)}</div>
  </div>;
}

export function ApplicationRoute() {
  const { pathname } = useLocation();
  const { catalog } = useInstalledAppPlugins();
  const record = catalog.plugins.find(plugin => plugin.enabled && plugin.manifest.contributes.applications?.some(application => applicationPath(plugin.manifest.id, application.id) === pathname));
  const application = record?.manifest.contributes.applications?.find(entry => applicationPath(record.manifest.id, entry.id) === pathname);
  if (!record || !application || application.placement === 'chat-panel') return null;
  return <WorkspaceProvider key={JSON.stringify([record.manifest.id, record.digest])} scopeKey={`application-route:${record.manifest.id}:${record.digest}`} sessionIdentity={null}>
    <ApplicationRoutePages record={record} application={application} />
  </WorkspaceProvider>;
}

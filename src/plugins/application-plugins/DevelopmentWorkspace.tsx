import { useEffect, useEffectEvent, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { subscribeHostEvent } from '@/lib/host-events';
import type { ChatWorkspaceContentProps } from '@/plugins/chat/extensions';
import { useWorkspace } from '@/plugins/workspace/context';
import { applicationWorkspacePage } from './application-workspace';
import { openDevelopmentPages } from './development-workspace';
import { useInstalledAppPlugins } from './installed';

export default function DevelopmentWorkspace({ isActive, enabled, visible }: ChatWorkspaceContentProps) {
  const workspace = useWorkspace();
  const { openPage } = workspace;
  const preview = useEffectEvent((developmentId: string, signal: AbortSignal) => openDevelopmentPages(workspace, developmentId, signal));
  const location = useLocation();
  const navigate = useNavigate();
  const { catalog } = useInstalledAppPlugins();
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    const target = (location.state as { applicationWorkspace?: { pluginId: string; applicationId: string } } | null)?.applicationWorkspace;
    if (!target || consumed.current === location.key || !isActive || !enabled || !visible || catalog.revision < 0) return;
    consumed.current = location.key;
    const record = catalog.plugins.find((plugin) => plugin.enabled && plugin.manifest.id === target.pluginId);
    const application = record?.manifest.contributes.applications?.find((candidate) => candidate.id === target.applicationId);
    if (record && application) openPage(applicationWorkspacePage(record, application));
    else toast.error(i18n.t('applicationPlugins:unavailable'));
    navigate(location.pathname, { replace: true, state: null });
  }, [location.key, location.state, location.pathname, isActive, enabled, visible, catalog, openPage, navigate]);
  useEffect(() => {
    if (!isActive || !enabled || !visible) return;
    const pending = new Map<string, AbortController>();
    const unsubscribe = subscribeHostEvent<{ developmentId: string }>('app-plugins:preview', ({ developmentId }) => {
      if (document.visibilityState !== 'visible' || typeof developmentId !== 'string' || !developmentId) return;
      pending.get(developmentId)?.abort();
      const controller = new AbortController();
      pending.set(developmentId, controller);
      void preview(developmentId, controller.signal).catch((cause: unknown) => {
        if (!controller.signal.aborted) toast.error(cause instanceof Error ? cause.message : i18n.t('applicationPlugins:preview.statusFailed'));
      }).finally(() => { if (pending.get(developmentId) === controller) pending.delete(developmentId); });
    });
    return () => { unsubscribe(); for (const controller of pending.values()) controller.abort(); };
  }, [isActive, enabled, visible]);
  return null;
}

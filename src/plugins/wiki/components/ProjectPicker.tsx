import { memo, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ChatComposerPanelProps } from '@/plugins/chat/extensions';
import { useWikiProjectsStore } from '@/plugins/wiki/wiki-projects';
import type { WikiProject } from '@/plugins/wiki/wiki-model';

export const ProjectPicker = memo(function ProjectPicker({ open, onOpenChange, returnFocusRef }: ChatComposerPanelProps) {
  const { t } = useTranslation('chat');
  const projects = useWikiProjectsStore((state) => state.projects);
  const currentProject = useWikiProjectsStore((state) => state.currentProject);
  const loading = useWikiProjectsStore((state) => state.loading);
  const switching = useWikiProjectsStore((state) => state.switching);
  const ready = useWikiProjectsStore((state) => state.ready);
  const refresh = useWikiProjectsStore((state) => state.refresh);
  const openProject = useWikiProjectsStore((state) => state.openProject);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const load = () => {
      if (!useWikiProjectsStore.getState().ready) void refresh().catch(() => {});
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.requestAnimationFrame(load);
    return () => window.cancelAnimationFrame(id);
  }, [refresh]);

  const reload = () => {
    setLoadFailed(false);
    void refresh().catch(() => {
      setLoadFailed(true);
      toast.error(t('input.wikiLoadFailed'));
    });
  };

  const select = async (project: WikiProject) => {
    if (project.projectId === currentProject?.projectId) return;
    try {
      await openProject(project);
      toast.success(t('input.wikiSwitched', { name: project.title }));
    } catch {
      toast.error(t('input.wikiSwitchFailed'));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-[hsl(var(--shell-scrim))]" />
        <Dialog.Content aria-describedby={undefined}
          onOpenAutoFocus={reload}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusRef.current?.focus(); }}
          className="fixed left-1/2 top-1/2 z-[120] flex max-h-[calc(100dvh-24px)] w-[360px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-elevated outline-none">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold">{t('input.pickWiki')}</Dialog.Title>
            {switching ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
            <Dialog.Close asChild><Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t('input.closePanel')}><X aria-hidden="true" className="h-4 w-4" /></Button></Dialog.Close>
          </header>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-1.5" aria-busy={loading || switching}>
            {loading && <div role="status" className="px-2.5 py-2 text-xs text-muted-foreground">{t('input.wikiLoading')}</div>}
            {loadFailed && <Button type="button" variant="ghost" onClick={reload}>{t('input.wikiRetry')}</Button>}
            {ready && !loading && !loadFailed && projects.length === 0 && (
              <div role="status" className="px-2.5 py-2 text-xs text-muted-foreground">{t('input.wikiEmpty')}</div>
            )}
            <RadioGroup.Root value={currentProject?.projectId ?? ''} disabled={switching || loading || loadFailed} aria-label={t('input.pickWiki')}
              onValueChange={(id) => {
                const project = projects.find((item) => item.projectId === id);
                if (project) { onOpenChange(false); void select(project); }
              }}>
              {projects.map((project) => (
                <RadioGroup.Item key={project.projectId} value={project.projectId} title={project.title}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 disabled:opacity-45 data-[state=checked]:bg-secondary">
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  <RadioGroup.Indicator><Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /></RadioGroup.Indicator>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});

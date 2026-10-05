import { memo, useEffect, useState } from 'react';
import { BookOpen, Check, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useWikiProjectsStore } from '@/stores/wiki-projects';
import type { WikiProject } from '@/pages/Wiki/wiki-model';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';

export const ChatWikiProjectPicker = memo(function ChatWikiProjectPicker() {
  const { t } = useTranslation('chat');
  const projects = useWikiProjectsStore((state) => state.projects);
  const currentProject = useWikiProjectsStore((state) => state.currentProject);
  const loading = useWikiProjectsStore((state) => state.loading);
  const switching = useWikiProjectsStore((state) => state.switching);
  const ready = useWikiProjectsStore((state) => state.ready);
  const refresh = useWikiProjectsStore((state) => state.refresh);
  const openProject = useWikiProjectsStore((state) => state.openProject);
  const [open, setOpen] = useState(false);
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

  const label = currentProject?.title || t('input.pickWiki');
  return (
    <DropdownMenu open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) reload();
    }}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            CHAT_LAYOUT_TOKENS.inputAttachButton,
            'shrink-0 border border-border/45 bg-background/74 text-muted-foreground shadow-sm hover:bg-background/88 hover:text-foreground',
            open && 'bg-background/90 text-foreground',
          )}
          aria-label={t('input.wikiPickerLabel', { name: label })}
          aria-busy={switching}
          title={label}
        >
          {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookOpen className="h-4 w-4 shrink-0" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-80 max-w-[calc(100vw-24px)] overflow-y-auto">
        {loading && <div role="status" className="px-2.5 py-2 text-xs text-muted-foreground">{t('input.wikiLoading')}</div>}
        {loadFailed && <DropdownMenuItem onSelect={(event) => { event.preventDefault(); reload(); }}>{t('input.wikiRetry')}</DropdownMenuItem>}
        {ready && !loading && !loadFailed && projects.length === 0 && (
          <div role="status" className="px-2.5 py-2 text-xs text-muted-foreground">{t('input.wikiEmpty')}</div>
        )}
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.projectId}
            role="menuitemradio"
            aria-checked={project.projectId === currentProject?.projectId}
            disabled={switching || loading || loadFailed}
            onSelect={() => { void select(project); }}
          >
            <span className="min-w-0 flex-1 truncate">{project.title}</span>
            {project.projectId === currentProject?.projectId && <Check className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

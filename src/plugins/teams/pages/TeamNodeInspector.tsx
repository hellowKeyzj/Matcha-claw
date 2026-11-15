import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Bot, Check, CheckCircle2, Circle, CircleX, Clock3, FileCode2, Flag, GitMerge, Loader2, Maximize2, Minimize2, Trash2, UserCheck, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TeamGraphNodeRecord } from '@/types/team-design';
import type { TeamRunGraphCanvasLabels } from '@/plugins/teams/pages/TeamRunGraphCanvas';
import type { TeamGraphCanvasNodeKind, TeamGraphNodeDetailTab, TeamGraphNodeTab } from '@/plugins/teams/pages/team-node-editor-types';

type TeamNodeInspectorProps = {
  node: TeamGraphNodeRecord;
  kind: TeamGraphCanvasNodeKind;
  editable: boolean;
  pending: boolean;
  mutationDisabled?: boolean;
  isNew: boolean;
  title: string;
  status: string;
  statusClassName: string;
  labels: TeamRunGraphCanvasLabels;
  error: string | null;
  activeTab: TeamGraphNodeTab;
  detailTabs: TeamGraphNodeDetailTab[];
  detailContent?: ReactNode;
  onTabChange: (tab: TeamGraphNodeTab) => void;
  onTitleChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function TeamNodeInspector({ node, kind, editable, pending, mutationDisabled = false, isNew, title, status, statusClassName, labels, error, activeTab, detailTabs, detailContent, onTabChange, onTitleChange, onSave, onDelete, onClose, children }: TeamNodeInspectorProps) {
  const { t } = useTranslation('teams');
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const editingConfig = editable && activeTab === 'config';
  const NodeIcon = { start: Zap, work: Bot, review: CheckCircle2, human_decision: UserCheck, script_review: FileCode2, join: GitMerge, end: Flag }[kind];
  const StatusIcon = ['completed', 'passed'].includes(node.status ?? '') ? CheckCircle2
    : node.status === 'failed' ? CircleX
      : node.status === 'running' || node.status === 'queued' ? Loader2
        : node.status === 'waiting_for_user' || node.status === 'waiting' ? Clock3 : Circle;

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[hsl(var(--shell-scrim))] backdrop-blur-[3px]" />
      <DialogPrimitive.Content
        aria-busy={pending}
        style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif' }}
        onOpenAutoFocus={(event) => {
          const activeElement = document.activeElement;
          const content = event.currentTarget;
          if (activeElement instanceof HTMLElement && content instanceof HTMLElement && !content.contains(activeElement)) returnFocusRef.current = activeElement;
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
        onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
        className={`fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[18px] border border-[hsl(var(--shell-border-strong))] bg-[hsl(var(--shell-surface))] text-foreground shadow-[var(--shell-shadow-overlay)] outline-none dark:bg-[hsl(var(--shell-surface-muted))] ${expanded ? 'h-[calc(100dvh-32px)] w-[calc(100vw-32px)]' : 'h-[min(860px,calc(100dvh-72px))] w-[calc(100vw-72px)] max-w-[960px]'} max-[780px]:h-[calc(100dvh-20px)] max-[780px]:w-[calc(100vw-20px)]`}
      >
        <header className="flex shrink-0 items-start gap-[13px] px-[27px] py-[22px] max-[780px]:gap-2.5 max-[780px]:px-[18px] max-[780px]:py-[18px]">
          <span aria-hidden="true" className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-hover))] text-[hsl(var(--shell-text-muted))] dark:border-[hsl(var(--shell-border-strong))]">
            <NodeIcon className="h-[18px] w-[18px]" strokeWidth={1.65} />
          </span>
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title ref={titleRef} tabIndex={-1} className="break-words text-[19px] font-[550] leading-[26px] outline-none [overflow-wrap:anywhere]">{node.title || labels.nodeKindLabels[kind]}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{labels.nodePaletteDescriptions[kind]}</DialogPrimitive.Description>
          </div>
          <div className="-mt-1 flex shrink-0 flex-wrap items-center justify-end gap-1 max-[780px]:max-w-[68px]">
            {status ? <span className={`mr-2 inline-flex min-w-0 items-center gap-[5px] break-words text-[11px] max-[780px]:order-last max-[780px]:mr-0 ${statusClassName}`}><StatusIcon aria-hidden="true" className="h-[13px] w-[13px] shrink-0" />{status}</span> : null}
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-lg" aria-label={t(expanded ? 'workspace.collapse' : 'workspace.expand')} title={t(expanded ? 'workspace.collapse' : 'workspace.expand')} aria-pressed={expanded} onClick={() => setExpanded((value) => !value)} disabled={pending}>
              {expanded ? <Minimize2 aria-hidden="true" className="h-4 w-4" /> : <Maximize2 aria-hidden="true" className="h-4 w-4" />}
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-lg" aria-label={labels.closeNode} title={labels.closeNode} onClick={onClose} disabled={pending}>
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as TeamGraphNodeTab)} className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[hsl(var(--shell-border))] px-7 max-[780px]:px-[18px]">
            <TabsList variant="line" aria-label={labels.nodeDetails ?? labels.nodeConfiguration} className="h-[42px] min-h-0 gap-6">
              <TabsTrigger value="config" disabled={pending} className="shrink-0 text-xs">{t('workspace.config')}</TabsTrigger>
              {detailTabs.map((tab) => <TabsTrigger key={tab} value={tab} disabled={pending} className="shrink-0 text-xs">{t(`workspace.${tab}`)}</TabsTrigger>)}
            </TabsList>
          </div>
          {node.statusReason === 'rework_limit_exceeded' ? <p role="status" className="shrink-0 px-[27px] pt-4 text-xs text-amber-700 dark:text-amber-400 max-[780px]:px-[18px]">{labels.reworkLimitExceeded}</p> : null}
          <TabsContent value="config" forceMount hidden={activeTab !== 'config'} className="mt-0 min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] data-[state=inactive]:hidden">
            <div className="mx-auto w-full max-w-[720px] space-y-[22px] px-[34px] py-6 max-[780px]:space-y-5 max-[780px]:px-[21px]">
              <label htmlFor={`${id}-title`} className="grid gap-[9px] text-xs font-[550]">
                {labels.nodeTitle}
                <input
                  id={`${id}-title`}
                  className="h-[41px] w-full min-w-0 rounded-[9px] border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface))] px-3 py-2.5 text-xs font-normal leading-[1.6] text-foreground hover:border-[hsl(var(--shell-border-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[hsl(var(--shell-surface-muted))]"
                  value={editable ? title : node.title ?? ''}
                  readOnly={!editable}
                  disabled={pending}
                  onChange={(event) => onTitleChange(event.target.value)}
                />
              </label>
              {children}
            </div>
          </TabsContent>
          {activeTab !== 'config' ? <TabsContent value={activeTab} className="mt-0 flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-7 max-[780px]:px-[21px] max-[780px]:py-6">
            {detailContent}
          </TabsContent> : null}
        </Tabs>
        <footer className="shrink-0 border-t border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-muted))] px-[27px] py-4 dark:bg-secondary max-[780px]:px-[18px] max-[780px]:py-3.5">
          {error ? <p role="alert" className="mb-3 max-h-24 overflow-y-auto break-words text-xs text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-[9px]">
            {editingConfig && !isNew ? <Button type="button" variant="ghost" size="icon" className="mr-auto h-[34px] w-[34px] rounded-[9px] text-muted-foreground hover:text-destructive" aria-label={labels.deleteNode} title={labels.deleteNode} disabled={pending || mutationDisabled} onClick={onDelete}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button> : null}
            <Button type="button" variant="outline" size="sm" className="h-[34px] rounded-[9px] px-3" onClick={onClose} disabled={pending}>{editingConfig ? labels.cancelNode : labels.closeNode}</Button>
            {editingConfig ? <Button type="button" size="sm" className="h-[34px] gap-[7px] rounded-[9px] px-3" disabled={pending || mutationDisabled} onClick={onSave}>{pending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}{labels.saveNode}</Button> : null}
          </div>
        </footer>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

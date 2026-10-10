import { useId, type ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { TeamGraphNodeRecord } from '@/types/team-design';
import type { TeamRunGraphCanvasLabels } from './TeamRunGraphCanvas';
import type { TeamGraphCanvasNodeKind } from './team-node-editor-types';

type TeamNodeInspectorProps = {
  node: TeamGraphNodeRecord;
  kind: TeamGraphCanvasNodeKind;
  editable: boolean;
  pending: boolean;
  isNew: boolean;
  title: string;
  maxAttempts: string;
  maxAttemptsLimit: number;
  status: string;
  statusClassName: string;
  labels: TeamRunGraphCanvasLabels;
  error: string | null;
  onTitleChange: (value: string) => void;
  onMaxAttemptsChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function TeamNodeInspector({ node, kind, editable, pending, isNew, title, maxAttempts, maxAttemptsLimit, status, statusClassName, labels, error, onTitleChange, onMaxAttemptsChange, onSave, onDelete, onClose, children }: TeamNodeInspectorProps) {
  const id = useId();
  const attempts = editable ? maxAttempts : node.maxAttempts;
  return (
    <SheetContent side="right" showCloseButton={false} className="flex w-[500px] max-w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[500px]">
      <header className="shrink-0 border-b px-6 pb-5 pt-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3 text-xs">
            <span className="font-medium text-muted-foreground">{labels.nodeKindLabels[kind]}</span>
            {status ? <span className={statusClassName}>{status}</span> : null}
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={labels.closeNode} onClick={onClose} disabled={pending}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
        <SheetTitle className={editable ? 'sr-only' : 'break-words text-2xl leading-tight'}>{node.title || labels.nodeKindLabels[kind]}</SheetTitle>
        <SheetDescription className="sr-only">{labels.nodePaletteDescriptions[kind]}</SheetDescription>
        {editable ? <textarea
          aria-label={labels.nodeTitle}
          className="block min-h-[3.5rem] w-full resize-none rounded-md border border-transparent bg-transparent px-1 py-1 text-2xl font-semibold leading-tight tracking-tight text-foreground hover:border-input focus-visible:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          rows={2}
          value={title}
          disabled={pending}
          onChange={(event) => onTitleChange(event.target.value)}
        /> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {node.statusReason === 'rework_limit_exceeded' ? <p role="status" className="mb-5 text-sm text-destructive">{labels.reworkLimitExceeded}</p> : null}
        <div className="space-y-6">{children}</div>
        <details className="mt-6 border-t pt-4">
          <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {labels.executionSettings}
            {attempts !== undefined && attempts !== '' ? <span className="ml-2 text-xs font-normal text-muted-foreground">{labels.executionLimitSummary.replace('{{count}}', String(attempts))}</span> : null}
          </summary>
          <div className="mt-4 space-y-2">
            {editable ? <label className="grid gap-2 text-sm">
              {labels.nodeMaxAttempts}
              <input
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                type="number"
                min={1}
                max={maxAttemptsLimit}
                step={1}
                aria-describedby={`${id}-attempts-hint`}
                value={maxAttempts}
                disabled={pending}
                onChange={(event) => onMaxAttemptsChange(event.target.value)}
              />
            </label> : <p className="text-sm">{labels.nodeMaxAttempts}: {attempts ?? '—'}</p>}
            <p id={`${id}-attempts-hint`} className="text-xs leading-relaxed text-muted-foreground">{labels.nodeMaxAttemptsHint}</p>
          </div>
        </details>
        <details className="mt-4 border-t pt-4">
          <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{labels.nodeTechnicalDetails}</summary>
          <dl className="mt-4 grid gap-3 text-xs">
            <div><dt className="text-muted-foreground">ID</dt><dd className="mt-1 break-all font-mono">{node.nodeId}</dd></div>
            {node.taskId ? <div><dt className="text-muted-foreground">{labels.task}</dt><dd className="mt-1 break-all font-mono">{node.taskId}</dd></div> : null}
          </dl>
        </details>
      </div>
      <footer className="shrink-0 border-t px-6 py-4">
        {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          {editable && !isNew ? <Button type="button" variant="ghost" size="icon" className="mr-auto h-9 w-9 text-muted-foreground hover:text-destructive" aria-label={labels.deleteNode} title={labels.deleteNode} disabled={pending} onClick={onDelete}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button> : null}
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>{editable ? labels.cancelNode : labels.closeNode}</Button>
          {editable ? <Button type="button" size="sm" disabled={pending} onClick={onSave}>{labels.saveNode}</Button> : null}
        </div>
      </footer>
    </SheetContent>
  );
}

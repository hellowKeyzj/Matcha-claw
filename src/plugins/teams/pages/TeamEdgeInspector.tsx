import { useId } from 'react';
import { ArrowDown, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { TeamGraphEdgeAction, TeamGraphEdgeRecord, TeamGraphNodeRecord, TeamGraphReworkCounter } from '@/types/team-design';
import { EdgeActionEditor, PortEditor } from '@/plugins/teams/pages/TeamGraphPortRepair';
import type { TeamRunGraphCanvasLabels } from '@/plugins/teams/pages/TeamRunGraphCanvas';

type TeamEdgeInspectorProps = {
  edge: TeamGraphEdgeRecord;
  sourceNode: TeamGraphNodeRecord | null;
  targetNode: TeamGraphNodeRecord | null;
  editable: boolean;
  pending: boolean;
  mutationDisabled?: boolean;
  isNew: boolean;
  sourcePort: string;
  targetPort: string;
  action: TeamGraphEdgeAction | '';
  actions: TeamGraphEdgeAction[];
  includeUpstreamResult: boolean;
  reworkLimit: string | null;
  reworkLimitValid: boolean;
  reworkCounters: TeamGraphReworkCounter[];
  onReworkLimitChange: (value: string) => void;
  canSave: boolean;
  status: string;
  statusClassName: string;
  labels: TeamRunGraphCanvasLabels;
  error: string | null;
  onSourcePortChange: (value: string) => void;
  onTargetPortChange: (value: string) => void;
  onActionChange: (value: TeamGraphEdgeAction) => void;
  onIncludeUpstreamResultChange: (value: boolean) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function TeamEdgeInspector({ edge, sourceNode, targetNode, editable, pending, mutationDisabled = false, isNew, sourcePort, targetPort, action, actions, includeUpstreamResult, reworkLimit, reworkLimitValid, reworkCounters, onReworkLimitChange, canSave, status, statusClassName, labels, error, onSourcePortChange, onTargetPortChange, onActionChange, onIncludeUpstreamResultChange, onSave, onDelete, onClose }: TeamEdgeInspectorProps) {
  const id = useId();
  const sourcePorts = sourceNode?.sourcePorts ?? [];
  const targetPorts = targetNode?.targetPorts ?? [];
  const sourceValid = sourcePorts.includes(sourcePort);
  const targetValid = targetPorts.includes(targetPort);
  const actionValid = action !== '' && actions.includes(action);
  const targetInDetails = targetPorts.length === 1 && targetValid;
  const portLabel = (value: string) => labels.portLabels[value] ?? value;
  const invalidPort = (value: string) => labels.invalidPort.replace('{{port}}', value || '∅');

  return (
    <SheetContent side="right" showCloseButton={false} className="flex w-[500px] max-w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[500px]">
      <header className="shrink-0 border-b px-6 pb-5 pt-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3 text-xs">
            <span className="font-medium text-muted-foreground">{labels.edgeConnection}</span>
            {status ? <span className={statusClassName}>{status}</span> : null}
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={labels.closeEdge} onClick={onClose} disabled={pending}><X aria-hidden="true" className="h-4 w-4" /></Button>
        </div>
        <SheetTitle className="sr-only">{labels.edgeConfiguration}</SheetTitle>
        <SheetDescription className="sr-only">{labels.edgeConfigurationDescription}</SheetDescription>
        <dl className="space-y-2">
          <div><dt className="text-xs text-muted-foreground">{labels.sourceNode}</dt><dd className="mt-1 break-words text-xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere]">{sourceNode?.title || edge.sourceNodeId}</dd></div>
          <ArrowDown aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <div><dt className="text-xs text-muted-foreground">{labels.targetNode}</dt><dd className="mt-1 break-words text-xl font-semibold leading-tight tracking-tight [overflow-wrap:anywhere]">{targetNode?.title || edge.targetNodeId}</dd></div>
        </dl>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <fieldset disabled={pending} className="min-w-0 space-y-6">
          <section aria-label={labels.edgeTriggerCondition}>
            {editable ? <PortEditor label={labels.edgeTriggerCondition} value={sourcePort} ports={sourcePorts} labels={labels} onChange={onSourcePortChange} /> : <dl className="space-y-2"><dt className="text-sm font-medium">{labels.edgeTriggerCondition}</dt><dd className={sourceValid ? 'text-sm' : 'text-sm text-destructive'}>{sourceValid ? portLabel(sourcePort) : invalidPort(sourcePort)}</dd></dl>}
            {!targetInDetails ? <div className="mt-4">
              {editable ? <PortEditor label={labels.targetPort} value={targetPort} ports={targetPorts} labels={labels} onChange={onTargetPortChange} /> : <dl className="space-y-2"><dt className="text-sm font-medium">{labels.targetPort}</dt><dd className={targetValid ? 'text-sm' : 'text-sm text-destructive'}>{targetValid ? portLabel(targetPort) : invalidPort(targetPort)}</dd></dl>}
            </div> : null}
          </section>
          <section aria-label={labels.edgeAction} className="space-y-2">
            {editable && !(actions.length === 1 && actionValid) ? <EdgeActionEditor value={action} actions={actions} labels={labels} onChange={onActionChange} /> : <dl className="space-y-2">
              <dt className="text-sm font-medium">{labels.edgeAction}</dt>
              <dd className={actionValid ? 'text-sm' : 'text-sm text-destructive'}>{actionValid ? labels.edgeActionOptions[action] : action ? labels.invalidEdgeAction.replace('{{action}}', labels.edgeActionOptions[action]) : labels.selectEdgeAction}</dd>
            </dl>}
            {!editable && actions.length === 0 ? <p role="alert" className="text-xs text-destructive">{labels.noEdgeAction}</p> : null}
            {action ? <p className="text-xs leading-relaxed text-muted-foreground">{labels.edgeActionDescriptions[action]}</p> : null}
            {targetNode?.kind === 'join' ? <p className="text-xs leading-relaxed text-muted-foreground">{labels.edgeJoinGateHint}</p> : null}
          </section>
          {reworkLimit !== null ? <section aria-label={labels.reworkLimit} className="space-y-2">
            <label className="grid gap-2 text-sm font-medium">
              {labels.reworkLimit}
              {editable ? <input
                type="number"
                min={0}
                max={0xffff_ffff}
                step={1}
                className="h-10 w-full rounded-md border border-input bg-background px-3 font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                aria-describedby={`${id}-rework-hint${reworkLimitValid ? '' : ` ${id}-rework-error`}`}
                aria-invalid={!reworkLimitValid}
                value={reworkLimit}
                onChange={(event) => onReworkLimitChange(event.target.value)}
              /> : <span className="font-normal">{reworkLimit}</span>}
            </label>
            <p id={`${id}-rework-hint`} className="text-xs leading-relaxed text-muted-foreground">{labels.reworkLimitHint}</p>
            {!reworkLimitValid ? <p id={`${id}-rework-error`} role="alert" className="text-xs text-destructive">{labels.reworkLimitInvalid}</p> : null}
            {reworkCounters.map((counter) => <p key={counter.batchId} className="text-xs tabular-nums text-muted-foreground">{labels.reworkUsage
              .replace('{{batch}}', String(counter.batchId)).replace('{{used}}', String(counter.used))
              .replace('{{max}}', String(sourceNode!.reworkLimits[counter.sourcePort]))}</p>)}
          </section> : null}
          <section aria-label={labels.edgeDataTransfer} className="space-y-3">
            <h3 className="text-sm font-medium">{labels.edgeDataTransfer}</h3>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" checked={includeUpstreamResult} disabled={!editable || pending} onChange={(event) => onIncludeUpstreamResultChange(event.target.checked)} />
              <span className="leading-relaxed">{labels.includeUpstreamResult}</span>
            </label>
          </section>
        </fieldset>
        <details className="mt-6 border-t pt-4">
          <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{labels.edgeAdvancedFields}</summary>
          <dl className="mt-4 grid gap-3 text-xs">
            <div><dt className="text-muted-foreground">ID</dt><dd className="mt-1 break-all font-mono">{edge.edgeId}</dd></div>
            <div><dt className="text-muted-foreground">{labels.sourceNode}</dt><dd className="mt-1 break-all font-mono">{edge.sourceNodeId}</dd></div>
            <div><dt className="text-muted-foreground">{labels.targetNode}</dt><dd className="mt-1 break-all font-mono">{edge.targetNodeId}</dd></div>
            {targetInDetails ? <div><dt className="text-muted-foreground">{labels.targetPort}</dt><dd className="mt-1">{portLabel(targetPort)}</dd></div> : null}
          </dl>
        </details>
      </div>
      <footer className="shrink-0 border-t px-6 py-4">
        {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          {editable && !isNew ? <Button type="button" variant="ghost" size="icon" className="mr-auto h-9 w-9 text-muted-foreground hover:text-destructive" aria-label={labels.deleteEdge} title={labels.deleteEdge} disabled={pending || mutationDisabled} onClick={onDelete}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button> : null}
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>{editable ? labels.cancelEdge : labels.closeEdge}</Button>
          {editable ? <Button type="button" size="sm" disabled={pending || mutationDisabled || !canSave} onClick={onSave}>{labels.saveEdge}</Button> : null}
        </div>
      </footer>
    </SheetContent>
  );
}

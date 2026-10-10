import { useState } from 'react';
import type { TeamDesignFailure, TeamGraphEdgeAction, TeamGraphEdgeRecord, TeamGraphNodeRecord, TeamGraphPatchOperation, TeamGraphSnapshotRecord } from '@/types/team-design';
import type { TeamRunGraphCanvasLabels } from './TeamRunGraphCanvas';

function format(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.split(`{{${key}}}`).join(value), template);
}

export function PortEditor({ label, value, ports, labels, onChange }: {
  label: string;
  value: string;
  ports: readonly string[];
  labels: TeamRunGraphCanvasLabels;
  onChange: (port: string) => void;
}) {
  const invalid = !ports.includes(value);
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      {ports.length > 1 ? (
        <label className="grid gap-1">
          {label}
          <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={value} aria-invalid={invalid} onChange={(event) => onChange(event.target.value)}>
            {invalid ? <option value={value} disabled>{format(labels.invalidPort, { port: value || '∅' })}</option> : null}
            {ports.map((port) => <option key={port} value={port}>{labels.portLabels[port] ?? port}</option>)}
          </select>
        </label>
      ) : (
        <><span>{label}</span><span className="text-foreground">{ports.length === 1 ? labels.portLabels[ports[0]] ?? ports[0] : labels.noPort}</span></>
      )}
      {invalid ? <p role="alert" className="text-destructive">{format(ports.length === 1 ? labels.automaticPortRepair : labels.invalidPort, { port: value || '∅', replacement: ports[0] ? labels.portLabels[ports[0]] ?? ports[0] : '' })}</p> : null}
    </div>
  );
}

// Shared by the canvas editor and connection repair; neither owns the runtime's action rules.
// eslint-disable-next-line react-refresh/only-export-components
export function edgeActionCandidates(source: TeamGraphNodeRecord | null | undefined, sourcePort: string, target: TeamGraphNodeRecord | null | undefined): TeamGraphEdgeAction[] {
  if (!source || !target) return [];
  return (source.sourcePortActions[sourcePort] ?? []).filter((action) => target.kind !== 'join' || action === 'gate');
}

export function EdgeActionEditor({ value, actions, labels, onChange }: {
  value: TeamGraphEdgeAction | '';
  actions: TeamGraphEdgeAction[];
  labels: TeamRunGraphCanvasLabels;
  onChange: (action: TeamGraphEdgeAction) => void;
}) {
  const invalid = value !== '' && !actions.includes(value);
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {labels.edgeAction}
      <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={value} aria-invalid={invalid || actions.length === 0} onChange={(event) => onChange(event.target.value as TeamGraphEdgeAction)}>
        {!value ? <option value="" disabled>{labels.selectEdgeAction}</option> : null}
        {invalid ? <option value={value} disabled>{format(labels.invalidEdgeAction, { action: labels.edgeActionOptions[value] })}</option> : null}
        {actions.map((action) => <option key={action} value={action}>{labels.edgeActionOptions[action]}</option>)}
      </select>
      {actions.length === 0 ? <span role="alert" className="text-destructive">{labels.noEdgeAction}</span> : null}
    </label>
  );
}

export function TeamGraphPortRepair({ graph, runtimeError, labels, pending, edgePatch, onSave }: {
  graph: TeamGraphSnapshotRecord;
  runtimeError?: TeamDesignFailure | null;
  labels: TeamRunGraphCanvasLabels;
  pending: boolean;
  edgePatch: (edge: TeamGraphEdgeRecord) => Record<string, unknown>;
  onSave: (operations: TeamGraphPatchOperation[]) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, { sourcePort?: string; targetPort?: string; action?: TeamGraphEdgeAction; remove?: boolean }>>({});
  const [error, setError] = useState<string | null>(null);
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const repairs = graph.edges.map((edge) => {
    const source = nodes.get(edge.sourceNodeId);
    const target = nodes.get(edge.targetNodeId);
    const sourcePorts = source?.sourcePorts ?? [];
    const targetPorts = target?.targetPorts ?? [];
    const invalidAction = !edge.action || !edgeActionCandidates(source, edge.sourcePort ?? '', target).includes(edge.action);
    const invalid = !sourcePorts.includes(edge.sourcePort ?? '') || !targetPorts.includes(edge.targetPort ?? '') || invalidAction;
    const draft = drafts[edge.edgeId];
    const sourcePort = sourcePorts.length === 1 ? sourcePorts[0] : draft?.sourcePort ?? edge.sourcePort ?? '';
    const targetPort = targetPorts.length === 1 ? targetPorts[0] : draft?.targetPort ?? edge.targetPort ?? '';
    const unrepairable = sourcePorts.length === 0 || targetPorts.length === 0;
    const actions = edgeActionCandidates(source, sourcePort, target);
    const removable = unrepairable || invalidAction || actions.length === 0;
    return { edge, source, target, sourcePorts, targetPorts, actions, invalid, unrepairable, removable, remove: removable && draft?.remove === true, next: { ...edge, sourcePort, targetPort, action: draft?.action ?? edge.action } };
  });
  if (!repairs.some(({ invalid }) => invalid) && runtimeError?.errorCode !== 'invalid_edge_action') return null;
  const changes = repairs.filter(({ edge, next, remove }) => remove || edge.sourcePort !== next.sourcePort || edge.targetPort !== next.targetPort || edge.action !== next.action);
  const valid = changes.length > 0 && repairs.every(({ actions, sourcePorts, targetPorts, next, remove }) => remove || (sourcePorts.includes(next.sourcePort) && targetPorts.includes(next.targetPort) && next.action && actions.includes(next.action)));
  const update = (edgeId: string, value: (typeof drafts)[string]) => setDrafts((previous) => ({ ...previous, [edgeId]: { ...previous[edgeId], ...value } }));
  const save = async () => {
    if (!valid || pending) return;
    setError(null);
    try {
      await onSave(changes.map(({ edge, next, remove }): TeamGraphPatchOperation => remove
        ? { op: 'remove_edge', edgeId: edge.edgeId }
        : { op: 'replace_edge', edge: edgePatch(next) }));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : labels.saveGraphUnavailable); }
  };
  return (
    <section className="space-y-3 rounded border border-destructive/40 p-3" aria-label={labels.portRepairTitle}>
      <h3 className="text-sm font-medium">{labels.portRepairTitle}</h3>
      <p className="text-xs text-muted-foreground">{labels.portRepairHint}</p>
      <fieldset disabled={pending} className="space-y-3">
        {repairs.map(({ edge, source, target, sourcePorts, targetPorts, actions, next, unrepairable, removable, remove }) => (
          <div key={edge.edgeId} className="space-y-2 rounded border p-2">
            <p className="break-words text-xs">{source?.title ?? edge.sourceNodeId} → {target?.title ?? edge.targetNodeId} · {edge.edgeId}</p>
            <PortEditor label={labels.sourcePort} value={drafts[edge.edgeId]?.sourcePort ?? edge.sourcePort ?? ''} ports={sourcePorts} labels={labels} onChange={(sourcePort) => {
              const candidates = edgeActionCandidates(source, sourcePort, target);
              update(edge.edgeId, { sourcePort, ...(candidates.length === 1 ? { action: candidates[0] } : {}) });
            }} />
            <PortEditor label={labels.targetPort} value={drafts[edge.edgeId]?.targetPort ?? edge.targetPort ?? ''} ports={targetPorts} labels={labels} onChange={(targetPort) => update(edge.edgeId, { targetPort })} />
            <EdgeActionEditor value={next.action ?? ''} actions={actions} labels={labels} onChange={(action) => update(edge.edgeId, { action })} />
            {target?.kind === 'join' ? <p className="text-xs text-muted-foreground">{labels.edgeJoinGateHint}</p> : null}
            {removable ? <>
              {unrepairable ? <p role="alert" className="text-xs text-destructive">{labels.portRepairReconnect}</p> : null}
              <label className="flex items-center gap-2 text-xs text-destructive">
                <input type="checkbox" checked={remove} onChange={(event) => update(edge.edgeId, { remove: event.target.checked })} />
                {labels.portRepairDelete}
              </label>
            </> : null}
          </div>
        ))}
        <button type="button" className="rounded border px-3 py-1.5 text-xs font-medium" disabled={!valid} onClick={() => void save()}>{labels.savePortRepair}</button>
      </fieldset>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

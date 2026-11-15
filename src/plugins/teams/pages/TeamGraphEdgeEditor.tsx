import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sheet } from '@/components/ui/sheet';
import { createSessionTraceId, logSessionTrace, summarizeIdentifier, summarizeTeamGraphPort } from '@/lib/session-trace';
import { TeamEdgeInspector } from '@/plugins/teams/pages/TeamEdgeInspector';
import { edgeActionCandidates } from '@/plugins/teams/pages/TeamGraphPortRepair';
import type { TeamRunGraphCanvasLabels } from '@/plugins/teams/pages/TeamRunGraphCanvas';
import { isTeamReworkLimit, type TeamGraphEditBase, type TeamGraphEdgeAction, type TeamGraphEdgeRecord, type TeamGraphNodeRecord, type TeamGraphPatchOperation, type TeamGraphReworkProjection } from '@/types/team-design';

const EDGE_ACTIONS: TeamGraphEdgeAction[] = ['activate', 'rework', 'gate', 'finish'];
const NODE_KINDS = ['start', 'work', 'review', 'human_decision', 'script_review', 'join', 'end'];
const EMPTY_PORTS: readonly string[] = [];

type TeamGraphEdgeEditorProps = {
  edge: TeamGraphEdgeRecord;
  sourceNode: TeamGraphNodeRecord | null;
  targetNode: TeamGraphNodeRecord | null;
  runId: string;
  rework: TeamGraphReworkProjection;
  isNew: boolean;
  editable: boolean;
  mutationPending: boolean;
  mutationDisabled?: boolean;
  status: string;
  statusClassName: string;
  labels: TeamRunGraphCanvasLabels;
  edgePatch: (edge: TeamGraphEdgeRecord) => Record<string, unknown>;
  onPatchGraph: (operations: TeamGraphPatchOperation[], base?: TeamGraphEditBase) => Promise<boolean>;
  onSaved: () => void;
  onDeleted: () => void;
  onClose: () => void;
};

function summarizeEdge(edge: TeamGraphEdgeRecord, source: TeamGraphNodeRecord | null, runId: string) {
  return {
    runHash: summarizeIdentifier(runId).hash,
    edgeHash: summarizeIdentifier(edge.edgeId).hash,
    sourceNodeHash: summarizeIdentifier(edge.sourceNodeId).hash,
    targetNodeHash: summarizeIdentifier(edge.targetNodeId).hash,
    nodeKind: NODE_KINDS.find((kind) => kind === source?.kind) ?? 'unknown',
    canonicalSourcePort: summarizeTeamGraphPort(edge.sourcePort),
    action: EDGE_ACTIONS.find((action) => action === edge.action) ?? null,
  };
}

export function TeamGraphEdgeEditor({ edge, sourceNode, targetNode, runId, rework, isNew, editable, mutationPending, mutationDisabled = false, status, statusClassName, labels, edgePatch, onPatchGraph, onSaved, onDeleted, onClose }: TeamGraphEdgeEditorProps) {
  const [baseEdge] = useState(() => ({ sourcePort: edge.sourcePort, targetPort: edge.targetPort, action: edge.action, payload: edge.payload }));
  const [sourcePort, setSourcePort] = useState(edge.sourcePort ?? '');
  const [targetPort, setTargetPort] = useState(edge.targetPort ?? '');
  const [action, setAction] = useState<TeamGraphEdgeAction | ''>(edge.action ?? '');
  const [includeUpstreamResult, setIncludeUpstreamResult] = useState(edge.payload?.includeUpstreamResult !== false);
  const [reworkLimitDrafts, setReworkLimitDrafts] = useState<Record<string, { value: string; base: number | undefined }>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetimeRef = useRef<{ pending: boolean } | null>(null);
  const sourcePorts = sourceNode?.sourcePorts ?? EMPTY_PORTS;
  const targetPorts = targetNode?.targetPorts ?? EMPTY_PORTS;
  const patchSourcePort = sourcePorts.length === 1 ? sourcePorts[0] : sourcePort;
  const patchTargetPort = targetPorts.length === 1 ? targetPorts[0] : targetPort;
  const portsValid = sourcePorts.includes(patchSourcePort) && targetPorts.includes(patchTargetPort);
  const actions = edgeActionCandidates(sourceNode, patchSourcePort, targetNode);
  const actionValid = action !== '' && actions.includes(action);
  const budgetPort = editable ? patchSourcePort : edge.sourcePort ?? '';
  const hasReworkLimit = (editable ? action : edge.action) === 'rework'
    && sourceNode?.sourcePortActions[budgetPort]?.includes('rework') === true;
  const savedReworkLimit = sourceNode?.reworkLimits[budgetPort];
  const reworkLimit = hasReworkLimit
    ? editable && Object.hasOwn(reworkLimitDrafts, budgetPort) ? reworkLimitDrafts[budgetPort].value : savedReworkLimit === undefined ? '' : String(savedReworkLimit)
    : null;
  const reworkLimitValid = reworkLimit === null || reworkLimit.trim() !== '' && isTeamReworkLimit(Number(reworkLimit));
  const pending = saving || mutationPending;

  useLayoutEffect(() => {
    lifetimeRef.current = { pending: false };
    return () => { lifetimeRef.current = null; };
  }, []);

  useEffect(() => {
    logSessionTrace('renderer.team_run.edge.configuration.observed', createSessionTraceId('team-edge-config'), () => ({
      ...summarizeEdge(edge, sourceNode, runId),
      editable,
      canonicalSourcePortMissing: edge.sourcePort == null,
      uiSourcePort: summarizeTeamGraphPort(sourcePort),
      uiSourcePortInOptions: sourcePorts.includes(sourcePort),
      uiTargetPort: summarizeTeamGraphPort(targetPort),
      uiTargetPortInOptions: targetPorts.includes(targetPort),
      patchSourcePort: summarizeTeamGraphPort(patchSourcePort),
      patchTargetPort: summarizeTeamGraphPort(patchTargetPort),
      uiAction: EDGE_ACTIONS.find((candidate) => candidate === action) ?? null,
    }));
  }, [edge, sourceNode, runId, editable, sourcePort, targetPort, action, sourcePorts, targetPorts, patchSourcePort, patchTargetPort]);

  const submit = async (operations: TeamGraphPatchOperation[], onSuccess: () => void, base?: TeamGraphEditBase): Promise<void> => {
    const lifetime = lifetimeRef.current;
    if (!editable || mutationDisabled || !lifetime || lifetime.pending || mutationPending) return;
    lifetime.pending = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await onPatchGraph(operations, base);
      if (saved && lifetimeRef.current === lifetime) onSuccess();
    } catch (cause) {
      if (lifetimeRef.current === lifetime) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lifetime.pending = false;
      if (lifetimeRef.current === lifetime) setSaving(false);
    }
  };

  const saveEdge = async (): Promise<void> => {
    if (pending || mutationDisabled) return;
    if (!portsValid) { setError(labels.noPort); return; }
    if (!actionValid || !action) {
      setError(actions.length === 0 ? labels.noEdgeAction : labels.selectEdgeAction);
      return;
    }
    if (!reworkLimitValid) { setError(labels.reworkLimitInvalid); return; }
    const nextEdge = edgePatch({ ...edge, sourcePort: patchSourcePort, targetPort: patchTargetPort, action, payload: { includeUpstreamResult } });
    logSessionTrace('renderer.team_run.edge.patch.requested', createSessionTraceId('team-edge-patch'), () => ({
      ...summarizeEdge(edge, sourceNode, runId),
      operation: isNew ? 'add_edge' : 'replace_edge',
      canonicalSourcePortMissing: edge.sourcePort == null,
      uiSourcePort: summarizeTeamGraphPort(sourcePort),
      uiTargetPort: summarizeTeamGraphPort(targetPort),
      patchSourcePort: summarizeTeamGraphPort(patchSourcePort),
      patchTargetPort: summarizeTeamGraphPort(patchTargetPort),
      patchAction: EDGE_ACTIONS.find((candidate) => candidate === nextEdge.action) ?? null,
      sourcePortAutomaticallyCorrected: patchSourcePort !== sourcePort,
      targetPortAutomaticallyCorrected: patchTargetPort !== targetPort,
      canEdit: editable, isSaving: saving, mutationPending,
    }));
    const operations: TeamGraphPatchOperation[] = [{ op: isNew ? 'add_edge' : 'replace_edge', edge: nextEdge }];
    if (reworkLimit !== null) operations.push({ op: 'set_rework_limit', nodeId: edge.sourceNodeId, sourcePort: patchSourcePort, maxReworks: Number(reworkLimit) });
    await submit(operations, onSaved, {
      ...(isNew ? {} : { edge: { ...baseEdge, edgeId: edge.edgeId, sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, dependency: edge.dependency } }),
      ...(reworkLimit === null ? {} : { reworkLimit: { nodeId: edge.sourceNodeId, sourcePort: budgetPort,
        maxReworks: Object.hasOwn(reworkLimitDrafts, budgetPort) ? reworkLimitDrafts[budgetPort].base : savedReworkLimit } }),
    });
  };

  const close = () => {
    if (!pending && !lifetimeRef.current?.pending) onClose();
  };

  const deleteEdge = async (): Promise<void> => {
    if (isNew) { close(); return; }
    await submit([{ op: 'remove_edge', edgeId: edge.edgeId }], onDeleted);
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) close(); }}>
      <TeamEdgeInspector
        edge={edge}
        sourceNode={sourceNode}
        targetNode={targetNode}
        editable={editable}
        pending={pending}
        mutationDisabled={mutationDisabled}
        isNew={isNew}
        sourcePort={editable ? sourcePort : edge.sourcePort ?? ''}
        targetPort={editable ? targetPort : edge.targetPort ?? ''}
        action={editable ? action : edge.action ?? ''}
        actions={editable ? actions : edgeActionCandidates(sourceNode, edge.sourcePort ?? '', targetNode)}
        includeUpstreamResult={editable ? includeUpstreamResult : edge.payload?.includeUpstreamResult !== false}
        reworkLimit={reworkLimit}
        reworkLimitValid={reworkLimitValid}
        reworkCounters={rework.counters.filter((counter) => counter.sourceNodeId === edge.sourceNodeId && counter.sourcePort === budgetPort)}
        onReworkLimitChange={(value) => setReworkLimitDrafts((current) => ({ ...current, [budgetPort]: {
          value, base: Object.hasOwn(current, budgetPort) ? current[budgetPort].base : savedReworkLimit,
        } }))}
        canSave={portsValid && actionValid && reworkLimitValid}
        status={status}
        statusClassName={statusClassName}
        labels={labels}
        error={error}
        onSourcePortChange={(value) => {
          setSourcePort(value);
          const candidates = edgeActionCandidates(sourceNode, value, targetNode);
          if (candidates.length === 1) setAction(candidates[0]);
        }}
        onTargetPortChange={setTargetPort}
        onActionChange={setAction}
        onIncludeUpstreamResultChange={setIncludeUpstreamResult}
        onSave={() => { void saveEdge(); }}
        onDelete={() => { void deleteEdge(); }}
        onClose={close}
      />
    </Sheet>
  );
}

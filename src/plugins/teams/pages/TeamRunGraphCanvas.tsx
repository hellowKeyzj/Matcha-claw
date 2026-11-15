import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, CheckCircle2, Circle, CircleDot, CircleX, Clock3, Columns3, FileCode2, FileText, Flag, GitMerge, Hand, Maximize2, Minus, MousePointer2, Plus, Rows3, UserCheck, Zap, type LucideIcon } from 'lucide-react';
import { StableScrollArea } from '@/components/scroll';
import { createGraphEdgeRouter, createGraphLayoutEngine } from '@/plugins/teams/pages/team-graph-layout';
import { graphPortPosition, graphPositionForDirection } from '@/plugins/teams/pages/team-graph-geometry';
import { edgeActionCandidates, TeamGraphPortRepair } from '@/plugins/teams/pages/TeamGraphPortRepair';
import { TeamGraphNodeEditor } from '@/plugins/teams/pages/TeamGraphNodeEditor';
import { TeamGraphEdgeEditor } from '@/plugins/teams/pages/TeamGraphEdgeEditor';
import { TeamNodeDeliveries } from '@/plugins/teams/pages/TeamNodeDeliveries';
import { TeamFilePreview } from '@/plugins/teams/pages/TeamFilePreview';
import { TeamGraphNodeDetails } from '@/plugins/teams/pages/TeamGraphNodeDetails';
import { AgentAvatar } from '@/plugins/agents/presentation/AgentAvatar';
import { selectAgentsResource, useSubagentsStore } from '@/plugins/agents/stores/subagents';
import type { TeamArtifactRecord, RunWorkspaceProjection } from '@/types/team-workspace';
import type { TeamRunScope } from '@/types/desktop/runtime-address';
import type { GraphEdgeRoute, GraphLayoutDirection, GraphLayoutInput, GraphLayoutResult, GraphPoint } from '@/plugins/teams/pages/team-graph-layout-types';
import type { TeamDesignFailure, TeamGraphEditBase, TeamLayoutSave, TeamScriptReviewRule } from '@/types/team-design';
import type {
  TeamGraphEdgeAction,
  TeamGraphEdgeRecord,
  TeamGraphNodeRecord,
  TeamGraphPatchOperation,
  TeamGraphSnapshotRecord,
  TeamRoleBindingRecord,
  TeamWebhookAuthProjection,
} from '@/plugins/teams/services/team-runtime-client';

import type { TeamGraphCanvasNodeKind, TeamGraphCronPresetId, TeamGraphCronCustomKind, TeamGraphNodeTab, TeamGraphNodeDetailTab, TeamNodeDeliverySelection } from '@/plugins/teams/pages/team-node-editor-types';
const EMPTY_PORTS: readonly string[] = [];
const EMPTY_ROLES: TeamRoleBindingRecord[] = [];
const EMPTY_ARTIFACTS: TeamArtifactRecord[] = [];
const GraphPortRepair = memo(TeamGraphPortRepair);

export type TeamRunGraphCanvasLabels = {
  cancelEdge: string;
  closeEdge: string;
  edgeActionDescriptions: Record<TeamGraphEdgeAction, string>;
  cancelNode: string;
  closeNode: string;
  workMember: string;
  reviewMember: string;
  nodeKindLabels: Record<TeamGraphCanvasNodeKind, string>;
  expandPrompt: string;
  collapsePrompt: string;
  optionalOutput: string;
  scriptReviewRuleDescriptions: Record<TeamScriptReviewRule, string>;
  nodeIncomingConnections: string;
  nodeOutgoingConnections: string;
  nodeNoConnections: string;
  nodeDetails?: string;
  nodeDetailsDescription?: string;
  zoomIn?: string;
  zoomOut?: string;
  fitToView?: string;
  autoLayout?: string;
  layoutFailed?: string;
  layoutSaveFailed?: string;
  retryLayoutSave?: string;
  workflowCanvas: string;
  workflowEdges: string;
  nodePalette: string;
  nodePaletteTitle: string;
  nodeConfiguration: string;
  nodeConfigurationDescription: string;
  edgeConfiguration: string;
  edgeConfigurationDescription: string;
  configureHint: string;
  clickNodeToEdit: string;
  saveNode: string;
  saveEdge: string;
  deleteNode: string;
  deleteEdge: string;
  addEdge: string;
  sourceNode: string;
  targetNode: string;
  sourcePort: string;
  targetPort: string;
  portLabels: Record<string, string>;
  invalidPort: string;
  automaticPortRepair: string;
  noPort: string;
  portRepairTitle: string;
  portRepairHint: string;
  portRepairReconnect: string;
  portRepairDelete: string;
  savePortRepair: string;
  edgeAction: string;
  selectEdgeAction: string;
  invalidEdgeAction: string;
  noEdgeAction: string;
  edgeActionOptions: Record<TeamGraphEdgeAction, string>;
  includeUpstreamResult: string;
  edgeConnection: string;
  edgeTriggerCondition: string;
  edgeDataTransfer: string;
  edgeAdvancedFields: string;
  edgeJoinGateHint: string;
  edgeFallback: string;
  canvasMinimap: string;
  nodeTitle: string;
  reworkLimit: string;
  reworkLimitHint: string;
  reworkLimitInvalid: string;
  reworkUsage: string;
  reworkLimitExceeded: string;
  roleId: string;
  sessionRef: string;
  selectRole: string;
  selectSession: string;
  defaultSession: string;
  numberedSession: string;
  sessionUnavailable: string;
  createSession: string;
  creatingSession: string;
  retryCreateSession: string;
  createSessionFailed: string;
  noRoleBindings: string;
  invalidBinding: string;
  roleBindingRequired: string;
  prompt: string;
  workPrompt: string;
  reviewPrompt: string;
  outputArtifactKind: string;
  scriptReviewRule: string;
  scriptReviewRuleRequired: string;
  scriptReviewRules: Record<TeamScriptReviewRule, string>;
  joinConfigurationHint: string;
  endConfigurationHint: string;
  saveGraphUnavailable: string;
  runStatusLabel: string;
  graphStatusLabel: string;
  statusValues: Record<string, string>;
  teamRoles: string;
  connectToNode: string;
  connectFromNode: string;
  nodeCount: string;
  edgeCount: string;
  startTriggerMode: string;
  startTriggerManual: string;
  startTriggerWebhook: string;
  startTriggerCron: string;
  startWebhookPath: string;
  startWebhookPublicBaseUrl: string;
  startWebhookPublicBaseUrlHint: string;
  startWebhookPublicBaseUrlInvalid: string;
  startWebhookPublicUrl: string;
  startWebhookPublicUrlUnavailable: string;
  startWebhookPathPreview: string;
  startWebhookPathPreviewHint: string;
  startWebhookToken: string;
  startWebhookTokenUnavailable: string;
  copyWebhookToken: string;
  copiedWebhookToken: string;
  copyWebhookPublicUrl: string;
  copiedWebhookPublicUrl: string;
  startWebhookPathRequired: string;
  startWebhookPathInvalid: string;
  startCronSchedule: string;
  startCronSchedules: Record<TeamGraphCronPresetId, string>;
  startCronKeepExpression: string;
  startCronExpressionHint: string;
  startCronCustomKind: string;
  startCronCustomKinds: Record<TeamGraphCronCustomKind, string>;
  startCronCustomIntervalMinutes: string;
  startCronCustomIntervalHours: string;
  startCronCustomTime: string;
  startCronCustomValueRequired: string;
  startTriggerHint: string;
  nodePaletteDescriptions: Record<TeamGraphCanvasNodeKind, string>;
  defaultOutputPort: string;
  edges: string;
  noEdges: string;
};

export type TeamRunGraphCanvasProps = {
  teamId?: string;
  mode?: 'readonly' | 'editable';
  compact?: boolean;
  mutationPending?: boolean;
  mutationDisabled?: boolean;
  layoutSave?: TeamLayoutSave;
  onRetryLayoutSave?: () => Promise<void> | void;
  graph: TeamGraphSnapshotRecord | null | undefined;
  roles?: TeamRoleBindingRecord[];
  artifacts?: TeamArtifactRecord[];
  deliveriesLoading?: boolean;
  fileScope?: TeamRunScope;
  workspaceStatus?: RunWorkspaceProjection['status'];
  headerActions?: ReactNode;
  renderNodeApprovals?: (nodeId: string, onReveal: () => void) => ReactNode;
  emptyLabel: string;
  titleLabel: string;
  executorLabel: string;
  webhookAuth?: TeamWebhookAuthProjection | null;
  labels: TeamRunGraphCanvasLabels;
  onPatchGraph?: (operations: TeamGraphPatchOperation[], base?: TeamGraphEditBase) => Promise<void> | void;
  onCreateSession?: (roleId: string, requestId: string) => Promise<TeamRoleBindingRecord>;
  createSessionDisabledReason?: string;
  graphVersion?: string;
  runtimeError?: TeamDesignFailure | null;
  onRepairGraph?: (operations: TeamGraphPatchOperation[]) => Promise<void> | void;
};

type PositionedNode = GraphPoint & { nodeId: string };

type DragState = {
  nodeId: string;
  pointerId: number;
  pointerStartX: number;
  pointerStartY: number;
  pointerX: number;
  pointerY: number;
  offsetX: number;
  offsetY: number;
  canvasLeft: number;
  canvasTop: number;
  canvasRight: number;
  canvasBottom: number;
  currentX: number;
  currentY: number;
  draftPosition?: GraphPoint;
  panX: number;
  panY: number;
  frameTime: number | null;
  moved: boolean;
};

type CanvasPanState = GraphPoint & {
  pointerId: number | null;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  pendingPosition: GraphPoint | null;
  moved: boolean;
};

type ConnectionDraft = {
  sourceNodeId: string;
  sourcePort: string;
};

type ConfigurationSheet =
  | { kind: 'node'; nodeId: string; tab: TeamGraphNodeTab; selection?: TeamNodeDeliverySelection }
  | { kind: 'edge'; edgeId: string }
  | null;

type TeamGraphEdgeVisual = {
  markerId: string;
  stroke: string;
  labelClassName: string;
  dashArray?: string;
};

const NODE_WIDTH = 206;
const NODE_HEIGHT = 118;
const CANVAS_PADDING = 72;
const DRAG_THRESHOLD = 3;
const NODE_PALETTE: TeamGraphCanvasNodeKind[] = ['start', 'work', 'review', 'human_decision', 'script_review', 'join', 'end'];

const EDGE_VISUALS: Record<string, TeamGraphEdgeVisual> = {
  rework: {
    markerId: 'team-graph-arrow-rework',
    stroke: '#f43f5e',
    labelClassName: 'border-rose-300/70 bg-rose-50/95 text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/95 dark:text-rose-300',
    dashArray: '7 5',
  },
  failed: {
    markerId: 'team-graph-arrow-failed',
    stroke: '#f43f5e',
    labelClassName: 'border-rose-300/70 bg-rose-50/95 text-rose-700 dark:border-rose-800/70 dark:bg-rose-950/95 dark:text-rose-300',
    dashArray: '7 5',
  },
  rejected: {
    markerId: 'team-graph-arrow-rejected',
    stroke: '#f97316',
    labelClassName: 'border-orange-300/70 bg-orange-50/95 text-orange-700 dark:border-orange-800/70 dark:bg-orange-950/95 dark:text-orange-300',
    dashArray: '7 5',
  },
  aborted: {
    markerId: 'team-graph-arrow-aborted',
    stroke: '#94a3b8',
    labelClassName: 'border-slate-300/70 bg-slate-50/95 text-slate-500 dark:border-slate-700/70 dark:bg-slate-950/95 dark:text-slate-400',
    dashArray: '5 6',
  },
};

const FALLBACK_EDGE_VISUAL: TeamGraphEdgeVisual = {
  markerId: 'team-graph-arrow-default',
  stroke: 'currentColor',
  labelClassName: 'border-border bg-background/95 text-muted-foreground',
};

const NODE_ICONS: Record<TeamGraphCanvasNodeKind, LucideIcon> = {
  start: Zap,
  work: Bot,
  review: CheckCircle2,
  human_decision: UserCheck,
  script_review: FileCode2,
  join: GitMerge,
  end: Flag,
};

function renderStatusIcon(status: string | undefined): ReactNode {
  const className = 'h-[13px] w-[13px] shrink-0';
  switch (status) {
    case 'running':
    case 'queued':
    case 'ready':
      return <CircleDot aria-hidden="true" className={className} strokeWidth={1.65} />;
    case 'completed':
    case 'passed':
      return <CheckCircle2 aria-hidden="true" className={className} strokeWidth={1.65} />;
    case 'failed':
      return <CircleX aria-hidden="true" className={className} strokeWidth={1.65} />;
    case 'waiting_for_user':
    case 'waiting':
      return <Clock3 aria-hidden="true" className={className} strokeWidth={1.65} />;
    default:
      return <Circle aria-hidden="true" className={className} strokeWidth={1.65} />;
  }
}

function statusTextTone(status: string | undefined): string {
  switch (status) {
    case 'running':
    case 'queued':
      return 'text-primary';
    case 'completed':
    case 'passed':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'failed':
      return 'text-destructive';
    case 'waiting_for_user':
    case 'waiting':
      return 'text-amber-700 dark:text-amber-300';
    default:
      return 'text-muted-foreground';
  }
}

function statusLabel(status: string | undefined, labels: TeamRunGraphCanvasLabels): string {
  if (!status) return '';
  return labels.statusValues[status] ?? status.replace(/_/g, ' ');
}

function edgeVisualForEdge(edge: TeamGraphEdgeRecord): TeamGraphEdgeVisual {
  const sourcePort = edge.sourcePort?.trim();
  if (sourcePort && EDGE_VISUALS[sourcePort]) return EDGE_VISUALS[sourcePort];
  const status = edge.status?.trim();
  if (status && EDGE_VISUALS[status]) return EDGE_VISUALS[status];
  return FALLBACK_EDGE_VISUAL;
}

function edgeDisplayLabel(edge: TeamGraphEdgeRecord): string {
  return edge.sourcePort || '';
}

type TeamGraphEdgeProps = {
  edge: TeamGraphEdgeRecord;
  route: GraphEdgeRoute;
  sourceTitle: string;
  targetTitle: string;
  selected: boolean;
  hovered: boolean;
  canvasId: string;
  onOpen: (edgeId: string) => void;
  onHover: (edgeId: string | null) => void;
  onLeave: (edgeId: string) => void;
};

const TeamGraphEdge = memo(function TeamGraphEdge({ edge, route, sourceTitle, targetTitle, selected, hovered, canvasId, onOpen, onHover, onLeave }: TeamGraphEdgeProps) {
  const path = useMemo(() => route.points.map((point, index, points) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const next = points[index + 1];
    if (!next) return `L ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const incoming = Math.hypot(point.x - previous.x, point.y - previous.y);
    const outgoing = Math.hypot(next.x - point.x, next.y - point.y);
    const radius = Math.min(12, incoming / 2, outgoing / 2);
    return `L ${point.x + (previous.x - point.x) * radius / incoming} ${point.y + (previous.y - point.y) * radius / incoming} Q ${point.x} ${point.y} ${point.x + (next.x - point.x) * radius / outgoing} ${point.y + (next.y - point.y) * radius / outgoing}`;
  }).join(' '), [route]);
  const edgeVisual = edgeVisualForEdge(edge);
  const edgeLabel = edgeDisplayLabel(edge);
  const shouldShowEdgeLabel = Boolean(edgeLabel && (selected || hovered));
  return (
    <g onMouseEnter={() => onHover(edge.edgeId)} onMouseLeave={() => onLeave(edge.edgeId)}>
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth="14"
        strokeLinecap="round"
        className="cursor-pointer"
        role="button"
        tabIndex={0}
        aria-label={`${sourceTitle} → ${targetTitle}: ${edge.sourcePort ?? edge.action ?? ''}`}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          onOpen(edge.edgeId);
        }}
        onFocus={() => onHover(edge.edgeId)}
        onBlur={() => onHover(null)}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(edge.edgeId);
        }}
      />
      <path
        d={path}
        fill="none"
        stroke={edgeVisual.stroke}
        strokeWidth={selected ? '2' : '1.4'}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={edgeVisual.dashArray}
        markerEnd={`url(#${canvasId}-${edgeVisual.markerId})`}
        className="pointer-events-none"
      />
      {shouldShowEdgeLabel ? (
        <foreignObject x={route.label.x - 54} y={route.label.y - 12} width="108" height="26">
          <button
            type="button"
            aria-label={edgeLabel}
            className={`w-full truncate rounded-full border px-2 py-1 text-center text-[10px] shadow-sm ${edgeVisual.labelClassName}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(edge.edgeId);
            }}
          >
            {edgeLabel}
          </button>
        </foreignObject>
      ) : null}
    </g>
  );
});

function useGraphLayout(scope: string, input: GraphLayoutInput, measured: boolean, dragging: boolean) {
  const [layout, setLayout] = useState<{ scope: string; shapeKey: string; result: GraphLayoutResult } | null>(null);
  const [status, setStatus] = useState<'idle' | 'pending' | 'failed'>('idle');
  const shapeKey = useMemo(() => JSON.stringify([input.direction, input.nodes, input.edges]), [input]);
  const contextRef = useRef({ scope, input, dragging, shapeKey });
  const requestRef = useRef<((arrange: boolean) => Promise<GraphLayoutResult | null>) | null>(null);
  const acceptRef = useRef<((result: GraphLayoutResult) => void) | null>(null);

  useLayoutEffect(() => {
    contextRef.current = { scope, input, dragging, shapeKey };
  }, [scope, input, dragging, shapeKey]);

  useEffect(() => {
    const engine = createGraphLayoutEngine();
    let disposed = false;
    let running = false;
    let previous: typeof layout = null;
    type Request = { arrange: boolean; context: typeof contextRef.current; resolve: (result: GraphLayoutResult | null) => void };
    let pending: Request | null = null;
    const drain = async () => {
      if (running) return;
      running = true;
      while (pending && !disposed) {
        const request = pending;
        pending = null;
        const { context } = request;
        if (context !== contextRef.current) {
          request.resolve(null);
          continue;
        }
        try {
          const result = await engine.layout(request.arrange
            ? { ...context.input, fixedPositions: {}, previousPositions: undefined }
            : { ...context.input, previousPositions: previous?.scope === context.scope
              ? { ...previous.result.positions, ...context.input.fixedPositions }
              : undefined });
          if (disposed || context !== contextRef.current || context.dragging) {
            request.resolve(null);
            continue;
          }
          if (!request.arrange) {
            previous = { scope: context.scope, shapeKey: context.shapeKey, result };
            setLayout({ scope: context.scope, shapeKey: context.shapeKey, result });
          }
          setStatus('idle');
          request.resolve(result);
        } catch (error) {
          if (!disposed && context === contextRef.current) {
            console.error('[team-graph:layout]', error);
            setStatus('failed');
          }
          request.resolve(null);
        }
      }
      running = false;
    };
    acceptRef.current = (result) => {
      const context = contextRef.current;
      previous = { scope: context.scope, shapeKey: context.shapeKey, result };
      setLayout({ scope: context.scope, shapeKey: context.shapeKey, result });
    };
    requestRef.current = (arrange) => new Promise((resolve) => {
      pending?.resolve(null);
      pending = null;
      const context = { ...contextRef.current };
      contextRef.current = context;
      if (!arrange && previous?.scope === context.scope && previous.shapeKey === context.shapeKey) {
        setStatus('idle');
        resolve(null);
        return;
      }
      pending = { arrange, context, resolve };
      setStatus('pending');
      void drain();
    });
    return () => {
      disposed = true;
      pending?.resolve(null);
      pending = null;
      requestRef.current = null;
      acceptRef.current = null;
      engine.dispose();
    };
  }, []);

  const requestLayout = useCallback((arrange = false) => requestRef.current?.(arrange) ?? Promise.resolve(null), []);
  useEffect(() => {
    if (measured && !dragging) void requestLayout();
  }, [scope, input, measured, dragging, requestLayout]);

  const acceptLayout = useCallback((result: GraphLayoutResult) => acceptRef.current?.(result), []);
  return { layout: layout?.scope === scope ? layout : null, shapeKey, status, requestLayout, acceptLayout };
}

type NodePaletteControlProps = {
  labels: Pick<TeamRunGraphCanvasLabels, 'nodePalette' | 'nodeKindLabels' | 'nodePaletteDescriptions'>;
  isOpen: boolean;
  isSaving: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAddNode: (kind: TeamGraphCanvasNodeKind) => void | Promise<void>;
};

const NodePaletteControl = memo(function NodePaletteControl({ labels, isOpen, isSaving, onToggle, onClose, onAddNode }: NodePaletteControlProps) {
  return (
    <div className="pointer-events-none absolute left-4 top-4 z-30">
      <div
        className="pointer-events-auto"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onToggle}
          disabled={isSaving}
          aria-expanded={isOpen}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          <span>{labels.nodePalette}</span>
        </button>
        {isOpen ? (
          <div className="mt-2 w-[min(19rem,calc(100vw-4rem))] rounded-xl border border-border bg-card p-1.5 shadow-lg">
            <div className="grid gap-0.5">
              {NODE_PALETTE.map((kind) => {
                const PaletteIcon = NODE_ICONS[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    title={labels.nodePaletteDescriptions[kind]}
                    className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => { void onAddNode(kind); }}
                    disabled={isSaving}
                  >
                    <PaletteIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{labels.nodeKindLabels[kind]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function graphPatchRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function graphPatchNode(node: TeamGraphNodeRecord): Record<string, unknown> {
  const kind = visualKindForNodeKind(node.kind);
  return graphPatchRecord({
    nodeId: node.nodeId,
    kind,
    title: node.title?.trim() || node.nodeId,
    roleId: kind === 'work' || kind === 'review' ? node.roleId : undefined,
    taskId: kind === 'work' ? node.taskId : undefined,
    reworkLimits: node.reworkLimits,
    config: kind === 'start' || kind === 'work' || kind === 'review' || kind === 'human_decision' || kind === 'script_review' ? node.config : undefined,
  });
}

function graphPatchEdge(edge: TeamGraphEdgeRecord): Record<string, unknown> {
  return graphPatchRecord({
    edgeId: edge.edgeId,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    sourcePort: edge.sourcePort,
    targetPort: edge.targetPort,
    action: edge.action,
    payload: edge.payload,
    dependency: edge.dependency,
  });
}

function createDraftGraphId(kind: 'node' | 'edge', scope: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  const rawId = cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `draft-${kind}:${scope}:${rawId}`;
}

function createProjectionEdgeId(): string {
  return createDraftGraphId('edge', 'projection');
}

function createProjectionNodeId(kind: TeamGraphCanvasNodeKind): string {
  return createDraftGraphId('node', kind);
}

function hasRecordEntries(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

const EMPTY_TEAM_GRAPH: TeamGraphSnapshotRecord = {
  layout: { nodePositions: {} },
  nodes: [],
  edges: [],
  rework: { counters: [], blocked: [] },
  status: 'draft',
};

type CanvasViewport = {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
};

type NodeSize = { width: number; height: number };

function readCanvasViewport(element: HTMLDivElement | null): CanvasViewport | null {
  if (!element) return null;
  return {
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
  };
}

function nodeRect(position: { x: number; y: number }, size: NodeSize, padding = 0): { left: number; top: number; right: number; bottom: number } {
  return {
    left: position.x - padding,
    top: position.y - padding,
    right: position.x + size.width + padding,
    bottom: position.y + size.height + padding,
  };
}

function rectsOverlap(
  left: { left: number; top: number; right: number; bottom: number },
  right: { left: number; top: number; right: number; bottom: number },
): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function nextNodePosition(
  nodes: readonly PositionedNode[],
  nodeSizes: Readonly<Record<string, NodeSize>>,
  viewport: CanvasViewport | null,
): { x: number; y: number } {
  const newNodeSize = { width: NODE_WIDTH, height: NODE_HEIGHT };
  const visibleLeft = viewport?.scrollLeft ?? 0;
  const visibleTop = viewport?.scrollTop ?? 0;
  const visibleWidth = viewport?.clientWidth ?? NODE_WIDTH + CANVAS_PADDING * 2;
  const visibleHeight = viewport?.clientHeight ?? NODE_HEIGHT + CANVAS_PADDING * 2;
  const minX = visibleLeft + CANVAS_PADDING / 2;
  const minY = visibleTop + CANVAS_PADDING / 2;
  const maxX = Math.max(minX, visibleLeft + visibleWidth - newNodeSize.width - CANVAS_PADDING / 2);
  const maxY = Math.max(minY, visibleTop + visibleHeight - newNodeSize.height - CANVAS_PADDING / 2);
  const centerX = visibleLeft + Math.max(0, (visibleWidth - newNodeSize.width) / 2);
  const start = {
    x: Math.min(maxX, Math.max(minX, centerX)),
    y: minY,
  };
  const occupiedRects = nodes.map((node) => nodeRect(
    { x: node.x, y: node.y },
    Object.hasOwn(nodeSizes, node.nodeId) ? nodeSizes[node.nodeId] : newNodeSize,
    CANVAS_PADDING / 4,
  ));
  const maxNodeWidth = Math.max(newNodeSize.width, ...Object.values(nodeSizes).map((size) => size.width));
  const maxNodeHeight = Math.max(newNodeSize.height, ...Object.values(nodeSizes).map((size) => size.height));
  const stepX = maxNodeWidth + CANVAS_PADDING / 2;
  const stepY = maxNodeHeight + CANVAS_PADDING / 2;
  const columnOffsets = [0, -1, 1, -2, 2, -3, 3];

  for (let row = 0; row < 8; row += 1) {
    for (const columnOffset of columnOffsets) {
      const candidate = {
        x: Math.min(maxX, Math.max(minX, start.x + columnOffset * stepX)),
        y: Math.min(maxY, start.y + row * stepY),
      };
      const candidateRect = nodeRect(candidate, newNodeSize);
      if (!occupiedRects.some((rect) => rectsOverlap(candidateRect, rect))) {
        return candidate;
      }
    }
  }

  if (nodes.length === 0) return start;
  const bottom = Math.max(...nodes.map((node) => node.y + (Object.hasOwn(nodeSizes, node.nodeId) ? nodeSizes[node.nodeId].height : NODE_HEIGHT)));
  return { x: start.x, y: Math.max(minY, bottom + CANVAS_PADDING / 2) };
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.split(`{{${key}}}`).join(String(value)), template);
}

function visualKindForNodeKind(kind: string | undefined): TeamGraphCanvasNodeKind {
  switch (kind) {
    case 'start':
      return 'start';
    case 'review':
      return 'review';
    case 'human_decision':
      return 'human_decision';
    case 'script_review':
      return 'script_review';
    case 'join':
      return 'join';
    case 'end':
      return 'end';
    default:
      return 'work';
  }
}

type TeamGraphNodeEvents = {
  register: (nodeId: string, element: HTMLDivElement | null) => void;
  open: (nodeId: string, keyboard?: boolean) => void;
  openOutput: (nodeId: string, selection?: TeamNodeDeliverySelection) => void;
  pointerDown: (event: PointerEvent<HTMLDivElement>, nodeId: string) => void;
  pointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  pointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  pointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  startConnection: (nodeId: string, sourcePort: string) => void;
  finishConnection: (nodeId: string) => void;
};

type TeamGraphNodeCardProps = {
  node: TeamGraphNodeRecord;
  x: number;
  y: number;
  geometry: GraphLayoutInput['nodes'][number];
  direction: GraphLayoutDirection;
  visible: boolean;
  selected: boolean;
  editable: boolean;
  canConnectTo: boolean;
  connectionTargetActive: boolean;
  activeSourcePort: string | null;
  labels: TeamRunGraphCanvasLabels;
  executorLabel: string;
  binding?: TeamRoleBindingRecord;
  artifacts: TeamArtifactRecord[];
  events: TeamGraphNodeEvents;
};

const TeamGraphNodeCard = memo(function TeamGraphNodeCard({ node, x, y, geometry, direction, visible, selected, editable, canConnectTo, connectionTargetActive, activeSourcePort, labels, executorLabel, binding, artifacts, events }: TeamGraphNodeCardProps) {
  const { t } = useTranslation('teams');
  const kind = visualKindForNodeKind(node.kind);
  const NodeIcon = NODE_ICONS[kind];
  const waitingForApproval = kind === 'human_decision' && (node.status === 'waiting_for_user' || node.status === 'waiting');
  const agent = useSubagentsStore((state) => binding ? selectAgentsResource(state, binding.endpointRef).data?.find((entry) => entry.id === binding.agentId) : undefined);
  const agentName = agent?.name || agent?.identity?.name || binding?.agentId;
  const outputEntries = useMemo(() => artifacts.flatMap<{ label: string; selection: TeamNodeDeliverySelection }>((artifact) => artifact.files.length > 0
    ? artifact.files.map((filePath) => ({ label: filePath.split(/[\\/]/).pop() || filePath, selection: { artifactId: artifact.artifactId, filePath } }))
    : [{ label: artifact.title, selection: { artifactId: artifact.artifactId } }]), [artifacts]);
  const connectionSources = node.sourcePorts ?? EMPTY_PORTS;
  const isCompactStart = kind === 'start' && outputEntries.length === 0;
  const inputPort = graphPortPosition(geometry, direction);
  const register = useCallback((element: HTMLDivElement | null) => events.register(node.nodeId, element), [events, node.nodeId]);
  return (
    <div
      ref={register}
      data-node-id={node.nodeId}
      role="button"
      tabIndex={0}
      aria-label={`${node.title ?? node.nodeId}: ${t('workspace.config')}${isCompactStart && node.status ? `, ${statusLabel(node.status, labels)}` : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        events.open(node.nodeId);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          events.open(node.nodeId, true);
        }
      }}
      onPointerDown={(event) => events.pointerDown(event, node.nodeId)}
      onPointerMove={events.pointerMove}
      onPointerUp={events.pointerUp}
      onPointerCancel={events.pointerCancel}
      onLostPointerCapture={events.pointerCancel}
      className={`group/node absolute select-none ${editable ? 'cursor-grab active:cursor-grabbing touch-none' : 'cursor-pointer'} text-left text-foreground transition-[border-color,box-shadow] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isCompactStart ? 'flex items-center rounded-[10px] border border-border bg-card hover:border-muted-foreground/50 dark:bg-muted' : `rounded-[14px] border ${waitingForApproval ? 'border-amber-600/55 bg-amber-50/80 shadow-[0_3px_9px_rgb(24_35_51_/_0.03)] hover:border-amber-600/80 dark:border-amber-300/35 dark:bg-amber-300/[0.05] dark:shadow-[0_4px_10px_rgb(0_0_0_/_0.07)] dark:hover:border-amber-300/60' : kind === 'end' ? 'border-dashed border-border bg-transparent text-muted-foreground shadow-none hover:border-muted-foreground/50' : 'border-border bg-card shadow-[0_3px_9px_rgb(24_35_51_/_0.03)] hover:border-muted-foreground/50 dark:bg-muted dark:shadow-[0_4px_10px_rgb(0_0_0_/_0.07)]'}`} ${selected ? 'ring-2 ring-ring/30 ring-offset-2 ring-offset-background' : ''}`}
      style={{ left: x, top: y, width: isCompactStart || kind === 'end' ? 110 : NODE_WIDTH, minHeight: isCompactStart ? 48 : kind === 'end' ? 96 : undefined, visibility: visible ? 'visible' : 'hidden' }}
    >
      {editable ? <div className="pointer-events-none absolute -inset-px z-20">
      {canConnectTo ? <button
        type="button"
        aria-label={formatTemplate(labels.connectToNode, { title: node.title ?? node.nodeId })}
        className="pointer-events-auto group/port absolute grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ left: inputPort.x, top: inputPort.y }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); events.finishConnection(node.nodeId); }}
      >
        <span className={`h-2 w-2 rounded-full border transition-[opacity,box-shadow] motion-reduce:transition-none group-hover/node:opacity-100 group-focus-within/node:opacity-100 group-hover/port:ring-4 group-hover/port:ring-ring/10 group-focus-visible/port:ring-4 group-focus-visible/port:ring-ring/10 ${connectionTargetActive ? 'border-primary bg-primary opacity-100' : 'border-muted-foreground/50 bg-card opacity-0'}`} />
      </button> : null}
      {connectionSources.map((source) => {
        const port = graphPortPosition(geometry, direction, source);
        return <button
          key={source}
          type="button"
          aria-label={`${formatTemplate(labels.connectFromNode, { title: node.title ?? node.nodeId })}: ${labels.portLabels[source] ?? source}`}
          title={labels.portLabels[source] ?? source}
          className="pointer-events-auto group/port absolute grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ left: port.x, top: port.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); events.startConnection(node.nodeId, source); }}
        >
          <span className={`h-2 w-2 rounded-full border transition-[opacity,box-shadow] motion-reduce:transition-none group-hover/node:opacity-100 group-focus-within/node:opacity-100 group-hover/port:ring-4 group-hover/port:ring-ring/10 group-focus-visible/port:ring-4 group-focus-visible/port:ring-ring/10 ${activeSourcePort === source ? 'border-primary bg-primary opacity-100' : 'border-muted-foreground/50 bg-card opacity-0'}`} />
        </button>;
      })}
      </div> : null}
      {isCompactStart ? <div className="flex min-w-0 items-center gap-2 px-3 py-3">
        <span className={`grid h-5 w-5 shrink-0 place-items-center ${statusTextTone(node.status)}`} title={statusLabel(node.status, labels)}>
          {node.status === 'completed' || node.status === 'passed' ? <Check aria-hidden="true" className="h-[13px] w-[13px]" strokeWidth={1.65} /> : node.status ? renderStatusIcon(node.status) : <NodeIcon aria-hidden="true" className="h-[13px] w-[13px]" strokeWidth={1.65} />}
        </span>
        <span className="min-w-0 break-words text-[12px] font-medium leading-[18px]">{node.title ?? node.nodeId}</span>
      </div> : <div className={kind === 'end' ? 'p-[14px]' : 'px-4 pb-[13px] pt-[15px]'}>
        <div className={`flex min-w-0 items-center justify-between gap-2 ${kind === 'end' ? 'leading-[14px]' : 'leading-4'}`}>
          <span className="flex min-w-0 items-center gap-[7px] text-[10px] text-muted-foreground"><NodeIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.65} /><span className="truncate">{labels.nodeKindLabels[kind]}</span></span>
          {node.status && kind !== 'end' ? <span className={`flex max-w-[60%] shrink-0 items-center gap-[5px] whitespace-nowrap text-[11px] ${statusTextTone(node.status)}`} title={statusLabel(node.status, labels)}>
            {renderStatusIcon(node.status)}
            <span className="truncate">{statusLabel(node.status, labels)}</span>
          </span> : null}
        </div>
        <div className={`mt-3 break-words font-[550] tracking-[0.2px] ${kind === 'end' ? 'text-[12px] leading-[18px] text-muted-foreground' : 'text-[14px] leading-[21px]'}`}>{node.title ?? node.nodeId}</div>
        {kind === 'end' && node.status ? <div className={`mt-[5px] flex items-start gap-[5px] text-[10px] leading-4 ${statusTextTone(node.status)}`}>
          {renderStatusIcon(node.status)}
          <span className="min-w-0 break-words">{statusLabel(node.status, labels)}</span>
        </div> : null}
        {binding && agentName ? <div className="mt-[5px] flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground" aria-label={executorLabel} title={agentName}>
          <AgentAvatar agentId={binding.agentId} agentName={agentName} avatarSeed={agent?.avatarSeed} avatarStyle={agent?.avatarStyle} alt="" className="h-4 w-4" />
          <span className="min-w-0 truncate">{agentName}</span>
        </div> : node.roleId ? <p className="mt-[5px] text-[11px] leading-4 text-muted-foreground" title={node.roleId}>{labels.sessionUnavailable}</p> : null}
      </div>}
      {outputEntries.length > 0 ? <div className={`overflow-hidden rounded-b-[13px] [&>button]:border-t ${waitingForApproval ? '[&>button]:border-amber-600/20 dark:[&>button]:border-amber-300/15' : '[&>button]:border-border/70'}`}>
        {outputEntries.slice(0, 3).map(({ label, selection }) => <button
          key={JSON.stringify([selection.artifactId, selection.filePath])}
          type="button"
          aria-label={`${t('workspace.openOutput')}: ${selection.filePath ?? label}`}
          title={selection.filePath ?? label}
          className="flex h-[39px] w-full items-center gap-[7px] px-[14px] text-left text-[11px] leading-4 text-foreground/80 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-background/25"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); events.openOutput(node.nodeId, selection); }}
        >
          <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.65} />
          <span className="truncate">{label}</span>
        </button>)}
        {outputEntries.length > 3 ? <button
          type="button"
          className="h-[39px] w-full px-[14px] text-left text-[11px] leading-4 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:bg-background/25"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); events.openOutput(node.nodeId); }}
        >{t('workspace.moreArtifacts', { count: outputEntries.length - 3 })}</button> : null}
      </div> : null}
    </div>
  );
});

export const TeamRunGraphCanvas = memo(function TeamRunGraphCanvas({
  teamId,
  graph,
  roles = EMPTY_ROLES,
  artifacts = EMPTY_ARTIFACTS,
  deliveriesLoading = false,
  fileScope,
  workspaceStatus,
  headerActions,
  renderNodeApprovals,
  emptyLabel,
  titleLabel,
  executorLabel,
  webhookAuth,
  labels,
  onPatchGraph,
  layoutSave,
  onRetryLayoutSave,
  onCreateSession,
  createSessionDisabledReason,
  graphVersion,
  runtimeError,
  onRepairGraph,
  mode = onPatchGraph ? 'editable' : 'readonly',
  compact = false,
  mutationPending = false,
  mutationDisabled = false,
}: TeamRunGraphCanvasProps) {
  const { t } = useTranslation('teams');
  const graphRunId = graph?.runId ?? '';
  const runArtifacts = useMemo(() => artifacts.filter((artifact) => artifact.runId === graphRunId), [artifacts, graphRunId]);
  const deliveriesByNode = useMemo(() => {
    const byNode = new Map<string, TeamArtifactRecord[]>();
    for (const artifact of runArtifacts) {
      const records = byNode.get(artifact.nodeId) ?? [];
      records.push(artifact);
      byNode.set(artifact.nodeId, records);
    }
    return byNode;
  }, [runArtifacts]);
  const canEdit = mode === 'editable' && Boolean(onPatchGraph);
  const repairGraph = onRepairGraph ?? (canEdit ? onPatchGraph : undefined);
  const canvasId = useId();
  const [direction, setDirection] = useState<GraphLayoutDirection>('vertical');
  const [zoom, setZoom] = useState<number | null>(null);
  const [canvasTool, setCanvasTool] = useState<'select' | 'pan'>('select');
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configurationSheet, setConfigurationSheet] = useState<ConfigurationSheet>(null);
  const [newNode, setNewNode] = useState<{ node: TeamGraphNodeRecord; position: GraphPoint } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [newEdge, setNewEdge] = useState<TeamGraphEdgeRecord | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isArranging, setIsArranging] = useState(false);
  const [layoutSubmitFailed, setLayoutSubmitFailed] = useState(false);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [isNodePaletteOpen, setNodePaletteOpen] = useState(false);
  const [draftPositions, setDraftPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const canvasPanRef = useRef<CanvasPanState | null>(null);
  const canvasPanFrameRef = useRef<number | null>(null);
  const layoutEditRevisionRef = useRef(0);
  const layoutLifetimeRef = useRef<object | null>(null);
  const [nodeSizes, setNodeSizes] = useState<Record<string, NodeSize>>({});
  const canvasScrollerRef = useRef<HTMLDivElement | null>(null);
  const canvasSurfaceRef = useRef<HTMLDivElement | null>(null);
  const nodeElementsRef = useRef<Record<string, HTMLDivElement | null>>(Object.create(null));
  const suppressClickNodeIdRef = useRef<string | null>(null);

  const effectiveGraph = useMemo<TeamGraphSnapshotRecord>(() => graph ?? EMPTY_TEAM_GRAPH, [graph]);
  const measurementScope = JSON.stringify([graphRunId, effectiveGraph.graphId]);
  const layoutScope = JSON.stringify([graphRunId, effectiveGraph.graphId, direction]);
  const layoutScopeRef = useRef(layoutScope);
  const measurementScopeRef = useRef(measurementScope);
  const [arrangedView, setArrangedView] = useState<{ scope: string; positions: Record<string, GraphPoint> } | null>(null);
  const draftScope = layoutScopeRef.current;
  const activeDrafts = useMemo(() => draftScope === layoutScope ? draftPositions : {}, [draftScope, layoutScope, draftPositions]);
  const viewPositions = !canEdit && arrangedView?.scope === layoutScope ? arrangedView.positions : undefined;
  const savedPositions = useMemo(() => Object.fromEntries(Object.entries({ ...effectiveGraph.layout?.nodePositions, ...layoutSave?.positions })
    .map(([nodeId, position]) => [nodeId, graphPositionForDirection(position, direction)])), [effectiveGraph.layout?.nodePositions, layoutSave?.positions, direction]);
  const geometryKey = useMemo(() => {
    const sourcePortsByNode = new Map(effectiveGraph.nodes.map((node) => [node.nodeId, new Set(node.sourcePorts)]));
    for (const edge of effectiveGraph.edges) sourcePortsByNode.get(edge.sourceNodeId)?.add(edge.sourcePort ?? '');
    return JSON.stringify({
      direction,
      nodes: effectiveGraph.nodes.map((node) => ({
        id: node.nodeId,
        width: Object.hasOwn(nodeSizes, node.nodeId) ? nodeSizes[node.nodeId].width : NODE_WIDTH,
        height: Object.hasOwn(nodeSizes, node.nodeId) ? nodeSizes[node.nodeId].height : NODE_HEIGHT,
        sourcePorts: [...sourcePortsByNode.get(node.nodeId)!],
      })).sort((a, b) => a.id.localeCompare(b.id)),
      edges: effectiveGraph.edges.map((edge) => ({
        id: edge.edgeId, source: edge.sourceNodeId, target: edge.targetNodeId,
        sourcePort: edge.sourcePort ?? '',
        rework: edge.action === 'rework' || edge.sourcePort === 'rework',
      })).sort((a, b) => a.id.localeCompare(b.id)),
      fixedPositions: Object.fromEntries(effectiveGraph.nodes.flatMap((node) => {
        const position = viewPositions && Object.hasOwn(viewPositions, node.nodeId) ? viewPositions[node.nodeId]
          : Object.hasOwn(savedPositions, node.nodeId) ? savedPositions[node.nodeId] : undefined;
        return position ? [[node.nodeId, position]] : [];
      }).sort(([a], [b]) => String(a).localeCompare(String(b)))),
    });
  }, [direction, effectiveGraph.nodes, effectiveGraph.edges, savedPositions, nodeSizes, viewPositions]);
  const layoutInput = useMemo(() => JSON.parse(geometryKey) as GraphLayoutInput, [geometryKey]);
  const nodesMeasured = effectiveGraph.nodes.every((node) => Object.hasOwn(nodeSizes, node.nodeId));
  const currentGraphRef = useRef({ scope: layoutScope, input: layoutInput });
  useLayoutEffect(() => { currentGraphRef.current = { scope: layoutScope, input: layoutInput }; }, [layoutScope, layoutInput]);
  const { layout, shapeKey, status: layoutStatus, requestLayout, acceptLayout } = useGraphLayout(layoutScope, layoutInput, nodesMeasured, Boolean(dragNodeId) || isSaving);
  const geometryShape = useMemo(() => {
    const [layoutDirection, nodes, edges] = JSON.parse(shapeKey) as [GraphLayoutDirection, GraphLayoutInput['nodes'], GraphLayoutInput['edges']];
    return { direction: layoutDirection, nodes, edges };
  }, [shapeKey]);
  const nodeGeometryById = useMemo(() => new Map(geometryShape.nodes.map((node) => [node.id, node])), [geometryShape]);
  const positionKey = JSON.stringify({ ...layout?.result.positions, ...layoutInput.fixedPositions, ...activeDrafts });
  const edgeRouter = useMemo(() => ({ scope: layoutScope, route: createGraphEdgeRouter() }), [layoutScope]);
  const visibleGeometry = useMemo<GraphLayoutResult>(() => {
    const positions = JSON.parse(positionKey) as Record<string, GraphPoint>;
    if (layout?.shapeKey === shapeKey && Object.entries(positions).every(([id, point]) => Object.hasOwn(layout.result.positions, id) && point.x === layout.result.positions[id].x && point.y === layout.result.positions[id].y)) return layout.result;
    return { positions, ...edgeRouter.route({
      direction: geometryShape.direction,
      nodes: geometryShape.nodes.filter((node) => Object.hasOwn(positions, node.id)),
      edges: geometryShape.edges.filter((edge) => Object.hasOwn(positions, edge.source) && Object.hasOwn(positions, edge.target)),
      fixedPositions: positions,
    }, positions) };
  }, [edgeRouter, layout, positionKey, shapeKey, geometryShape]);
  const nodeById = useMemo(
    () => new Map(effectiveGraph.nodes.map((node) => [node.nodeId, node])),
    [effectiveGraph.nodes],
  );
  const selectedNode = useMemo(() => (
    newNode?.node ?? effectiveGraph.nodes.find((node) => node.nodeId === selectedNodeId) ?? null
  ), [newNode, effectiveGraph.nodes, selectedNodeId]);
  const selectedNodeKind = selectedNode ? visualKindForNodeKind(selectedNode.kind) : null;
  const selectedNodeArtifacts = useMemo(() => runArtifacts.filter((artifact) => artifact.nodeId === selectedNode?.nodeId), [runArtifacts, selectedNode?.nodeId]);
  const detailTabs = useMemo<TeamGraphNodeDetailTab[]>(() => [
    'output', ...(teamId ? ['input', 'activity'] as const : []), ...(renderNodeApprovals ? ['approval'] as const : []),
  ], [teamId, renderNodeApprovals]);
  const selectedEdge = useMemo(() => (
    newEdge ?? effectiveGraph.edges.find((edge) => edge.edgeId === selectedEdgeId) ?? null
  ), [newEdge, effectiveGraph.edges, selectedEdgeId]);
  const selectedEdgeSourceNode = useMemo(() => (
    selectedEdge ? effectiveGraph.nodes.find((node) => node.nodeId === selectedEdge.sourceNodeId) ?? null : null
  ), [effectiveGraph.nodes, selectedEdge]);
  const selectedEdgeTargetNode = useMemo(() => (
    selectedEdge ? effectiveGraph.nodes.find((node) => node.nodeId === selectedEdge.targetNodeId) ?? null : null
  ), [effectiveGraph.nodes, selectedEdge]);
  const roleBindings = useMemo(() => roles.filter((role) => role.runId === graphRunId && Boolean(role.sessionRef)), [roles, graphRunId]);
  const bindingsByNode = useMemo(() => {
    const bindings = new Map(roleBindings.map((role) => [JSON.stringify([role.roleId, role.sessionRef]), role]));
    const byNode = new Map<string, TeamRoleBindingRecord>();
    for (const node of effectiveGraph.nodes) {
      const binding = bindings.get(JSON.stringify([node.roleId, node.config?.sessionRef]));
      if (binding) byNode.set(node.nodeId, binding);
    }
    return byNode;
  }, [roleBindings, effectiveGraph.nodes]);
  const [canvasExtent, setCanvasExtent] = useState({ scope: layoutScope, x: 0, y: 0, right: -Infinity, bottom: -Infinity });
  const activeDrag = dragNodeId ? dragRef.current : null;
  const fitWidth = Math.max(NODE_WIDTH + CANVAS_PADDING * 2, visibleGeometry.bounds.width + CANVAS_PADDING * 2);
  const fitHeight = Math.max(NODE_HEIGHT + CANVAS_PADDING * 2, visibleGeometry.bounds.height + CANVAS_PADDING * 2);
  const fitScale = Math.min(1, viewportSize.width > 0 ? viewportSize.width / fitWidth : 1, viewportSize.height > 0 ? viewportSize.height / fitHeight : 1);
  const fittingView = zoom === null || readyScope !== layoutScope;
  const canvasScale = readyScope === layoutScope ? zoom ?? fitScale : fitScale;
  const fittedWidth = Math.max(fitWidth, viewportSize.width / canvasScale);
  const fittedHeight = Math.max(fitHeight, viewportSize.height / canvasScale);
  // Center the actual graph in graph coordinates; drag and edge-pan keep one surface origin.
  const fittedOrigin = {
    x: visibleGeometry.bounds.x + visibleGeometry.bounds.width / 2 - fittedWidth / 2,
    y: visibleGeometry.bounds.y + visibleGeometry.bounds.height / 2 - fittedHeight / 2,
  };
  // Match the scroller's pixel rounding so origin compensation cannot accumulate drift.
  const canvasOrigin = {
    x: Math.floor((fittingView ? fittedOrigin.x : Math.min(canvasExtent.x, visibleGeometry.bounds.x - CANVAS_PADDING, activeDrag?.canvasLeft ?? Infinity)) * canvasScale) / canvasScale,
    y: Math.floor((fittingView ? fittedOrigin.y : Math.min(canvasExtent.y, visibleGeometry.bounds.y - CANVAS_PADDING, activeDrag?.canvasTop ?? Infinity)) * canvasScale) / canvasScale,
  };
  const canvasRight = fittingView ? canvasOrigin.x + fittedWidth : Math.max(canvasOrigin.x + NODE_WIDTH + CANVAS_PADDING * 2, visibleGeometry.bounds.x + visibleGeometry.bounds.width + CANVAS_PADDING, activeDrag?.canvasRight ?? -Infinity, canvasExtent.right);
  const canvasBottom = fittingView ? canvasOrigin.y + fittedHeight : Math.max(canvasOrigin.y + NODE_HEIGHT + CANVAS_PADDING * 2, visibleGeometry.bounds.y + visibleGeometry.bounds.height + CANVAS_PADDING, activeDrag?.canvasBottom ?? -Infinity, canvasExtent.bottom);
  const canvasWidth = canvasRight - canvasOrigin.x;
  const canvasHeight = canvasBottom - canvasOrigin.y;
  const canvasViewRef = useRef({ x: canvasOrigin.x, y: canvasOrigin.y, right: canvasRight, bottom: canvasBottom, scale: canvasScale });
  const canvasReady = readyScope === layoutScope;

  useLayoutEffect(() => {
    const sameScope = canvasExtent.scope === layoutScope;
    const drag = dragRef.current;
    const scroller = canvasScrollerRef.current;
    canvasViewRef.current = { x: canvasOrigin.x, y: canvasOrigin.y, right: canvasRight, bottom: canvasBottom, scale: canvasScale };
    const pan = canvasPanRef.current;
    if (sameScope && scroller && pan?.pendingPosition) {
      scroller.scrollLeft = Math.round((pan.pendingPosition.x - canvasOrigin.x) * canvasScale);
      scroller.scrollTop = Math.round((pan.pendingPosition.y - canvasOrigin.y) * canvasScale);
      pan.pendingPosition = null;
      if (pan.pointerId === null) canvasPanRef.current = null;
    } else if (sameScope && scroller && !fittingView) {
      scroller.scrollLeft += (canvasExtent.x - canvasOrigin.x) * canvasScale + (drag?.panX ?? 0);
      scroller.scrollTop += (canvasExtent.y - canvasOrigin.y) * canvasScale + (drag?.panY ?? 0);
    }
    if (drag) {
      drag.panX = 0;
      drag.panY = 0;
    }
    if (!sameScope || canvasExtent.x !== canvasOrigin.x || canvasExtent.y !== canvasOrigin.y || canvasExtent.right !== canvasRight || canvasExtent.bottom !== canvasBottom) {
      setCanvasExtent({ scope: layoutScope, x: canvasOrigin.x, y: canvasOrigin.y, right: canvasRight, bottom: canvasBottom });
    }
  }, [canvasExtent, layoutScope, canvasOrigin.x, canvasOrigin.y, canvasRight, canvasBottom, canvasScale, fittingView, draftPositions]);

  useEffect(() => {
    const element = canvasScrollerRef.current;
    if (!element) return;
    let width = element.offsetWidth;
    let height = element.offsetHeight;
    const measure = () => {
      if (width !== element.offsetWidth || height !== element.offsetHeight) {
        width = element.offsetWidth;
        height = element.offsetHeight;
        setZoom(null);
      }
      const style = getComputedStyle(element);
      setViewportSize({
        width: element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
        height: element.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0),
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (layout?.shapeKey !== shapeKey || layoutStatus !== 'idle' || !nodesMeasured || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    if (fittingView) {
      setZoom(fitScale);
      const scroller = canvasScrollerRef.current;
      if (scroller) {
        scroller.scrollLeft = 0;
        scroller.scrollTop = 0;
      }
    }
    if (readyScope !== layoutScope) setReadyScope(layoutScope);
  }, [fittingView, layout, shapeKey, layoutStatus, nodesMeasured, viewportSize, fitScale, readyScope, layoutScope]);

  const cancelDragFrame = useCallback(() => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
  }, []);

  const cancelCanvasPan = useCallback(() => {
    if (canvasPanFrameRef.current !== null) cancelAnimationFrame(canvasPanFrameRef.current);
    canvasPanFrameRef.current = null;
    const pointerId = canvasPanRef.current?.pointerId;
    canvasPanRef.current = null;
    const scroller = canvasScrollerRef.current;
    scroller?.style.removeProperty('cursor');
    if (pointerId != null && scroller?.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId);
  }, []);

  useLayoutEffect(() => {
    layoutLifetimeRef.current = {};
    setIsArranging(false);
    setLayoutSubmitFailed(false);
    setDragNodeId(null);
    setDraftPositions((current) => hasRecordEntries(current) ? {} : current);
    return () => {
      layoutLifetimeRef.current = null;
      layoutEditRevisionRef.current += 1;
      cancelDragFrame();
      cancelCanvasPan();
      dragRef.current = null;
    };
  }, [layoutScope, canEdit, cancelDragFrame, cancelCanvasPan]);

  useEffect(() => {
    setZoom(null);
    setReadyScope(null);
    setIsSaving(false);
    setSelectedNodeId(null);
    setNewNode(null);
    setSelectedEdgeId(null);
    setNewEdge(null);
    setConfigurationSheet(null);
    setConnectionDraft(null);
    setNodePaletteOpen(false);
    setCanvasError(null);
  }, [layoutScope, canEdit]);

  useEffect(() => {
    if (layoutScopeRef.current !== layoutScope) {
      layoutScopeRef.current = layoutScope;
      setArrangedView(null);
      if (measurementScopeRef.current !== measurementScope) {
        measurementScopeRef.current = measurementScope;
        setNodeSizes({});
      }
      return;
    }
    setDraftPositions((current) => {
      const activeNodeIds = new Set(effectiveGraph.nodes.map((node) => node.nodeId));
      let changed = false;
      const next: Record<string, { x: number; y: number }> = Object.create(null);
      for (const [nodeId, position] of Object.entries(current)) {
        const saved = Object.hasOwn(savedPositions, nodeId) ? savedPositions[nodeId] : undefined;
        if (activeNodeIds.has(nodeId) && (dragRef.current?.nodeId === nodeId || saved?.x !== position.x || saved?.y !== position.y)) {
          next[nodeId] = position;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [effectiveGraph.nodes, savedPositions, layoutScope, measurementScope, dragNodeId]);

  useEffect(() => {
    if (layoutSubmitFailed && !hasRecordEntries(draftPositions)) setLayoutSubmitFailed(false);
  }, [draftPositions, layoutSubmitFailed]);

  const nodeIdsKey = useMemo(() => JSON.stringify(effectiveGraph.nodes.map((node) => node.nodeId).sort()), [effectiveGraph.nodes]);
  useEffect(() => {
    const activeNodeIds = new Set<string>(JSON.parse(nodeIdsKey));
    for (const nodeId of Object.keys(nodeElementsRef.current)) {
      if (!activeNodeIds.has(nodeId)) delete nodeElementsRef.current[nodeId];
    }
    setNodeSizes((current) => {
      const active = Object.entries(current).filter(([nodeId]) => activeNodeIds.has(nodeId));
      return active.length === Object.keys(current).length ? current : Object.fromEntries(active);
    });
  }, [nodeIdsKey]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      setNodeSizes((current) => {
        let changed = false;
        const next: Record<string, NodeSize> = Object.assign(Object.create(null), current);
        for (const [nodeId, element] of Object.entries(nodeElementsRef.current)) {
          if (!element) continue;
          const size = { width: element.offsetWidth || NODE_WIDTH, height: element.offsetHeight || NODE_HEIGHT };
          if (next[nodeId]?.width !== size.width || next[nodeId]?.height !== size.height) {
            next[nodeId] = size;
            changed = true;
          }
        }
        return changed ? next : current;
      });
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setNodeSizes((current) => {
        let changed = false;
        const next: Record<string, NodeSize> = Object.assign(Object.create(null), current);
        for (const entry of entries) {
          const nodeId = entry.target.getAttribute('data-node-id');
          if (!nodeId) continue;
          const element = entry.target as HTMLDivElement;
          const box = entry.borderBoxSize?.[0];
          const size = { width: Math.ceil(box?.inlineSize || element.offsetWidth), height: Math.ceil(box?.blockSize || element.offsetHeight) };
          if (next[nodeId]?.width !== size.width || next[nodeId]?.height !== size.height) {
            next[nodeId] = size;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    for (const element of Object.values(nodeElementsRef.current)) {
      if (element) observer.observe(element, { box: 'border-box' });
    }
    return () => observer.disconnect();
  }, [nodeIdsKey, measurementScope]);

  const closeNodeEditor = () => {
    setConfigurationSheet(null);
    setNewNode(null);
  };

  const closeEdgeEditor = () => {
    setConfigurationSheet(null);
    setNewEdge(null);
  };

  const submitGraphPatch = async (operations: TeamGraphPatchOperation[], base?: TeamGraphEditBase): Promise<boolean> => {
    if (!canEdit || mutationDisabled || !onPatchGraph) return false;
    const layoutOnly = operations.length > 0 && operations.every((operation) => operation.op === 'set_node_position');
    if (!layoutOnly && (isSaving || mutationPending)) return false;
    const lifetime = layoutLifetimeRef.current;
    try {
      await onPatchGraph(operations.map((operation) => operation.op === 'set_node_position'
        ? { ...operation, position: graphPositionForDirection(operation.position, direction) } : operation), base);
      return layoutLifetimeRef.current === lifetime;
    } catch (error) {
      if (!layoutOnly) throw error;
      if (layoutLifetimeRef.current === lifetime) setLayoutSubmitFailed(true);
      return false;
    }
  };

  const submitCanvasPatch = async (operations: TeamGraphPatchOperation[]): Promise<boolean> => {
    if (isSaving || mutationPending || mutationDisabled) return false;
    const lifetime = layoutLifetimeRef.current;
    setIsSaving(true);
    setCanvasError(null);
    try {
      return await submitGraphPatch(operations);
    } catch (error) {
      if (layoutLifetimeRef.current === lifetime) setCanvasError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (layoutLifetimeRef.current === lifetime) setIsSaving(false);
    }
  };

  const handleRetryLayoutSave = async (): Promise<void> => {
    if (!canEdit || mutationDisabled || isSaving || mutationPending || dragRef.current) return;
    if (hasRecordEntries(activeDrafts)) {
      await submitGraphPatch(Object.entries(activeDrafts).map(([nodeId, position]) => ({ op: 'set_node_position', nodeId, position })));
    } else if (onRetryLayoutSave) {
      await Promise.resolve().then(onRetryLayoutSave).catch(() => {});
    }
  };

  const handleAutoLayout = async (): Promise<void> => {
    if (isArranging || canEdit && mutationDisabled) return;
    const lifetime = layoutLifetimeRef.current;
    const context = currentGraphRef.current;
    const revision = ++layoutEditRevisionRef.current;
    setIsArranging(true);
    try {
      const result = await requestLayout(true);
      if (!result || currentGraphRef.current !== context || layoutEditRevisionRef.current !== revision || dragRef.current) return;
      if (!canEdit) {
        acceptLayout(result);
        setArrangedView({ scope: layoutScope, positions: result.positions });
        setZoom(null);
        return;
      }
      setDraftPositions(result.positions);
      const saved = await submitGraphPatch(Object.entries(result.positions).map(([nodeId, position]) => ({
        op: 'set_node_position', nodeId, position,
      })));
      if (!saved || currentGraphRef.current.scope !== context.scope || layoutEditRevisionRef.current !== revision || dragRef.current) return;
      if (JSON.stringify([context.input.direction, context.input.nodes, context.input.edges]) === JSON.stringify([currentGraphRef.current.input.direction, currentGraphRef.current.input.nodes, currentGraphRef.current.input.edges])) {
        acceptLayout(result);
        setZoom(null);
      }
    } finally {
      if (layoutLifetimeRef.current === lifetime) setIsArranging(false);
    }
  };

  const appendEdge = async (input: { sourceNodeId: string; targetNodeId: string; sourcePort: string }): Promise<void> => {
    if (!canEdit || mutationDisabled) return;
    if (!input.sourceNodeId || !input.targetNodeId || input.sourceNodeId === input.targetNodeId) {
      setCanvasError(`${labels.sourceNode} / ${labels.targetNode}`);
      return;
    }
    const source = nodeById.get(input.sourceNodeId);
    const target = nodeById.get(input.targetNodeId);
    if (!source?.sourcePorts?.includes(input.sourcePort) || target?.targetPorts?.length !== 1) {
      setCanvasError(labels.noPort);
      return;
    }
    const actions = edgeActionCandidates(source, input.sourcePort, target);
    if (actions.length === 0) {
      setCanvasError(labels.noEdgeAction);
      return;
    }
    const nextEdge: TeamGraphEdgeRecord = {
      edgeId: createProjectionEdgeId(),
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      sourcePort: input.sourcePort,
      targetPort: target.targetPorts[0],
      ...(actions.length === 1 ? { action: actions[0] } : {}),
      payload: { includeUpstreamResult: true },
    };
    if (actions.length > 1) {
      setNewEdge(nextEdge);
      setConfigurationSheet({ kind: 'edge', edgeId: nextEdge.edgeId });
      return;
    }
    if (await submitCanvasPatch([{ op: 'add_edge', edge: graphPatchEdge(nextEdge) }])) {
      setSelectedEdgeId(nextEdge.edgeId);
      setConfigurationSheet({ kind: 'edge', edgeId: nextEdge.edgeId });
    }
  };

  const handleAddNode = (kind: TeamGraphCanvasNodeKind): void => {
    if (!canEdit || mutationDisabled) return;
    const title = labels.nodeKindLabels[kind];
    const nodeId = createProjectionNodeId(kind);
    const viewport = readCanvasViewport(canvasScrollerRef.current);
    const rawPosition = nextNodePosition(effectiveGraph.nodes.map((node) => ({ nodeId: node.nodeId, ...(Object.hasOwn(visibleGeometry.positions, node.nodeId) ? visibleGeometry.positions[node.nodeId] : { x: 0, y: 0 }) })), nodeSizes, viewport ? {
      scrollLeft: viewport.scrollLeft / canvasScale + canvasOrigin.x,
      scrollTop: viewport.scrollTop / canvasScale + canvasOrigin.y,
      clientWidth: viewport.clientWidth / canvasScale,
      clientHeight: viewport.clientHeight / canvasScale,
    } : null);
    const position = { x: Math.round(rawPosition.x), y: Math.round(rawPosition.y) };
    const binding = roleBindings.length === 1 ? roleBindings[0] : undefined;
    const node: TeamGraphNodeRecord = {
      nodeId,
      kind,
      title,
      reworkLimits: {},
      sourcePortActions: {},
      status: 'pending',
      ...(kind === 'work' || kind === 'review' ? { roleId: binding?.roleId } : {}),
      ...(kind === 'work' ? { taskId: nodeId } : {}),
      config: kind === 'work' || kind === 'review' ? { prompt: title, sessionRef: binding?.sessionRef } : undefined,
    };
    setNewNode({ node, position });
    setConfigurationSheet({ kind: 'node', nodeId, tab: 'config' });
    setNodePaletteOpen(false);
  };


  const advanceCanvasPan = (): void => {
    canvasPanFrameRef.current = null;
    const pan = canvasPanRef.current;
    const scroller = canvasScrollerRef.current;
    if (!pan?.moved || !scroller) return;
    const view = canvasViewRef.current;
    const x = pan.x - (pan.pointerX - pan.startX) / view.scale;
    const y = pan.y - (pan.pointerY - pan.startY) / view.scale;
    const originX = Math.floor(Math.min(view.x, x) * view.scale) / view.scale;
    const originY = Math.floor(Math.min(view.y, y) * view.scale) / view.scale;
    const right = Math.max(view.right, x + viewportSize.width / view.scale);
    const bottom = Math.max(view.bottom, y + viewportSize.height / view.scale);
    if (originX === view.x && originY === view.y && right === view.right && bottom === view.bottom) {
      scroller.scrollLeft = Math.round((x - view.x) * view.scale);
      scroller.scrollTop = Math.round((y - view.y) * view.scale);
      pan.pendingPosition = null;
      return;
    }
    pan.pendingPosition = { x, y };
    setCanvasExtent({ scope: layoutScope, x: originX, y: originY, right, bottom });
  };

  const handleCanvasPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const scroller = canvasScrollerRef.current;
    if (!scroller || canvasTool !== 'pan' || !event.isPrimary || event.button !== 0 || dragRef.current || canvasPanRef.current?.pointerId != null) return;
    event.preventDefault();
    event.stopPropagation();
    const view = canvasViewRef.current;
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: view.x + scroller.scrollLeft / view.scale,
      y: view.y + scroller.scrollTop / view.scale,
      pendingPosition: null,
      moved: false,
    };
    scroller.setPointerCapture(event.pointerId);
    scroller.style.cursor = 'grabbing';
  };

  const handleCanvasPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    pan.pointerX = event.clientX;
    pan.pointerY = event.clientY;
    pan.moved ||= Math.abs(pan.pointerX - pan.startX) > DRAG_THRESHOLD || Math.abs(pan.pointerY - pan.startY) > DRAG_THRESHOLD;
    if (pan.moved && canvasPanFrameRef.current === null) canvasPanFrameRef.current = requestAnimationFrame(advanceCanvasPan);
  };

  const handleCanvasPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    handleCanvasPointerMove(event);
    if (canvasPanFrameRef.current !== null) cancelAnimationFrame(canvasPanFrameRef.current);
    advanceCanvasPan();
    pan.pointerId = null;
    event.currentTarget.style.removeProperty('cursor');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!pan.pendingPosition) canvasPanRef.current = null;
  };

  const handleCanvasPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (canvasPanRef.current?.pointerId !== event.pointerId) return;
    cancelCanvasPan();
  };

  const cancelNodeDrag = useCallback((): void => {
    const drag = dragRef.current;
    if (!drag) return;
    cancelDragFrame();
    dragRef.current = null;
    setDraftPositions((current) => drag.draftPosition ? { ...current, [drag.nodeId]: drag.draftPosition }
      : Object.fromEntries(Object.entries(current).filter(([id]) => id !== drag.nodeId)));
    setDragNodeId(null);
    const element = nodeElementsRef.current[drag.nodeId];
    if (element?.hasPointerCapture?.(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
  }, [cancelDragFrame]);

  useLayoutEffect(() => {
    if (!mutationDisabled) return;
    layoutEditRevisionRef.current += 1;
    cancelNodeDrag();
    setConnectionDraft(null);
    setNodePaletteOpen(false);
  }, [mutationDisabled, cancelNodeDrag]);

  const handleSelectCanvasTool = (tool: 'select' | 'pan'): void => {
    cancelCanvasPan();
    cancelNodeDrag();
    setCanvasTool(tool);
    setConnectionDraft(null);
    setNodePaletteOpen(false);
  };

  const handleSelectDirection = (nextDirection: GraphLayoutDirection): void => {
    if (direction === nextDirection || isSaving || mutationPending) return;
    handleSelectCanvasTool(canvasTool);
    setDirection(nextDirection);
  };

  const handleNodePointerDown = (event: PointerEvent<HTMLDivElement>, nodeId: string): void => {
    if (canvasTool !== 'select' || !event.isPrimary || canvasPanRef.current || !canEdit || mutationDisabled || isSaving || mutationPending || dragRef.current || event.button !== 0) return;
    const surface = canvasSurfaceRef.current;
    const position = Object.hasOwn(visibleGeometry.positions, nodeId) ? visibleGeometry.positions[nodeId] : undefined;
    if (!surface || !position) return;
    layoutEditRevisionRef.current += 1;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = surface.getBoundingClientRect();
    dragRef.current = {
      nodeId,
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: canvasOrigin.x + (event.clientX - rect.left) / canvasScale - position.x,
      offsetY: canvasOrigin.y + (event.clientY - rect.top) / canvasScale - position.y,
      canvasLeft: canvasOrigin.x,
      canvasTop: canvasOrigin.y,
      canvasRight,
      canvasBottom,
      currentX: position.x,
      currentY: position.y,
      draftPosition: Object.hasOwn(activeDrafts, nodeId) ? activeDrafts[nodeId] : undefined,
      panX: 0,
      panY: 0,
      frameTime: null,
      moved: false,
    };
    setDragNodeId(nodeId);
  };

  const updateDragPosition = (drag: DragState): void => {
    const surface = canvasSurfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const view = canvasViewRef.current;
    drag.currentX = view.x + (drag.pointerX - rect.left + drag.panX) / view.scale - drag.offsetX;
    drag.currentY = view.y + (drag.pointerY - rect.top + drag.panY) / view.scale - drag.offsetY;
  };

  const updateDragPointer = (event: PointerEvent<HTMLDivElement>): DragState | null => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return null;
    drag.pointerX = event.clientX;
    drag.pointerY = event.clientY;
    drag.moved ||= Math.abs(event.clientX - drag.pointerStartX) > DRAG_THRESHOLD
      || Math.abs(event.clientY - drag.pointerStartY) > DRAG_THRESHOLD;
    return drag;
  };

  const requestDragFrame = (): void => {
    if (dragRef.current?.moved && dragFrameRef.current === null) {
      dragFrameRef.current = requestAnimationFrame(advanceDrag);
    }
  };

  const advanceDrag = (time: number): void => {
    dragFrameRef.current = null;
    const drag = dragRef.current;
    const scroller = canvasScrollerRef.current;
    if (!drag?.moved || !scroller) return;
    const rect = scroller.getBoundingClientRect();
    const elapsed = Math.min(32, drag.frameTime === null ? 16 : time - drag.frameTime);
    const edgeSpeed = (pointer: number, start: number, end: number) => {
      const margin = 48;
      return Math.max(-1, Math.min(0, (pointer - start - margin) / margin))
        + Math.min(1, Math.max(0, (pointer - end + margin) / margin));
    };
    drag.panX = edgeSpeed(drag.pointerX, rect.left, rect.left + scroller.clientWidth) * elapsed * 0.6;
    drag.panY = edgeSpeed(drag.pointerY, rect.top, rect.top + scroller.clientHeight) * elapsed * 0.6;
    const view = canvasViewRef.current;
    // Expand before scrolling; negative graph coordinates are valid, scroll offsets are not.
    drag.canvasLeft = Math.min(drag.canvasLeft, view.x + Math.min(0, scroller.scrollLeft + drag.panX) / view.scale);
    drag.canvasTop = Math.min(drag.canvasTop, view.y + Math.min(0, scroller.scrollTop + drag.panY) / view.scale);
    drag.canvasRight = Math.max(drag.canvasRight, view.x + (scroller.scrollLeft + viewportSize.width + drag.panX) / view.scale);
    drag.canvasBottom = Math.max(drag.canvasBottom, view.y + (scroller.scrollTop + viewportSize.height + drag.panY) / view.scale);
    updateDragPosition(drag);
    const position = { x: drag.currentX, y: drag.currentY };
    setDraftPositions((current) => Object.hasOwn(current, drag.nodeId) && current[drag.nodeId].x === position.x && current[drag.nodeId].y === position.y
      ? current : { ...current, [drag.nodeId]: position });
    const panning = drag.panX !== 0 || drag.panY !== 0;
    drag.frameTime = panning ? time : null;
    if (panning) requestDragFrame();
  };

  const handleNodePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    updateDragPointer(event);
    requestDragFrame();
  };

  const handleNodePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const finishedDrag = updateDragPointer(event);
    if (!finishedDrag) return;
    updateDragPosition(finishedDrag);
    cancelDragFrame();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragNodeId(null);
    if (finishedDrag.moved) {
      const position = { x: Math.round(finishedDrag.currentX), y: Math.round(finishedDrag.currentY) };
      setDraftPositions((current) => ({ ...current, [finishedDrag.nodeId]: position }));
      suppressClickNodeIdRef.current = finishedDrag.nodeId;
      window.setTimeout(() => { suppressClickNodeIdRef.current = null; }, 0);
      void submitGraphPatch([{ op: 'set_node_position', nodeId: finishedDrag.nodeId, position }]);
    }
  };

  const handleNodePointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    cancelNodeDrag();
  };

  const handleStartConnection = (nodeId: string, sourcePort: string): void => {
    if (!canEdit || mutationDisabled) return;
    setConnectionDraft({ sourceNodeId: nodeId, sourcePort });
  };

  const handleFinishConnection = (nodeId: string): void => {
    if (!connectionDraft) return;
    void appendEdge({
      sourceNodeId: connectionDraft.sourceNodeId,
      targetNodeId: nodeId,
      sourcePort: connectionDraft.sourcePort,
    });
    setConnectionDraft(null);
  };

  const handleOpenNode = (nodeId: string, keyboard = false) => {
    if (!keyboard && suppressClickNodeIdRef.current === nodeId) return;
    setCanvasError(null);
    setSelectedNodeId(nodeId);
    setConfigurationSheet({ kind: 'node', nodeId, tab: 'config' });
  };
  const handleOpenOutput = (nodeId: string, selection?: TeamNodeDeliverySelection) => {
    setCanvasError(null);
    setSelectedNodeId(nodeId);
    setConfigurationSheet({ kind: 'node', nodeId, tab: 'output', selection });
  };
  const handleRepairGraph = async (operations: TeamGraphPatchOperation[]) => {
    if (!repairGraph || mutationDisabled || isSaving || mutationPending) return;
    const lifetime = layoutLifetimeRef.current;
    setIsSaving(true);
    try {
      await repairGraph(operations);
    } finally {
      if (layoutLifetimeRef.current === lifetime) setIsSaving(false);
    }
  };
  // Memoized leaves dispatch through the latest committed handlers, not captured drag geometry.
  const eventHandlersRef = useRef({
    pointerDown: handleNodePointerDown, pointerMove: handleNodePointerMove,
    pointerUp: handleNodePointerUp, pointerCancel: handleNodePointerCancel,
    startConnection: handleStartConnection, finishConnection: handleFinishConnection,
    open: handleOpenNode, openOutput: handleOpenOutput, addNode: handleAddNode, repair: handleRepairGraph,
  });
  useLayoutEffect(() => {
    eventHandlersRef.current = {
      pointerDown: handleNodePointerDown, pointerMove: handleNodePointerMove,
      pointerUp: handleNodePointerUp, pointerCancel: handleNodePointerCancel,
      startConnection: handleStartConnection, finishConnection: handleFinishConnection,
      open: handleOpenNode, openOutput: handleOpenOutput, addNode: handleAddNode, repair: handleRepairGraph,
    };
  });
  const nodeEvents = useMemo<TeamGraphNodeEvents>(() => ({
    register: (nodeId, element) => { nodeElementsRef.current[nodeId] = element; },
    open: (nodeId, keyboard) => eventHandlersRef.current.open(nodeId, keyboard),
    openOutput: (nodeId, selection) => eventHandlersRef.current.openOutput(nodeId, selection),
    pointerDown: (event, nodeId) => eventHandlersRef.current.pointerDown(event, nodeId),
    pointerMove: (event) => eventHandlersRef.current.pointerMove(event),
    pointerUp: (event) => eventHandlersRef.current.pointerUp(event),
    pointerCancel: (event) => eventHandlersRef.current.pointerCancel(event),
    startConnection: (nodeId, sourcePort) => eventHandlersRef.current.startConnection(nodeId, sourcePort),
    finishConnection: (nodeId) => eventHandlersRef.current.finishConnection(nodeId),
  }), []);
  const openEdge = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setConfigurationSheet({ kind: 'edge', edgeId });
  }, []);
  const leaveEdge = useCallback((edgeId: string) => setHoveredEdgeId((current) => current === edgeId ? null : current), []);
  const addNode = useCallback((kind: TeamGraphCanvasNodeKind) => eventHandlersRef.current.addNode(kind), []);
  const savePortRepair = useCallback((operations: TeamGraphPatchOperation[]) => eventHandlersRef.current.repair(operations), []);
  const toggleNodePalette = useCallback(() => setNodePaletteOpen((open) => !open), []);
  const closeNodePalette = useCallback(() => setNodePaletteOpen(false), []);

  return (
    <div className={compact ? 'mx-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col gap-2' : 'min-w-0 space-y-2'}>

      {repairGraph ? <GraphPortRepair
        key={`${layoutScope}:${graphVersion ?? ''}`}
        graph={effectiveGraph}
        runtimeError={runtimeError}
        edgePatch={graphPatchEdge}
        labels={labels}
        pending={isSaving || mutationPending || mutationDisabled}
        onSave={savePortRepair}
      /> : null}
      {canvasError ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{canvasError}</div> : null}
      {(layoutSubmitFailed && hasRecordEntries(activeDrafts)) || layoutSave?.status === 'failed' ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
        <span>{labels.layoutSaveFailed ?? labels.saveGraphUnavailable}</span>
        {canEdit && (layoutSubmitFailed || onRetryLayoutSave) ? <button type="button" className="rounded border border-destructive/40 px-2 py-1 hover:bg-destructive/10 disabled:opacity-50" disabled={isSaving || mutationPending || mutationDisabled || Boolean(dragNodeId)} onClick={() => { void handleRetryLayoutSave(); }}>
          {labels.retryLayoutSave ?? labels.saveGraphUnavailable}
        </button> : null}
      </div> : null}

      <div className={`relative isolate overflow-hidden rounded-xl border border-border/80 bg-[hsl(var(--shell-surface-muted))] ${compact ? 'flex min-h-0 flex-1 flex-col' : ''}`} aria-busy={isArranging || layoutStatus === 'pending' || !canvasReady && layoutStatus !== 'failed'}>
        <div className="pointer-events-none absolute bottom-5 left-1/2 z-30 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col items-center justify-center gap-1 text-[11px]" style={{ visibility: canvasReady || layoutStatus === 'failed' ? 'visible' : 'hidden' }}>
          {layoutStatus === 'failed' ? <span role="alert" className="rounded-[6px] bg-card px-2 py-1.5 text-destructive">{labels.layoutFailed ?? 'Layout failed. Try arranging again.'}</span> : null}
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-[5px] rounded-[10px] border border-border bg-card p-1 shadow-[0_3px_9px_rgb(24_35_51_/_0.03)] dark:bg-muted dark:shadow-[0_3px_10px_rgb(0_0_0_/_0.07)]">
            <button type="button" className={`grid h-7 w-7 place-items-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${canvasTool === 'select' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} aria-label={t('run.graphCanvas.selectTool')} title={t('run.graphCanvas.selectTool')} aria-pressed={canvasTool === 'select'} onClick={() => handleSelectCanvasTool('select')}>
              <MousePointer2 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
            </button>
            <button type="button" className={`grid h-7 w-7 place-items-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${canvasTool === 'pan' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} aria-label={t('run.graphCanvas.panTool')} title={t('run.graphCanvas.panTool')} aria-pressed={canvasTool === 'pan'} onClick={() => handleSelectCanvasTool('pan')}>
              <Hand aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
            </button>
            <span aria-hidden="true" className="mx-0.5 h-[17px] w-px bg-border" />
            <button type="button" className="h-7 rounded-[6px] px-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => { void handleAutoLayout(); }} aria-busy={isArranging} disabled={isArranging || isSaving || mutationPending || canEdit && mutationDisabled || Boolean(dragNodeId) || !nodesMeasured || effectiveGraph.nodes.length === 0}>
              {labels.autoLayout ?? 'Auto layout'}
            </button>
            <button type="button" className={`grid h-7 w-7 place-items-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${direction === 'vertical' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} aria-label={t('run.graphCanvas.verticalLayout')} title={t('run.graphCanvas.verticalLayout')} aria-pressed={direction === 'vertical'} disabled={isSaving || mutationPending || Boolean(dragNodeId)} onClick={() => handleSelectDirection('vertical')}>
              <Rows3 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
            </button>
            <button type="button" className={`grid h-7 w-7 place-items-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${direction === 'horizontal' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`} aria-label={t('run.graphCanvas.horizontalLayout')} title={t('run.graphCanvas.horizontalLayout')} aria-pressed={direction === 'horizontal'} disabled={isSaving || mutationPending || Boolean(dragNodeId)} onClick={() => handleSelectDirection('horizontal')}>
              <Columns3 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
            </button>
            <div className="flex items-center gap-[5px]" style={{ visibility: canvasReady ? 'visible' : 'hidden' }}>
              <span aria-hidden="true" className="mx-0.5 h-[17px] w-px bg-border" />
              <button type="button" className="grid h-7 w-7 place-items-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={labels.zoomOut ?? '−'} title={labels.zoomOut} onClick={() => setZoom(canvasScale / 1.2)}>
                <Minus aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
              </button>
              <span className="w-[39px] text-center tabular-nums text-muted-foreground">{Math.round(canvasScale * 100)}%</span>
              <button type="button" className="grid h-7 w-7 place-items-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={labels.zoomIn ?? '+'} title={labels.zoomIn} onClick={() => setZoom(Math.min(2, canvasScale * 1.2))}>
                <Plus aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
              </button>
              <span aria-hidden="true" className="mx-0.5 h-[17px] w-px bg-border" />
              <button type="button" className="grid h-7 w-7 place-items-center rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={labels.fitToView ?? labels.workflowCanvas} title={labels.fitToView} onClick={() => setZoom(null)}>
                <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={1.65} />
              </button>
            </div>
          </div>
        </div>
        <div className={compact ? 'relative flex min-h-0 flex-1 flex-col' : 'relative'}>
        <StableScrollArea ref={canvasScrollerRef} onScroll={requestDragFrame} data-team-graph-canvas="true" inert={!canvasReady} style={{ opacity: canvasReady ? 1 : 0 }} className={`relative overflow-auto p-4 text-foreground ${canvasTool === 'pan' ? 'cursor-grab select-none touch-none [&_*]:!cursor-[inherit]' : ''} ${compact ? 'min-h-[240px] flex-1' : 'h-[520px]'}`}
          onPointerMoveCapture={handleCanvasPointerMove}
          onPointerUpCapture={handleCanvasPointerUp}
          onPointerCancelCapture={handleCanvasPointerCancel}
          onLostPointerCapture={handleCanvasPointerCancel}
          onClickCapture={(event) => {
            if (canvasTool === 'pan' && event.detail > 0) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <div className="overflow-clip" style={{ width: canvasWidth * canvasScale, height: canvasHeight * canvasScale }}>
          <div
            ref={canvasSurfaceRef}
            aria-label={labels.workflowCanvas}
            className="relative rounded-xl"
            onPointerDownCapture={handleCanvasPointerDown}
            onClick={() => {
              setNodePaletteOpen(false);
              setSelectedEdgeId(null);
              setHoveredEdgeId(null);
              if (configurationSheet?.kind === 'edge') setConfigurationSheet(null);
            }}
            style={{
              width: canvasWidth,
              height: canvasHeight,
              transform: `scale(${canvasScale})`,
              transformOrigin: 'top left',
            }}
          >
            <svg className="pointer-events-none absolute inset-0 text-muted-foreground/25 dark:text-muted-foreground/20" width={canvasWidth} height={canvasHeight} viewBox={`${canvasOrigin.x} ${canvasOrigin.y} ${canvasWidth} ${canvasHeight}`} aria-hidden="true">
              <defs>
                <pattern id={`${canvasId}-dots`} width="24" height="24" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="0.8" fill="currentColor" />
                </pattern>
              </defs>
              <rect x={canvasOrigin.x} y={canvasOrigin.y} width={canvasWidth} height={canvasHeight} fill={`url(#${canvasId}-dots)`} />
            </svg>
            <svg className="absolute inset-0 text-muted-foreground/85 dark:text-muted-foreground/35" width={canvasWidth} height={canvasHeight} viewBox={`${canvasOrigin.x} ${canvasOrigin.y} ${canvasWidth} ${canvasHeight}`} role="img" aria-label={labels.workflowEdges}>
              <defs>
                {[...Object.values(EDGE_VISUALS), FALLBACK_EDGE_VISUAL].map((visual) => (
                  <marker key={visual.markerId} id={`${canvasId}-${visual.markerId}`} markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="m1 1 4 2-4 2" fill="none" stroke={visual.stroke} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </marker>
                ))}
              </defs>
              {effectiveGraph.edges.map((edge) => {
                const source = nodeById.get(edge.sourceNodeId ?? edge.fromNodeId ?? '');
                const target = nodeById.get(edge.targetNodeId ?? edge.toNodeId ?? '');
                if (!source || !target) {
                  return null;
                }
                const route = Object.hasOwn(visibleGeometry.routes, edge.edgeId) ? visibleGeometry.routes[edge.edgeId] : undefined;
                if (!route || !nodesMeasured) return null;
                return <TeamGraphEdge
                  key={edge.edgeId}
                  edge={edge}
                  route={route}
                  sourceTitle={source.title ?? source.nodeId}
                  targetTitle={target.title ?? target.nodeId}
                  selected={selectedEdgeId === edge.edgeId}
                  hovered={hoveredEdgeId === edge.edgeId}
                  canvasId={canvasId}
                  onOpen={openEdge}
                  onHover={setHoveredEdgeId}
                  onLeave={leaveEdge}
                />;
              })}
            </svg>

            {effectiveGraph.nodes.length === 0 ? (
              <div className="absolute left-1/2 top-1/2 w-[22rem] max-w-full -translate-x-1/2 -translate-y-1/2 p-5 text-center">
                <div className="text-sm font-medium text-foreground">{titleLabel}</div>
                <div className="mt-2 text-xs text-muted-foreground">{emptyLabel}</div>
              </div>
            ) : null}

            <div className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto" style={{ transform: `translate(${-canvasOrigin.x}px, ${-canvasOrigin.y}px)` }}>
            {effectiveGraph.nodes.map((node) => {
              const position = Object.hasOwn(visibleGeometry.positions, node.nodeId) ? visibleGeometry.positions[node.nodeId] : undefined;
              const canConnectTo = node.targetPorts?.length === 1 && (!connectionDraft || edgeActionCandidates(nodeById.get(connectionDraft.sourceNodeId), connectionDraft.sourcePort, node).length > 0);
              return <TeamGraphNodeCard
                key={node.nodeId}
                node={node}
                x={position?.x ?? 0}
                y={position?.y ?? 0}
                geometry={nodeGeometryById.get(node.nodeId)!}
                direction={direction}
                visible={Boolean(position) && Object.hasOwn(nodeSizes, node.nodeId)}
                selected={selectedNode?.nodeId === node.nodeId}
                editable={canEdit && !mutationDisabled}
                canConnectTo={canConnectTo}
                connectionTargetActive={canConnectTo && Boolean(connectionDraft)}
                activeSourcePort={connectionDraft?.sourceNodeId === node.nodeId ? connectionDraft.sourcePort : null}
                labels={labels}
                executorLabel={executorLabel}
                binding={bindingsByNode.get(node.nodeId)}
                artifacts={deliveriesByNode.get(node.nodeId) ?? EMPTY_ARTIFACTS}
                events={nodeEvents}
              />;
            })}
            </div>
          </div>
          </div>
        </StableScrollArea>

        {headerActions ? <div className={`pointer-events-none absolute top-4 z-20 flex max-w-[calc(100%-2rem)] flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground ${canEdit ? 'left-40 right-4' : 'left-4 right-4'}`}>
          <div className="pointer-events-auto">{headerActions}</div>
        </div> : null}
        {canEdit ? <NodePaletteControl
          labels={labels}
          isOpen={isNodePaletteOpen}
          isSaving={isSaving || mutationPending || mutationDisabled}
          onToggle={toggleNodePalette}
          onClose={closeNodePalette}
          onAddNode={addNode}
        /> : null}
        </div>
      </div>

      {configurationSheet?.kind === 'node' && selectedNode && selectedNodeKind ? (
        <TeamGraphNodeEditor
          key={JSON.stringify([layoutScope, selectedNode.nodeId, canEdit])}
          node={selectedNode}
          kind={selectedNodeKind}
          initialPosition={newNode?.position}
          nodes={effectiveGraph.nodes}
          edges={effectiveGraph.edges}
          roles={roleBindings}
          editable={canEdit}
          mutationPending={isSaving || mutationPending}
          mutationDisabled={mutationDisabled}
          status={newNode ? '' : statusLabel(selectedNode.status, labels)}
          statusClassName={statusTextTone(selectedNode.status)}
          labels={labels}
          webhookAuth={webhookAuth}
          initialTab={configurationSheet.tab}
          detailTabs={!newNode ? detailTabs : undefined}
          renderDetails={!newNode ? (tab, onClose, pending) => tab === 'approval'
            ? renderNodeApprovals?.(selectedNode.nodeId, onClose)
            : teamId ? <TeamGraphNodeDetails
              teamId={teamId}
              runId={graphRunId}
              node={selectedNode}
              nodes={effectiveGraph.nodes}
              edges={effectiveGraph.edges}
              roles={roleBindings}
              artifacts={runArtifacts}
              loading={deliveriesLoading}
              fileScope={fileScope}
              workspaceStatus={workspaceStatus}
              tab={tab}
              initialSelection={configurationSheet.selection}
              disabled={pending || mutationDisabled}
              onReveal={onClose}
            /> : tab === 'output' ? <TeamFilePreview artifacts={selectedNodeArtifacts} fileScope={fileScope} workspaceStatus={workspaceStatus} initialSelection={configurationSheet.selection} disabled={pending || mutationDisabled}>
              <TeamNodeDeliveries
                contextTitle={selectedNode.title}
                artifacts={selectedNodeArtifacts}
                loading={deliveriesLoading}
                roles={roleBindings}
                disabled={pending || mutationDisabled}
                onReveal={onClose}
              />
            </TeamFilePreview> : null : undefined}
          nodePatch={graphPatchNode}
          onPatchGraph={submitGraphPatch}
          onCreateSession={onCreateSession}
          createSessionDisabledReason={createSessionDisabledReason}
          onSaved={(nodeId) => {
            setNewNode(null);
            setSelectedNodeId(nodeId);
            setConfigurationSheet(null);
          }}
          onDeleted={() => { setSelectedNodeId(null); closeNodeEditor(); }}
          onClose={closeNodeEditor}
        />
      ) : configurationSheet?.kind === 'edge' && selectedEdge ? (
        <TeamGraphEdgeEditor
          key={JSON.stringify([layoutScope, selectedEdge.edgeId, canEdit])}
          edge={selectedEdge}
          sourceNode={selectedEdgeSourceNode}
          targetNode={selectedEdgeTargetNode}
          runId={graphRunId}
          rework={effectiveGraph.rework}
          isNew={Boolean(newEdge)}
          editable={canEdit}
          mutationPending={isSaving || mutationPending}
          mutationDisabled={mutationDisabled}
          status={newEdge ? '' : statusLabel(selectedEdge.status, labels)}
          statusClassName={statusTextTone(selectedEdge.status)}
          labels={labels}
          edgePatch={graphPatchEdge}
          onPatchGraph={submitGraphPatch}
          onSaved={closeEdgeEditor}
          onDeleted={() => { setSelectedEdgeId(null); closeEdgeEditor(); }}
          onClose={closeEdgeEditor}
        />
      ) : null}
    </div>
  );
});

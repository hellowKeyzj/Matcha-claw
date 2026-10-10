import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Bot, CheckCircle2, FileCode2, Flag, GitMerge, Maximize2, Minus, Plus, UserCheck, Zap, type LucideIcon } from 'lucide-react';
import { StableScrollArea } from '@/components/scroll';
import { createSessionTraceId, logSessionTrace, summarizeIdentifier, summarizeTeamGraphPort } from '@/lib/session-trace';
import { Sheet } from '@/components/ui/sheet';
import { createGraphLayoutEngine, routeGraphEdges } from './team-graph-layout';
import { edgeActionCandidates, TeamGraphPortRepair } from './TeamGraphPortRepair';
import { TeamEdgeInspector } from './TeamEdgeInspector';
import type { GraphLayoutInput, GraphLayoutResult, GraphPoint } from './team-graph-layout-types';
import type { TeamDesignFailure, TeamGraphNodeConfigRecord, TeamScriptReviewRule } from '@/types/team-design';
import type {
  TeamGraphEdgeAction,
  TeamGraphEdgeRecord,
  TeamGraphNodeRecord,
  TeamGraphPatchOperation,
  TeamGraphSnapshotRecord,
  TeamRoleBindingRecord,
  TeamWebhookAuthProjection,
} from '@/services/openclaw/team-runtime-client';

import { TeamNodeInspector } from './TeamNodeInspector';
import { TeamAssignmentEditor } from './TeamAssignmentEditor';
import { TeamStartEditor, DEFAULT_CRON_SCHEDULE, readStartTrigger, buildCronExpression, normalizeWebhookPathInput, buildWebhookPublicUrl, readPositiveIntegerInRange } from './TeamStartEditor';
import { TeamScriptReviewEditor } from './TeamScriptReviewEditor';
import { TeamControlNodeDetails } from './TeamControlNodeDetails';
import type { TeamGraphCanvasNodeKind, TeamGraphStartTriggerMode, TeamGraphCronPresetId, TeamGraphCronCustomKind, CronScheduleDraft } from './team-node-editor-types';
const TEAM_GRAPH_EDGE_ACTIONS: TeamGraphEdgeAction[] = ['activate', 'rework', 'gate', 'finish'];
const EMPTY_PORTS: readonly string[] = [];

export type TeamRunGraphCanvasLabels = {
  cancelEdge: string;
  closeEdge: string;
  edgeActionDescriptions: Record<TeamGraphEdgeAction, string>;
  cancelNode: string;
  closeNode: string;
  nodeTechnicalDetails: string;
  executionSettings: string;
  executionLimitSummary: string;
  workMember: string;
  reviewMember: string;
  nodeKindLabels: Record<TeamGraphCanvasNodeKind, string>;
  expandPrompt: string;
  collapsePrompt: string;
  optionalOutput: string;
  scriptReviewRuleDescriptions: Record<TeamScriptReviewRule, string>;
  humanDecisionHint: string;
  nodeIncomingConnections: string;
  nodeOutgoingConnections: string;
  nodeNoConnections: string;
  nodeDetails?: string;
  nodeDetailsDescription?: string;
  task?: string;
  zoomIn?: string;
  zoomOut?: string;
  fitToView?: string;
  autoLayout?: string;
  layoutPending?: string;
  layoutFailed?: string;
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
  nodeMaxAttempts: string;
  nodeMaxAttemptsHint: string;
  nodeMaxAttemptsInvalid: string;
  reworkLimitExceeded: string;
  roleId: string;
  sessionRef: string;
  selectRole: string;
  selectSession: string;
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
  connectionDraft: string;
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
  mode?: 'readonly' | 'editable';
  compact?: boolean;
  mutationPending?: boolean;
  graph: TeamGraphSnapshotRecord | null | undefined;
  runStatus?: string;
  roles?: TeamRoleBindingRecord[];
  headerActions?: ReactNode;
  emptyLabel: string;
  titleLabel: string;
  executorLabel: string;
  webhookAuth?: TeamWebhookAuthProjection | null;
  labels: TeamRunGraphCanvasLabels;
  onPatchGraph?: (operations: TeamGraphPatchOperation[]) => Promise<void> | void;
  graphVersion?: string;
  runtimeError?: TeamDesignFailure | null;
  onRepairGraph?: (operations: TeamGraphPatchOperation[]) => Promise<void> | void;
};

type PositionedNode = TeamGraphNodeRecord & {
  x: number;
  y: number;
};

type DragState = {
  nodeId: string;
  pointerId: number;
  pointerStartX: number;
  pointerStartY: number;
  nodeStartX: number;
  nodeStartY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
};

type ConnectionDraft = {
  sourceNodeId: string;
  sourcePort: string;
};

type ConfigurationSheet =
  | { kind: 'node'; nodeId: string }
  | { kind: 'edge'; edgeId: string }
  | null;

type TeamGraphNodeVisual = {
  Icon: LucideIcon;
  iconShape: string;
  accentClassName: string;
  canvasClassName: string;
  handleClassName: string;
  iconClassName: string;
  paletteClassName: string;
};

type TeamGraphEdgeVisual = {
  markerId: string;
  stroke: string;
  labelClassName: string;
  dashArray?: string;
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 118;
const CANVAS_PADDING = 72;
const DRAG_THRESHOLD = 3;
const DEFAULT_NODE_MAX_ATTEMPTS = 3;
const NODE_MAX_ATTEMPTS_LIMIT = 0xffff_ffff;
const NODE_PALETTE: Array<{ kind: TeamGraphCanvasNodeKind; title: string }> = [
  { kind: 'start', title: 'Trigger' },
  { kind: 'work', title: 'Role step' },
  { kind: 'review', title: 'Review' },
  { kind: 'human_decision', title: 'Decision' },
  { kind: 'script_review', title: 'Script check' },
  { kind: 'join', title: 'Join' },
  { kind: 'end', title: 'Finish' },
];

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
  stroke: '#64748b',
  labelClassName: 'border-border bg-background/95 text-muted-foreground',
};

const NODE_VISUALS: Record<TeamGraphCanvasNodeKind, TeamGraphNodeVisual> = {
  start: {
    Icon: Zap,
    iconShape: 'rounded-full',
    accentClassName: 'bg-teal-500',
    canvasClassName: 'border-teal-500/45 bg-card text-foreground',
    handleClassName: 'border-teal-500/50 bg-teal-500',
    iconClassName: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
    paletteClassName: 'border-border/80 bg-card hover:border-teal-500/50 hover:bg-muted/60',
  },
  work: {
    Icon: Bot,
    iconShape: 'rounded-full',
    accentClassName: 'bg-primary',
    canvasClassName: 'border-primary/45 bg-card text-foreground',
    handleClassName: 'border-primary/50 bg-primary',
    iconClassName: 'bg-primary/15 text-primary',
    paletteClassName: 'border-border/80 bg-card hover:border-primary/50 hover:bg-muted/60',
  },
  review: {
    Icon: CheckCircle2,
    iconShape: 'rounded-xl',
    accentClassName: 'bg-violet-500',
    canvasClassName: 'border-violet-500/45 bg-card text-foreground',
    handleClassName: 'border-violet-500/50 bg-violet-500',
    iconClassName: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    paletteClassName: 'border-border/80 bg-card hover:border-violet-500/50 hover:bg-muted/60',
  },
  human_decision: {
    Icon: UserCheck,
    iconShape: 'rounded-xl',
    accentClassName: 'bg-amber-500',
    canvasClassName: 'border-amber-500/50 bg-card text-foreground',
    handleClassName: 'border-amber-500/50 bg-amber-500',
    iconClassName: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    paletteClassName: 'border-border/80 bg-card hover:border-amber-500/55 hover:bg-muted/60',
  },
  script_review: {
    Icon: FileCode2,
    iconShape: 'rounded-xl',
    accentClassName: 'bg-emerald-500',
    canvasClassName: 'border-emerald-500/45 bg-card text-foreground',
    handleClassName: 'border-emerald-500/50 bg-emerald-500',
    iconClassName: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    paletteClassName: 'border-border/80 bg-card hover:border-emerald-500/50 hover:bg-muted/60',
  },
  join: {
    Icon: GitMerge,
    iconShape: 'rounded-lg rotate-45',
    accentClassName: 'bg-sky-500',
    canvasClassName: 'border-sky-500/45 bg-card text-foreground',
    handleClassName: 'border-sky-500/50 bg-sky-500',
    iconClassName: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    paletteClassName: 'border-border/80 bg-card hover:border-sky-500/50 hover:bg-muted/60',
  },
  end: {
    Icon: Flag,
    iconShape: 'rounded-full',
    accentClassName: 'bg-muted-foreground',
    canvasClassName: 'border-border/90 bg-card text-foreground',
    handleClassName: 'border-muted-foreground/50 bg-muted-foreground',
    iconClassName: 'bg-muted text-foreground',
    paletteClassName: 'border-border/80 bg-card hover:bg-muted/60',
  },
};

function statusDotTone(status: string | undefined): string {
  switch (status) {
    case 'running':
    case 'queued':
      return 'bg-primary';
    case 'completed':
    case 'passed':
    case 'ready':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-destructive';
    case 'waiting_for_user':
      return 'bg-amber-500';
    default:
      return 'bg-muted-foreground';
  }
}

function statusTextTone(status: string | undefined): string {
  switch (status) {
    case 'running':
    case 'queued':
      return 'text-primary';
    case 'completed':
    case 'passed':
    case 'ready':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'failed':
      return 'text-destructive';
    case 'waiting_for_user':
      return 'text-amber-600 dark:text-amber-400';
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

function useGraphLayout(scope: string, input: GraphLayoutInput, measured: boolean, dragging: boolean) {
  const [layout, setLayout] = useState<{ scope: string; shapeKey: string; result: GraphLayoutResult } | null>(null);
  const [status, setStatus] = useState<'idle' | 'pending' | 'failed'>('idle');
  const shapeKey = useMemo(() => JSON.stringify([input.nodes, input.edges]), [input]);
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
    let previous: { scope: string; shapeKey: string; result: GraphLayoutResult } | null = null;
    type Request = { arrange: boolean; context: typeof contextRef.current; resolve: (result: GraphLayoutResult | null) => void };
    let pending: Request | null = null;
    const drain = async () => {
      if (running) return;
      running = true;
      while (pending && !disposed) {
        const request = pending;
        pending = null;
        const { context } = request;
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
  labels: Pick<TeamRunGraphCanvasLabels, 'nodePalette' | 'nodePaletteTitle' | 'nodePaletteDescriptions'>;
  isOpen: boolean;
  isSaving: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAddNode: (kind: TeamGraphCanvasNodeKind) => void | Promise<void>;
};

function NodePaletteControl({ labels, isOpen, isSaving, onToggle, onClose, onAddNode }: NodePaletteControlProps) {
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
          className="flex h-9 items-center gap-2 rounded-full border border-border/80 bg-card/95 px-3 text-xs font-medium text-foreground shadow-lg shadow-slate-950/15 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          onClick={onToggle}
          disabled={isSaving}
          aria-expanded={isOpen}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{labels.nodePalette}</span>
        </button>
        {isOpen ? (
          <div className="mt-2 w-[19rem] rounded-2xl border border-border/80 bg-card p-1.5 shadow-xl shadow-slate-950/20">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{labels.nodePaletteTitle}</div>
            <div className="grid gap-0.5">
              {NODE_PALETTE.map((item) => {
                const visual = NODE_VISUALS[item.kind];
                const PaletteIcon = visual.Icon;
                return (
                  <button
                    key={item.kind}
                    type="button"
                    title={`${item.title}: ${labels.nodePaletteDescriptions[item.kind]}`}
                    className="group flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-foreground transition hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => { void onAddNode(item.kind); }}
                    disabled={isSaving}
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center border border-border/90 ${visual.iconClassName} ${visual.iconShape}`}>
                      <PaletteIcon className={`h-3.5 w-3.5 ${item.kind === 'join' ? '-rotate-45' : ''}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold tracking-tight">{item.title}</span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">{labels.nodePaletteDescriptions[item.kind]}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function readNodePrompt(node: TeamGraphNodeRecord | null): string {
  const prompt = node?.config?.prompt;
  return typeof prompt === 'string' ? prompt : '';
}

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
    maxAttempts: node.maxAttempts,
    config: kind === 'start' || kind === 'work' || kind === 'review' || kind === 'script_review' ? node.config : undefined,
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
    nodeSizes[node.nodeId] ?? newNodeSize,
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
  const bottom = Math.max(...nodes.map((node) => node.y + (nodeSizes[node.nodeId]?.height ?? NODE_HEIGHT)));
  return { x: start.x, y: Math.max(minY, bottom + CANVAS_PADDING / 2) };
}

function summarizeGraphEdge(edge: TeamGraphEdgeRecord, sourceNode: TeamGraphNodeRecord | null, runId: string) {
  return {
    runHash: summarizeIdentifier(runId).hash,
    edgeHash: summarizeIdentifier(edge.edgeId).hash,
    sourceNodeHash: summarizeIdentifier(edge.sourceNodeId).hash,
    targetNodeHash: summarizeIdentifier(edge.targetNodeId).hash,
    nodeKind: NODE_PALETTE.find((item) => item.kind === sourceNode?.kind)?.kind ?? 'unknown',
    canonicalSourcePort: summarizeTeamGraphPort(edge.sourcePort),
    action: TEAM_GRAPH_EDGE_ACTIONS.find((action) => action === edge.action) ?? null,
  };
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

function visualForNodeKind(kind: string | undefined): TeamGraphNodeVisual {
  return NODE_VISUALS[visualKindForNodeKind(kind)];
}

export function TeamRunGraphCanvas({
  graph,
  runStatus,
  roles = [],
  headerActions,
  emptyLabel,
  titleLabel,
  executorLabel,
  webhookAuth,
  labels,
  onPatchGraph,
  graphVersion,
  runtimeError,
  onRepairGraph,
  mode = onPatchGraph ? 'editable' : 'readonly',
  compact = false,
  mutationPending = false,
}: TeamRunGraphCanvasProps) {
  const canEdit = mode === 'editable' && Boolean(onPatchGraph);
  const repairGraph = onRepairGraph ?? (canEdit ? onPatchGraph : undefined);
  const canvasId = useId();
  const [zoom, setZoom] = useState<number | null>(null);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configurationSheet, setConfigurationSheet] = useState<ConfigurationSheet>(null);
  const [nodeTitle, setNodeTitle] = useState('');
  const [nodeMaxAttempts, setNodeMaxAttempts] = useState('');
  const [roleId, setRoleId] = useState('');
  const [sessionRef, setSessionRef] = useState('');
  const [newNode, setNewNode] = useState<{ node: TeamGraphNodeRecord; position: GraphPoint } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [outputArtifactKind, setOutputArtifactKind] = useState('');
  const [scriptReviewRule, setScriptReviewRule] = useState<TeamScriptReviewRule | ''>('');
  const [startTriggerMode, setStartTriggerMode] = useState<TeamGraphStartTriggerMode>('manual');
  const [startWebhookPath, setStartWebhookPath] = useState('');
  const [startWebhookPublicBaseUrl, setStartWebhookPublicBaseUrl] = useState('');
  const [startCronSchedule, setStartCronSchedule] = useState<CronScheduleDraft>(DEFAULT_CRON_SCHEDULE);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [edgeSourcePort, setEdgeSourcePort] = useState('');
  const [edgeTargetPort, setEdgeTargetPort] = useState('');
  const [newEdge, setNewEdge] = useState<TeamGraphEdgeRecord | null>(null);
  const [edgeAction, setEdgeAction] = useState<TeamGraphEdgeAction | ''>('');
  const [edgeIncludeUpstreamResult, setEdgeIncludeUpstreamResult] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [copiedWebhookPublicUrl, setCopiedWebhookPublicUrl] = useState(false);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [isNodePaletteOpen, setNodePaletteOpen] = useState(false);
  const [draftPositions, setDraftPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const [nodeSizes, setNodeSizes] = useState<Record<string, NodeSize>>({});
  const canvasScrollerRef = useRef<HTMLDivElement | null>(null);
  const nodeElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const suppressClickNodeIdRef = useRef<string | null>(null);

  const effectiveGraph = useMemo<TeamGraphSnapshotRecord>(() => graph ?? EMPTY_TEAM_GRAPH, [graph]);
  const graphRunId = effectiveGraph.runId ?? '';
  const layoutScope = JSON.stringify([graphRunId, effectiveGraph.graphId]);
  const layoutScopeRef = useRef(layoutScope);
  const [arrangedView, setArrangedView] = useState<{ scope: string; positions: Record<string, GraphPoint> } | null>(null);
  const draftScope = layoutScopeRef.current;
  const activeDrafts = useMemo(() => draftScope === layoutScope ? draftPositions : {}, [draftScope, layoutScope, draftPositions]);
  const viewPositions = !canEdit && arrangedView?.scope === layoutScope ? arrangedView.positions : undefined;
  const geometryKey = useMemo(() => {
    const sourcePortsByNode = new Map(effectiveGraph.nodes.map((node) => [node.nodeId, new Set(node.sourcePorts)]));
    for (const edge of effectiveGraph.edges) sourcePortsByNode.get(edge.sourceNodeId)?.add(edge.sourcePort ?? '');
    return JSON.stringify({
      nodes: effectiveGraph.nodes.map((node) => ({
        id: node.nodeId,
        width: nodeSizes[node.nodeId]?.width ?? NODE_WIDTH,
        height: nodeSizes[node.nodeId]?.height ?? NODE_HEIGHT,
        sourcePorts: [...sourcePortsByNode.get(node.nodeId)!],
      })).sort((a, b) => a.id.localeCompare(b.id)),
      edges: effectiveGraph.edges.map((edge) => ({
        id: edge.edgeId, source: edge.sourceNodeId, target: edge.targetNodeId,
        sourcePort: edge.sourcePort ?? '',
        rework: edge.action === 'rework' || edge.sourcePort === 'rework',
      })).sort((a, b) => a.id.localeCompare(b.id)),
      fixedPositions: Object.fromEntries(effectiveGraph.nodes.flatMap((node) => {
        const position = viewPositions?.[node.nodeId] ?? effectiveGraph.layout?.nodePositions?.[node.nodeId];
        return position ? [[node.nodeId, position]] : [];
      }).sort(([a], [b]) => String(a).localeCompare(String(b)))),
    });
  }, [effectiveGraph.nodes, effectiveGraph.edges, effectiveGraph.layout?.nodePositions, nodeSizes, viewPositions]);
  const layoutInput = useMemo(() => JSON.parse(geometryKey) as GraphLayoutInput, [geometryKey]);
  const nodesMeasured = effectiveGraph.nodes.every((node) => Boolean(nodeSizes[node.nodeId]));
  const currentGraphRef = useRef({ scope: layoutScope, input: layoutInput });
  useLayoutEffect(() => { currentGraphRef.current = { scope: layoutScope, input: layoutInput }; }, [layoutScope, layoutInput]);
  const { layout, shapeKey, status: layoutStatus, requestLayout, acceptLayout } = useGraphLayout(layoutScope, layoutInput, nodesMeasured, Boolean(dragNodeId) || isSaving);
  const positions = useMemo(() => {
    const next = { ...layout?.result.positions, ...layoutInput.fixedPositions, ...activeDrafts };
    return layout && Object.entries(next).every(([id, point]) => point.x === layout.result.positions[id]?.x && point.y === layout.result.positions[id]?.y)
      ? layout.result.positions : next;
  }, [layout, layoutInput, activeDrafts]);
  const positionedNodes = useMemo(() => effectiveGraph.nodes.map((node) => ({
    ...node, ...(positions[node.nodeId] ?? { x: 0, y: 0 }),
  })), [effectiveGraph.nodes, positions]);
  const visibleGeometry = useMemo(() => {
    if (layout?.shapeKey === shapeKey && positions === layout.result.positions) return layout.result;
    return routeGraphEdges({
      ...layoutInput,
      nodes: layoutInput.nodes.filter((node) => positions[node.id]),
      edges: layoutInput.edges.filter((edge) => positions[edge.source] && positions[edge.target]),
    }, positions);
  }, [layout, layoutInput, positions, shapeKey]);
  const nodeById = useMemo(
    () => new Map(positionedNodes.map((node) => [node.nodeId, node])),
    [positionedNodes],
  );
  const selectedNode = useMemo(() => (
    newNode?.node ?? effectiveGraph.nodes.find((node) => node.nodeId === selectedNodeId) ?? null
  ), [newNode, effectiveGraph.nodes, selectedNodeId]);
  const selectedNodeKind = selectedNode ? visualKindForNodeKind(selectedNode.kind) : null;
  const selectedEdge = useMemo(() => (
    newEdge ?? effectiveGraph.edges.find((edge) => edge.edgeId === selectedEdgeId) ?? null
  ), [newEdge, effectiveGraph.edges, selectedEdgeId]);
  const selectedEdgeSourceNode = useMemo(() => (
    selectedEdge ? effectiveGraph.nodes.find((node) => node.nodeId === selectedEdge.sourceNodeId) ?? null : null
  ), [effectiveGraph.nodes, selectedEdge]);
  const selectedEdgeTargetNode = useMemo(() => (
    selectedEdge ? effectiveGraph.nodes.find((node) => node.nodeId === selectedEdge.targetNodeId) ?? null : null
  ), [effectiveGraph.nodes, selectedEdge]);
  const sourcePorts = selectedEdgeSourceNode?.sourcePorts ?? EMPTY_PORTS;
  const targetPorts = selectedEdgeTargetNode?.targetPorts ?? EMPTY_PORTS;
  const patchSourcePort = sourcePorts.length === 1 ? sourcePorts[0] : edgeSourcePort;
  const patchTargetPort = targetPorts.length === 1 ? targetPorts[0] : edgeTargetPort;
  const edgePortsValid = sourcePorts.includes(patchSourcePort) && targetPorts.includes(patchTargetPort);
  const edgeActions = edgeActionCandidates(selectedEdgeSourceNode, patchSourcePort, selectedEdgeTargetNode);
  const edgeActionValid = edgeAction !== '' && edgeActions.includes(edgeAction);
  const roleBindings = useMemo(() => roles.filter((role) => role.runId === graphRunId && Boolean(role.sessionRef)), [roles, graphRunId]);
  const roleBindingValid = roleBindings.some((role) => role.roleId === roleId && role.sessionRef === sessionRef);
  const changeRoleBinding = (role: string, session: string) => { setRoleId(role); setSessionRef(session); };
  const [origin, setOrigin] = useState({ scope: layoutScope, x: 0, y: 0 });
  const canvasOrigin = {
    x: Math.min(origin.scope === layoutScope ? origin.x : 0, visibleGeometry.bounds.x - CANVAS_PADDING),
    y: Math.min(origin.scope === layoutScope ? origin.y : 0, visibleGeometry.bounds.y - CANVAS_PADDING),
  };
  const canvasWidth = Math.max(NODE_WIDTH + CANVAS_PADDING * 2, visibleGeometry.bounds.x + visibleGeometry.bounds.width + CANVAS_PADDING - canvasOrigin.x);
  const canvasHeight = Math.max(NODE_HEIGHT + CANVAS_PADDING * 2, visibleGeometry.bounds.y + visibleGeometry.bounds.height + CANVAS_PADDING - canvasOrigin.y);
  const fitScale = Math.min(1, viewportSize.width > 0 ? viewportSize.width / canvasWidth : 1, viewportSize.height > 0 ? viewportSize.height / canvasHeight : 1);
  const canvasScale = zoom ?? fitScale;
  const canvasReady = readyScope === layoutScope || effectiveGraph.nodes.length === 0;
  const webhookPublicUrl = buildWebhookPublicUrl(startWebhookPublicBaseUrl, startWebhookPath);

  useLayoutEffect(() => {
    const sameScope = origin.scope === layoutScope;
    if (sameScope && origin.x === canvasOrigin.x && origin.y === canvasOrigin.y) return;
    const scroller = canvasScrollerRef.current;
    if (sameScope && scroller && zoom !== null) {
      scroller.scrollLeft += (origin.x - canvasOrigin.x) * canvasScale;
      scroller.scrollTop += (origin.y - canvasOrigin.y) * canvasScale;
    }
    setOrigin({ scope: layoutScope, x: canvasOrigin.x, y: canvasOrigin.y });
  }, [origin, layoutScope, canvasOrigin.x, canvasOrigin.y, canvasScale, zoom]);

  useEffect(() => {
    const element = canvasScrollerRef.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setViewportSize({
        width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (layout?.shapeKey !== shapeKey || layoutStatus !== 'idle' || !nodesMeasured || layoutInput.nodes.length === 0 || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    if (zoom === null || readyScope !== layoutScope) setZoom(fitScale);
    if (readyScope !== layoutScope) setReadyScope(layoutScope);
  }, [zoom, layout, shapeKey, layoutStatus, nodesMeasured, layoutInput.nodes.length, viewportSize, fitScale, readyScope, layoutScope]);

  const cancelDragFrame = useCallback(() => {
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
  }, []);

  useLayoutEffect(() => {
    setDragNodeId(null);
    setDraftPositions((current) => hasRecordEntries(current) ? {} : current);
    return () => {
      cancelDragFrame();
      dragRef.current = null;
    };
  }, [layoutScope, canEdit, cancelDragFrame]);

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
    setFormError(null);
  }, [layoutScope, canEdit]);

  useEffect(() => {
    if (layoutScopeRef.current !== layoutScope) {
      layoutScopeRef.current = layoutScope;
      setArrangedView(null);
      setNodeSizes({});
      return;
    }
    setDraftPositions((current) => {
      const activeNodeIds = new Set(effectiveGraph.nodes.map((node) => node.nodeId));
      let changed = false;
      const next: Record<string, { x: number; y: number }> = {};
      for (const [nodeId, position] of Object.entries(current)) {
        const saved = effectiveGraph.layout?.nodePositions?.[nodeId];
        if (activeNodeIds.has(nodeId) && (dragNodeId === nodeId || saved?.x !== position.x || saved?.y !== position.y)) {
          next[nodeId] = position;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [effectiveGraph.nodes, effectiveGraph.layout?.nodePositions, layoutScope, dragNodeId]);

  const nodeIdsKey = useMemo(() => JSON.stringify(effectiveGraph.nodes.map((node) => node.nodeId).sort()), [effectiveGraph.nodes]);
  useEffect(() => {
    const activeNodeIds = new Set<string>(JSON.parse(nodeIdsKey));
    for (const nodeId of Object.keys(nodeElementsRef.current)) {
      if (!activeNodeIds.has(nodeId)) delete nodeElementsRef.current[nodeId];
    }
  }, [nodeIdsKey]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      setNodeSizes((current) => {
        let changed = false;
        const next = { ...current };
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
        const next = { ...current };
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
  }, [nodeIdsKey, layoutScope]);

  useEffect(() => {
    setCopiedWebhookPublicUrl(false);
  }, [startWebhookPath, startWebhookPublicBaseUrl]);

  const resetNodeDraft = useCallback(() => {
    if (!selectedNode) {
      setNodeTitle('');
      setNodeMaxAttempts('');
      setRoleId('');
      setSessionRef('');
      setPrompt('');
      setOutputArtifactKind('');
      setScriptReviewRule('');
      return;
    }
    setNodeTitle(selectedNode.title ?? '');
    setNodeMaxAttempts(selectedNode.maxAttempts === undefined ? '' : String(selectedNode.maxAttempts));
    setRoleId((selectedNode?.roleId ?? ''));
    setSessionRef(selectedNode.config?.sessionRef ?? '');
    setPrompt(readNodePrompt(selectedNode));
    setOutputArtifactKind(selectedNode.config?.outputArtifactKind ?? '');
    setScriptReviewRule(selectedNode.config?.rule ?? '');
    const trigger = readStartTrigger(selectedNode);
    setStartTriggerMode(trigger.mode);
    setStartWebhookPath(trigger.path);
    setStartWebhookPublicBaseUrl('');
    setStartCronSchedule(trigger.cron);
    setFormError(null);
  }, [selectedNode]);

  useEffect(resetNodeDraft, [resetNodeDraft]);

  const closeNodeEditor = () => {
    resetNodeDraft();
    setConfigurationSheet(null);
    setNewNode(null);
  };

  const resetEdgeDraft = useCallback(() => {
    if (!selectedEdge) {
      setEdgeSourcePort('');
      setEdgeTargetPort('');
      setEdgeAction('');
      setEdgeIncludeUpstreamResult(true);
      return;
    }
    const nextSourcePort = selectedEdge.sourcePort ?? '';
    setEdgeSourcePort(nextSourcePort);
    setEdgeTargetPort(selectedEdge.targetPort ?? '');
    setEdgeAction(selectedEdge.action ?? '');
    setEdgeIncludeUpstreamResult(selectedEdge.payload?.includeUpstreamResult !== false);
    setFormError(null);
  }, [selectedEdge]);

  useEffect(resetEdgeDraft, [resetEdgeDraft, selectedEdgeSourceNode]);

  const closeEdgeEditor = () => {
    resetEdgeDraft();
    setConfigurationSheet(null);
    setNewEdge(null);
  };

  useEffect(() => {
    if (configurationSheet?.kind !== 'edge' || !selectedEdge) return;
    logSessionTrace('renderer.team_run.edge.configuration.observed', createSessionTraceId('team-edge-config'), () => ({
      ...summarizeGraphEdge(selectedEdge, selectedEdgeSourceNode, graphRunId),
      editable: canEdit,
      canonicalSourcePortMissing: selectedEdge.sourcePort == null,
      uiSourcePort: summarizeTeamGraphPort(edgeSourcePort),
      uiSourcePortInOptions: sourcePorts.includes(edgeSourcePort),
      uiTargetPort: summarizeTeamGraphPort(edgeTargetPort),
      uiTargetPortInOptions: targetPorts.includes(edgeTargetPort),
      patchSourcePort: summarizeTeamGraphPort(patchSourcePort),
      patchTargetPort: summarizeTeamGraphPort(patchTargetPort),
      uiAction: TEAM_GRAPH_EDGE_ACTIONS.find((action) => action === edgeAction) ?? null,
    }));
  }, [configurationSheet, selectedEdge, selectedEdgeSourceNode, graphRunId, canEdit, edgeSourcePort, edgeTargetPort, edgeAction, sourcePorts, targetPorts, patchSourcePort, patchTargetPort]);

  const submitGraphPatch = async (operations: TeamGraphPatchOperation[]): Promise<boolean> => {
    if (!canEdit || !onPatchGraph || isSaving || mutationPending) return false;
    const scope = currentGraphRef.current.scope;
    setIsSaving(true);
    setFormError(null);
    try {
      await onPatchGraph(operations);
      return currentGraphRef.current.scope === scope;
    } catch (error) {
      if (currentGraphRef.current.scope === scope) setFormError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (currentGraphRef.current.scope === scope) setIsSaving(false);
    }
  };

  const handleAutoLayout = async (): Promise<void> => {
    const context = currentGraphRef.current;
    const result = await requestLayout(true);
    if (!result || currentGraphRef.current !== context) return;
    if (!canEdit) {
      acceptLayout(result);
      setArrangedView({ scope: layoutScope, positions: result.positions });
      setOrigin({ scope: layoutScope, x: Math.min(0, result.bounds.x - CANVAS_PADDING), y: Math.min(0, result.bounds.y - CANVAS_PADDING) });
      setZoom(null);
      return;
    }
    setDraftPositions(result.positions);
    const saved = await submitGraphPatch(Object.entries(result.positions).map(([nodeId, position]) => ({
      op: 'set_node_position', nodeId, position,
    })));
    if (currentGraphRef.current.scope !== context.scope) return;
    setDraftPositions({});
    if (saved && JSON.stringify([context.input.nodes, context.input.edges]) === JSON.stringify([currentGraphRef.current.input.nodes, currentGraphRef.current.input.edges])) {
      acceptLayout(result);
      setOrigin({ scope: layoutScope, x: Math.min(0, result.bounds.x - CANVAS_PADDING), y: Math.min(0, result.bounds.y - CANVAS_PADDING) });
      setZoom(null);
    }
  };

  const appendEdge = async (input: { sourceNodeId: string; targetNodeId: string; sourcePort: string }): Promise<void> => {
    if (!input.sourceNodeId || !input.targetNodeId || input.sourceNodeId === input.targetNodeId) {
      setFormError(`${labels.sourceNode} / ${labels.targetNode}`);
      return;
    }
    const source = nodeById.get(input.sourceNodeId);
    const target = nodeById.get(input.targetNodeId);
    if (!source?.sourcePorts?.includes(input.sourcePort) || target?.targetPorts?.length !== 1) {
      setFormError(labels.noPort);
      return;
    }
    const actions = edgeActionCandidates(source, input.sourcePort, target);
    if (actions.length === 0) {
      setFormError(labels.noEdgeAction);
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
    if (await submitGraphPatch([{ op: 'add_edge', edge: graphPatchEdge(nextEdge) }])) {
      setSelectedEdgeId(nextEdge.edgeId);
      setConfigurationSheet({ kind: 'edge', edgeId: nextEdge.edgeId });
    }
  };

  const copyTextToClipboard = async (value: string, onCopied: (copied: boolean) => void): Promise<void> => {
    const text = value.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onCopied(true);
      window.setTimeout(() => onCopied(false), 1500);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const buildStartConfig = (): TeamGraphNodeConfigRecord | null => {
    if (startTriggerMode === 'manual') return {};
    const normalizedWebhookPath = normalizeWebhookPathInput(startWebhookPath);
    if (startTriggerMode === 'webhook' && !normalizedWebhookPath) {
      setFormError(labels.startWebhookPathRequired);
      return null;
    }
    if (startTriggerMode === 'webhook' && normalizedWebhookPath.includes('..')) {
      setFormError(labels.startWebhookPathInvalid);
      return null;
    }
    const cronExpression = buildCronExpression(startCronSchedule);
    if (startTriggerMode === 'cron' && !cronExpression) {
      setFormError(labels.startCronCustomValueRequired);
      return null;
    }
    return { trigger: startTriggerMode === 'cron'
      ? { mode: 'cron', cron: cronExpression! }
      : { mode: 'webhook', path: normalizedWebhookPath } };
  };

  const handleSaveNode = async (): Promise<void> => {
    if (!selectedNode) return;
    const maxAttempts = readPositiveIntegerInRange(nodeMaxAttempts, 1, NODE_MAX_ATTEMPTS_LIMIT);
    if (maxAttempts === null) {
      setFormError(labels.nodeMaxAttemptsInvalid);
      return;
    }
    let config: TeamGraphNodeConfigRecord | undefined;
    if (selectedNode.kind === 'start') {
      const startConfig = buildStartConfig();
      if (!startConfig) return;
      config = startConfig;
    }
    if (selectedNode.kind === 'script_review') {
      if (!scriptReviewRule) {
        setFormError(labels.scriptReviewRuleRequired);
        return;
      }
      config = { rule: scriptReviewRule };
    }
    if (selectedNode.kind === 'work' || selectedNode.kind === 'review') {
      if (!roleBindingValid) {
        setFormError(labels.roleBindingRequired);
        return;
      }
      config = { prompt, sessionRef, ...(selectedNode.kind === 'work' && outputArtifactKind.trim() ? { outputArtifactKind: outputArtifactKind.trim() } : {}) };
    }
    const nextNode = graphPatchNode({
      ...selectedNode,
      title: nodeTitle.trim() || undefined,
      maxAttempts,
      roleId,
      config,
    });
    const operations: TeamGraphPatchOperation[] = newNode
      ? [{ op: 'add_node', node: nextNode }, { op: 'set_node_position', nodeId: selectedNode.nodeId, position: newNode.position }]
      : [{ op: 'replace_node', node: nextNode }];
    if (await submitGraphPatch(operations)) {
      setNewNode(null);
      setSelectedNodeId(selectedNode.nodeId);
      setConfigurationSheet(null);
    }
  };

  const handleSaveEdge = async (): Promise<void> => {
    if (!selectedEdge) return;
    if (!edgePortsValid) {
      setFormError(labels.noPort);
      return;
    }
    if (!edgeActionValid || !edgeAction) {
      setFormError(edgeActions.length === 0 ? labels.noEdgeAction : labels.selectEdgeAction);
      return;
    }
    const nextEdge = graphPatchEdge({
      ...selectedEdge,
      sourcePort: patchSourcePort,
      targetPort: patchTargetPort,
      action: edgeAction,
      payload: { includeUpstreamResult: edgeIncludeUpstreamResult },
    });
    logSessionTrace('renderer.team_run.edge.patch.requested', createSessionTraceId('team-edge-patch'), () => ({
      ...summarizeGraphEdge(selectedEdge, selectedEdgeSourceNode, graphRunId),
      operation: newEdge ? 'add_edge' : 'replace_edge',
      canonicalSourcePortMissing: selectedEdge.sourcePort == null,
      uiSourcePort: summarizeTeamGraphPort(edgeSourcePort),
      uiTargetPort: summarizeTeamGraphPort(edgeTargetPort),
      patchSourcePort: summarizeTeamGraphPort(patchSourcePort),
      patchTargetPort: summarizeTeamGraphPort(patchTargetPort),
      patchAction: TEAM_GRAPH_EDGE_ACTIONS.find((action) => action === nextEdge.action) ?? null,
      sourcePortAutomaticallyCorrected: patchSourcePort !== edgeSourcePort,
      targetPortAutomaticallyCorrected: patchTargetPort !== edgeTargetPort,
      canEdit, isSaving, mutationPending,
    }));
    if (await submitGraphPatch([{ op: newEdge ? 'add_edge' : 'replace_edge', edge: nextEdge }])) {
      setNewEdge(null);
      setConfigurationSheet(null);
    }
  };

  const handleDeleteNode = async (): Promise<void> => {
    if (!selectedNode) return;
    if (newNode) { setNewNode(null); setConfigurationSheet(null); return; }
    if (await submitGraphPatch([{ op: 'remove_node', nodeId: selectedNode.nodeId }])) {
      setSelectedNodeId(null);
      setConfigurationSheet(null);
    }
  };

  const handleDeleteEdge = async (): Promise<void> => {
    if (!selectedEdge) return;
    if (newEdge) { setNewEdge(null); setConfigurationSheet(null); return; }
    if (await submitGraphPatch([{ op: 'remove_edge', edgeId: selectedEdge.edgeId }])) {
      setSelectedEdgeId(null);
      setConfigurationSheet(null);
    }
  };

  const handleAddNode = async (kind: TeamGraphCanvasNodeKind): Promise<void> => {
    const paletteItem = NODE_PALETTE.find((item) => item.kind === kind)!;
    const nodeId = createProjectionNodeId(kind);
    const viewport = readCanvasViewport(canvasScrollerRef.current);
    const rawPosition = nextNodePosition(positionedNodes, nodeSizes, viewport ? {
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
      title: paletteItem.title,
      maxAttempts: DEFAULT_NODE_MAX_ATTEMPTS,
      sourcePortActions: {},
      status: 'pending',
      ...(kind === 'work' || kind === 'review' ? { roleId: binding?.roleId } : {}),
      ...(kind === 'work' ? { taskId: nodeId } : {}),
      config: kind === 'work' || kind === 'review' ? { prompt: paletteItem.title, sessionRef: binding?.sessionRef } : undefined,
    };
    if (kind === 'start' || kind === 'work' || kind === 'review' || kind === 'script_review' || kind === 'join') {
      setNewNode({ node, position });
      setConfigurationSheet({ kind: 'node', nodeId });
      setNodePaletteOpen(false);
      return;
    }
    if (await submitGraphPatch([
      { op: 'add_node', node: graphPatchNode(node) },
      { op: 'set_node_position', nodeId, position },
    ])) {
      setSelectedNodeId(nodeId);
      setNodePaletteOpen(false);
    }
  };


  const handleNodePointerDown = (event: PointerEvent<HTMLDivElement>, node: PositionedNode): void => {
    if (!canEdit || isSaving || mutationPending || dragRef.current || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      nodeId: node.nodeId,
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      nodeStartX: node.x,
      nodeStartY: node.y,
      currentX: node.x,
      currentY: node.y,
      moved: false,
    };
    setDragNodeId(node.nodeId);
  };

  const updateDragPosition = (event: PointerEvent<HTMLDivElement>): DragState | null => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return null;
    const dx = event.clientX - drag.pointerStartX;
    const dy = event.clientY - drag.pointerStartY;
    drag.currentX = Math.max(Math.min(CANVAS_PADDING / 2, drag.nodeStartX), drag.nodeStartX + dx / canvasScale);
    drag.currentY = Math.max(Math.min(CANVAS_PADDING / 2, drag.nodeStartY), drag.nodeStartY + dy / canvasScale);
    drag.moved ||= Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
    return drag;
  };

  const handleNodePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = updateDragPosition(event);
    if (!drag?.moved || dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const latest = dragRef.current!;
      const position = { x: latest.currentX, y: latest.currentY };
      setDraftPositions((current) => ({ ...current, [latest.nodeId]: position }));
    });
  };

  const handleNodePointerUp = async (event: PointerEvent<HTMLDivElement>): Promise<void> => {
    const finishedDrag = updateDragPosition(event);
    if (!finishedDrag) return;
    cancelDragFrame();
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const scope = currentGraphRef.current.scope;
    setDragNodeId(null);
    if (finishedDrag.moved) {
      const position = { x: Math.round(finishedDrag.currentX), y: Math.round(finishedDrag.currentY) };
      setDraftPositions((current) => ({ ...current, [finishedDrag.nodeId]: position }));
      suppressClickNodeIdRef.current = finishedDrag.nodeId;
      window.setTimeout(() => { suppressClickNodeIdRef.current = null; }, 0);
      await submitGraphPatch([{ op: 'set_node_position', nodeId: finishedDrag.nodeId, position }]);
      if (currentGraphRef.current.scope === scope) {
        setDraftPositions((current) => Object.fromEntries(Object.entries(current).filter(([nodeId]) => nodeId !== finishedDrag.nodeId)));
      }
    }
  };

  const handleNodePointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cancelDragFrame();
    dragRef.current = null;
    setDraftPositions((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== drag.nodeId)));
    setDragNodeId(null);
  };

  const handleStartConnection = (event: MouseEvent<HTMLButtonElement>, node: TeamGraphNodeRecord, sourcePort: string): void => {
    event.stopPropagation();
    setConnectionDraft({ sourceNodeId: node.nodeId, sourcePort });
  };

  const handleFinishConnection = (event: MouseEvent<HTMLButtonElement>, target: TeamGraphNodeRecord): void => {
    event.stopPropagation();
    if (!connectionDraft) return;
    void appendEdge({
      sourceNodeId: connectionDraft.sourceNodeId,
      targetNodeId: target.nodeId,
      sourcePort: connectionDraft.sourcePort,
    });
    setConnectionDraft(null);
  };

  return (
    <div className={compact ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-3' : 'min-w-0 space-y-3'}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-card p-3 shadow-sm">
        <div>
          <div className="text-sm font-medium">{titleLabel}</div>
          <div className="text-xs text-muted-foreground">
            {formatTemplate(labels.nodeCount, { count: effectiveGraph.nodes.length })} · {formatTemplate(labels.edgeCount, { count: effectiveGraph.edges.length })}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {roles.length > 0 ? (
            <div className="flex -space-x-2" aria-label={labels.teamRoles}>
              {roles.slice(0, 4).map((role) => (
                <div key={`${role.roleId}:${role.sessionRef}`} title={`${role.roleId} · ${role.agentId}`} className="grid h-8 w-8 place-items-center rounded-full border-2 border-background bg-primary/15 text-[10px] font-semibold text-primary">
                  {role.roleId.slice(0, 2).toUpperCase()}
                </div>
              ))}
              {roles.length > 4 ? <div className="grid h-8 min-w-8 place-items-center rounded-full border-2 border-background bg-muted px-2 text-[10px] font-semibold text-muted-foreground">+{roles.length - 4}</div> : null}
            </div>
          ) : null}
          {headerActions}
          {connectionDraft ? <div className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-xs text-primary">{labels.connectionDraft}: {labels.portLabels[connectionDraft.sourcePort] ?? connectionDraft.sourcePort}</div> : null}
          <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/35 px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
            {runStatus ? (
              <span className={`flex items-center gap-1.5 ${statusTextTone(runStatus)}`} title={`${labels.runStatusLabel}: ${statusLabel(runStatus, labels)}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotTone(runStatus)}`} />
                <span>{statusLabel(runStatus, labels)}</span>
              </span>
            ) : null}
            {runStatus ? <span className="h-3 w-px bg-border" aria-hidden="true" /> : null}
            <span className={`flex items-center gap-1.5 ${statusTextTone(effectiveGraph.status)}`} title={`${labels.graphStatusLabel}: ${statusLabel(effectiveGraph.status, labels)}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotTone(effectiveGraph.status)}`} />
              <span>{statusLabel(effectiveGraph.status, labels)}</span>
            </span>
          </div>
        </div>
      </div>

      {repairGraph ? <TeamGraphPortRepair
        key={`${layoutScope}:${graphVersion ?? ''}`}
        graph={effectiveGraph}
        runtimeError={runtimeError}
        edgePatch={graphPatchEdge}
        labels={labels}
        pending={isSaving || mutationPending}
        onSave={async (operations) => {
          if (isSaving || mutationPending) return;
          const scope = currentGraphRef.current.scope;
          setIsSaving(true);
          try {
            await repairGraph(operations);
          } finally {
            if (currentGraphRef.current.scope === scope) setIsSaving(false);
          }
        }}
      /> : null}
      {formError ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{formError}</div> : null}

      <div className={compact ? 'relative flex min-h-0 flex-1 flex-col gap-2' : 'relative'} aria-busy={!canvasReady && layoutStatus !== 'failed'}>
          {!canvasReady && layoutStatus !== 'failed' ? <span role="status" className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{labels.layoutPending ?? 'Arranging…'}</span> : null}
          <div className="flex items-center justify-end gap-1 pb-2 text-xs" style={{ visibility: canvasReady || layoutStatus === 'failed' ? 'visible' : 'hidden' }}>
            {layoutStatus === 'pending' ? <span role="status" className="mr-2 text-muted-foreground">{labels.layoutPending ?? 'Arranging…'}</span> : null}
            {layoutStatus === 'failed' ? <span role="alert" className="mr-2 text-destructive">{labels.layoutFailed ?? 'Layout failed. Try arranging again.'}</span> : null}
            <button type="button" className="rounded border px-2 py-1.5 hover:bg-muted disabled:opacity-50" onClick={() => { void handleAutoLayout(); }} disabled={isSaving || mutationPending || Boolean(dragNodeId) || !nodesMeasured || effectiveGraph.nodes.length === 0}>
              {labels.autoLayout ?? 'Auto layout'}
            </button>
            <div className="flex items-center gap-1" style={{ visibility: canvasReady ? 'visible' : 'hidden' }}>
            <button type="button" className="rounded border p-1.5 hover:bg-muted" aria-label={labels.zoomOut ?? '−'} title={labels.zoomOut} onClick={() => setZoom(canvasScale / 1.2)}>
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-10 text-center tabular-nums text-muted-foreground">{Math.round(canvasScale * 100)}%</span>
            <button type="button" className="rounded border p-1.5 hover:bg-muted" aria-label={labels.zoomIn ?? '+'} title={labels.zoomIn} onClick={() => setZoom(Math.min(2, canvasScale * 1.2))}>
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="rounded border p-1.5 hover:bg-muted" aria-label={labels.fitToView ?? labels.workflowCanvas} title={labels.fitToView} onClick={() => {
              const x = Math.min(0, visibleGeometry.bounds.x - CANVAS_PADDING);
              const y = Math.min(0, visibleGeometry.bounds.y - CANVAS_PADDING);
              setOrigin({ scope: layoutScope, x, y });
              setZoom(Math.min(1, viewportSize.width / (visibleGeometry.bounds.x + visibleGeometry.bounds.width + CANVAS_PADDING - x), viewportSize.height / (visibleGeometry.bounds.y + visibleGeometry.bounds.height + CANVAS_PADDING - y)));
              canvasScrollerRef.current?.scrollTo({ left: 0, top: 0 });
            }}>
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            </div>
          </div>
        <div className={compact ? 'relative flex min-h-0 flex-1 flex-col' : 'relative'}>
        <StableScrollArea ref={canvasScrollerRef} data-team-graph-canvas="true" inert={!canvasReady} style={{ opacity: canvasReady ? 1 : 0 }} className={`relative overflow-auto rounded-2xl border border-border bg-muted/25 p-4 text-foreground shadow-inner ${compact ? 'min-h-[240px] max-h-[60vh] flex-1' : 'h-[520px]'}`}>
          <div className="overflow-hidden" style={{ width: canvasWidth * canvasScale, height: canvasHeight * canvasScale }}>
          <div
            aria-label={labels.workflowCanvas}
            className="relative rounded-xl"
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
              backgroundImage: 'radial-gradient(circle at 1px 1px, hsl(var(--border)) 1px, transparent 0)',
              backgroundSize: '22px 22px',
            }}
          >
            <svg className="absolute inset-0" width={canvasWidth} height={canvasHeight} viewBox={`${canvasOrigin.x} ${canvasOrigin.y} ${canvasWidth} ${canvasHeight}`} role="img" aria-label={labels.workflowEdges}>
              <defs>
                {[...Object.values(EDGE_VISUALS), FALLBACK_EDGE_VISUAL].map((visual) => (
                  <marker key={visual.markerId} id={`${canvasId}-${visual.markerId}`} markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L0,6 L9,3 z" fill={visual.stroke} />
                  </marker>
                ))}
              </defs>
              {effectiveGraph.edges.map((edge) => {
                const source = nodeById.get(edge.sourceNodeId ?? edge.fromNodeId ?? '');
                const target = nodeById.get(edge.targetNodeId ?? edge.toNodeId ?? '');
                if (!source || !target) {
                  return null;
                }
                const route = visibleGeometry.routes[edge.edgeId];
                if (!route || !nodesMeasured) return null;
                const path = route.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
                const labelX = route.label.x;
                const labelY = route.label.y;
                const edgeVisual = edgeVisualForEdge(edge);
                const edgeLabel = edgeDisplayLabel(edge);
                const isSelectedEdge = selectedEdgeId === edge.edgeId;
                const isHoveredEdge = hoveredEdgeId === edge.edgeId;
                const shouldShowEdgeLabel = Boolean(edgeLabel && (isSelectedEdge || isHoveredEdge));
                return (
                  <g key={edge.edgeId} onMouseEnter={() => setHoveredEdgeId(edge.edgeId)} onMouseLeave={() => setHoveredEdgeId((current) => current === edge.edgeId ? null : current)}>
                    <path
                      d={path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="14"
                      strokeLinecap="round"
                      className="cursor-pointer"
                      role="button"
                      tabIndex={0}
                      aria-label={`${source.title ?? source.nodeId} → ${target.title ?? target.nodeId}: ${edge.sourcePort ?? edge.action ?? ''}`}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedEdgeId(edge.edgeId);
                        setConfigurationSheet({ kind: 'edge', edgeId: edge.edgeId });
                      }}
                      onFocus={() => setHoveredEdgeId(edge.edgeId)}
                      onBlur={() => setHoveredEdgeId(null)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedEdgeId(edge.edgeId);
                        setConfigurationSheet({ kind: 'edge', edgeId: edge.edgeId });
                      }}
                    />
                    <path
                      d={path}
                      fill="none"
                      stroke={edgeVisual.stroke}
                      strokeWidth={isSelectedEdge ? '3.5' : '2.5'}
                      strokeLinecap="round"
                      strokeDasharray={edgeVisual.dashArray}
                      markerEnd={`url(#${canvasId}-${edgeVisual.markerId})`}
                      className="pointer-events-none"
                    />
                    {shouldShowEdgeLabel ? (
                      <foreignObject x={labelX - 54} y={labelY - 12} width="108" height="26">
                        <button
                          type="button"
                          aria-label={edgeLabel}
                          className={`w-full truncate rounded-full border px-2 py-1 text-center text-[10px] shadow-sm ${edgeVisual.labelClassName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedEdgeId(edge.edgeId);
                            setConfigurationSheet({ kind: 'edge', edgeId: edge.edgeId });
                          }}
                        >
                          {edgeLabel}
                        </button>
                      </foreignObject>
                    ) : null}
                  </g>
                );
              })}
            </svg>

            {effectiveGraph.nodes.length === 0 ? (
              <div className="absolute left-1/2 top-1/2 w-[22rem] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-dashed border-border bg-background/90 p-5 text-center shadow-sm">
                <div className="text-sm font-semibold text-foreground">{titleLabel}</div>
                <div className="mt-2 text-xs text-muted-foreground">{emptyLabel}</div>
              </div>
            ) : null}

            {positionedNodes.map((node) => {
              const isSelected = selectedNode?.nodeId === node.nodeId;
              const visual = visualForNodeKind(node.kind);
              const NodeIcon = visual.Icon;
              const connectionSources = node.sourcePorts ?? EMPTY_PORTS;
              return (
                <div
                  key={node.nodeId}
                  ref={(element) => { nodeElementsRef.current[node.nodeId] = element; }}
                  data-node-id={node.nodeId}
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (suppressClickNodeIdRef.current === node.nodeId) return;
                    setSelectedNodeId(node.nodeId);
                    setConfigurationSheet({ kind: 'node', nodeId: node.nodeId });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedNodeId(node.nodeId);
                      setConfigurationSheet({ kind: 'node', nodeId: node.nodeId });
                    }
                  }}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={(event) => { void handleNodePointerUp(event); }}
                  onPointerCancel={handleNodePointerCancel}
                  className={`absolute ${canEdit ? 'cursor-grab active:cursor-grabbing touch-none' : 'cursor-pointer'} rounded-[18px] border p-0 text-left shadow-md shadow-slate-900/10 transition hover:border-primary/40 hover:shadow-lg hover:shadow-slate-900/15 ${visual.canvasClassName} ${isSelected ? 'ring-2 ring-primary/35 ring-offset-2 ring-offset-background' : ''}`}
                  style={{ left: node.x - canvasOrigin.x, top: node.y - canvasOrigin.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT, visibility: positions[node.nodeId] && nodeSizes[node.nodeId] ? 'visible' : 'hidden' }}
                >
                  <div className={`h-1 w-full rounded-t-[17px] ${visual.accentClassName}`} />
                  {canEdit ? <>
                  {node.targetPorts?.length === 1 && (!connectionDraft || edgeActionCandidates(nodeById.get(connectionDraft.sourceNodeId), connectionDraft.sourcePort, node).length > 0) ? <button
                    type="button"
                    aria-label={formatTemplate(labels.connectToNode, { title: node.title ?? node.nodeId })}
                    className="group absolute -left-5 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => handleFinishConnection(event, node)}
                  >
                    <span className={`h-4 w-4 rounded-full border shadow-sm transition group-hover:ring-4 group-hover:ring-primary/10 group-focus-visible:ring-4 group-focus-visible:ring-primary/10 ${connectionDraft ? visual.handleClassName : 'border-border bg-background'}`} />
                  </button> : null}
                  <div className="absolute -right-5 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1">
                    {connectionSources.map((source) => (
                      <button
                        key={source}
                        type="button"
                        aria-label={`${formatTemplate(labels.connectFromNode, { title: node.title ?? node.nodeId })}: ${labels.portLabels[source] ?? source}`}
                        title={labels.portLabels[source] ?? source}
                        className="group grid h-8 w-10 place-items-center rounded-full"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => handleStartConnection(event, node, source)}
                      >
                        <span className={`h-4 w-4 rounded-full border shadow-sm transition group-hover:ring-4 group-hover:ring-primary/10 group-focus-visible:ring-4 group-focus-visible:ring-primary/10 ${connectionDraft?.sourceNodeId === node.nodeId && connectionDraft.sourcePort === source ? visual.handleClassName : 'border-border bg-background'}`} />
                      </button>
                    ))}
                  </div>
                  </> : null}
                  <div className="space-y-3 p-3">
                    <div className="flex items-start gap-3">
                      <div className={`grid h-10 w-10 shrink-0 place-items-center border border-border/90 ${visual.iconClassName} ${visual.iconShape}`}>
                        <NodeIcon className={`h-4 w-4 ${visualKindForNodeKind(node.kind) === 'join' ? '-rotate-45' : ''}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold tracking-tight text-foreground">{node.title ?? node.nodeId}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-80">
                          <span className="rounded-full border border-border/80 bg-muted/70 px-1.5 py-0.5 text-muted-foreground">{node.kind ?? 'node'}</span>
                          <span className="rounded-full border border-border/80 bg-muted/70 px-1.5 py-0.5 text-muted-foreground">{statusLabel(node.status, labels)}</span>
                        </div>
                      </div>
                    </div>
                    {(node.roleId ?? '') ? (
                      <div className="flex items-center justify-between rounded-xl border border-border/80 bg-muted/50 px-2 py-1.5 text-[11px]">
                        <span className="truncate text-muted-foreground">{executorLabel}</span>
                        <span className="ml-2 truncate font-medium text-foreground">{(node.roleId ?? '')}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        </StableScrollArea>

        {canEdit ? <NodePaletteControl
          labels={labels}
          isOpen={isNodePaletteOpen}
          isSaving={isSaving || mutationPending}
          onToggle={() => setNodePaletteOpen((open) => !open)}
          onClose={() => setNodePaletteOpen(false)}
          onAddNode={(kind) => { void handleAddNode(kind); }}
        /> : null}
        </div>
      </div>

      <Sheet open={configurationSheet !== null} onOpenChange={(open) => {
        if (!open && !isSaving && !mutationPending) {
          if (configurationSheet?.kind === 'node') closeNodeEditor();
          else closeEdgeEditor();
        }
      }}>
        {configurationSheet?.kind === 'node' && selectedNode && selectedNodeKind ? (
          <TeamNodeInspector
            key={selectedNode.nodeId}
            node={selectedNode}
            kind={selectedNodeKind}
            editable={canEdit}
            pending={isSaving || mutationPending}
            isNew={Boolean(newNode)}
            title={nodeTitle}
            maxAttempts={nodeMaxAttempts}
            maxAttemptsLimit={NODE_MAX_ATTEMPTS_LIMIT}
            status={newNode ? '' : statusLabel(selectedNode.status, labels)}
            statusClassName={statusTextTone(selectedNode.status)}
            labels={labels}
            error={formError}
            onTitleChange={setNodeTitle}
            onMaxAttemptsChange={setNodeMaxAttempts}
            onSave={() => { void handleSaveNode(); }}
            onDelete={() => { void handleDeleteNode(); }}
            onClose={closeNodeEditor}
          >
            {selectedNodeKind === 'work' || selectedNodeKind === 'review' ? <TeamAssignmentEditor
              kind={selectedNodeKind}
              editable={canEdit}
              disabled={isSaving || mutationPending}
              labels={labels}
              roleId={canEdit ? roleId : selectedNode.roleId ?? ''}
              sessionRef={canEdit ? sessionRef : selectedNode.config?.sessionRef ?? ''}
              roles={roleBindings}
              prompt={canEdit ? prompt : readNodePrompt(selectedNode)}
              outputArtifactKind={canEdit ? outputArtifactKind : selectedNode.config?.outputArtifactKind ?? ''}
              onBindingChange={changeRoleBinding}
              onPromptChange={setPrompt}
              onOutputArtifactKindChange={setOutputArtifactKind}
            /> : null}
            {selectedNodeKind === 'start' ? <TeamStartEditor
              editable={canEdit}
              disabled={isSaving || mutationPending}
              labels={labels}
              triggerMode={canEdit ? startTriggerMode : readStartTrigger(selectedNode).mode}
              webhookPath={canEdit ? startWebhookPath : readStartTrigger(selectedNode).path}
              webhookPublicBaseUrl={startWebhookPublicBaseUrl}
              cronSchedule={canEdit ? startCronSchedule : readStartTrigger(selectedNode).cron}
              webhookAuth={webhookAuth}
              copiedWebhookPublicUrl={copiedWebhookPublicUrl}
              onTriggerModeChange={setStartTriggerMode}
              onWebhookPathChange={setStartWebhookPath}
              onWebhookPublicBaseUrlChange={setStartWebhookPublicBaseUrl}
              onCronScheduleChange={setStartCronSchedule}
              onCopyWebhookPublicUrl={() => { void copyTextToClipboard(webhookPublicUrl, setCopiedWebhookPublicUrl); }}
            /> : null}
            {selectedNodeKind === 'script_review' ? <TeamScriptReviewEditor
              editable={canEdit}
              disabled={isSaving || mutationPending}
              labels={labels}
              rule={canEdit ? scriptReviewRule : selectedNode.config?.rule ?? ''}
              onRuleChange={setScriptReviewRule}
            /> : null}
            {selectedNodeKind === 'human_decision' || selectedNodeKind === 'join' || selectedNodeKind === 'end' || selectedNodeKind === 'review' || selectedNodeKind === 'script_review' ? <TeamControlNodeDetails
              kind={selectedNodeKind}
              node={selectedNode}
              nodes={effectiveGraph.nodes}
              edges={effectiveGraph.edges}
              labels={labels}
            /> : null}
          </TeamNodeInspector>
        ) : configurationSheet?.kind === 'edge' && selectedEdge ? (
          <TeamEdgeInspector
            key={selectedEdge.edgeId}
            edge={selectedEdge}
            sourceNode={selectedEdgeSourceNode}
            targetNode={selectedEdgeTargetNode}
            editable={canEdit}
            pending={isSaving || mutationPending}
            isNew={Boolean(newEdge)}
            sourcePort={canEdit ? edgeSourcePort : selectedEdge.sourcePort ?? ''}
            targetPort={canEdit ? edgeTargetPort : selectedEdge.targetPort ?? ''}
            action={canEdit ? edgeAction : selectedEdge.action ?? ''}
            actions={canEdit ? edgeActions : edgeActionCandidates(selectedEdgeSourceNode, selectedEdge.sourcePort ?? '', selectedEdgeTargetNode)}
            includeUpstreamResult={canEdit ? edgeIncludeUpstreamResult : selectedEdge.payload?.includeUpstreamResult !== false}
            canSave={edgePortsValid && edgeActionValid}
            status={newEdge ? '' : statusLabel(selectedEdge.status, labels)}
            statusClassName={statusTextTone(selectedEdge.status)}
            labels={labels}
            error={formError}
            onSourcePortChange={(sourcePort) => {
              setEdgeSourcePort(sourcePort);
              const actions = edgeActionCandidates(selectedEdgeSourceNode, sourcePort, selectedEdgeTargetNode);
              if (actions.length === 1) setEdgeAction(actions[0]);
            }}
            onTargetPortChange={setEdgeTargetPort}
            onActionChange={setEdgeAction}
            onIncludeUpstreamResultChange={setEdgeIncludeUpstreamResult}
            onSave={() => { void handleSaveEdge(); }}
            onDelete={() => { void handleDeleteEdge(); }}
            onClose={closeEdgeEditor}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Bot, CheckCircle2, FileCode2, Flag, GitMerge, UserCheck, Zap, type LucideIcon } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type {
  TeamGraphEdgeAction,
  TeamGraphEdgeRecord,
  TeamGraphNodeRecord,
  TeamGraphSnapshotRecord,
  TeamRoleBindingRecord,
  TeamWebhookAuthProjection,
} from '@/services/openclaw/team-runtime-client';

type TeamGraphCanvasNodeKind = 'start' | 'work' | 'review' | 'human_decision' | 'script_review' | 'join' | 'end';

type TeamGraphStartTriggerMode = 'webhook' | 'cron';
type TeamGraphReviewExecutorKind = 'team-role' | 'human';
type TeamGraphScriptReviewRuleId = 'passThrough' | 'assertAllUpstreamCompleted' | 'assertNoBlockingGate' | 'assertArtifactExists';

const TEAM_GRAPH_EDGE_ACTIONS: TeamGraphEdgeAction[] = ['activate', 'rework', 'gate', 'finish'];

type TeamRunGraphCanvasLabels = {
  workflowCanvas: string;
  workflowEdges: string;
  nodePalette: string;
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
  edgeType: string;
  edgeAction: string;
  edgeActionOptions: Record<TeamGraphEdgeAction, string>;
  includeUpstreamResult: string;
  edgeLabel: string;
  edgeConnection: string;
  edgeTriggerCondition: string;
  edgeDataTransfer: string;
  edgeAdvancedFields: string;
  edgeJoinGateHint: string;
  edgeFallback: string;
  canvasMinimap: string;
  nodeTitle: string;
  roleId: string;
  executorJson: string;
  prompt: string;
  workPrompt: string;
  reviewPrompt: string;
  outputArtifactKind: string;
  reviewExecutorKind: string;
  reviewExecutorTeamRole: string;
  reviewExecutorHuman: string;
  humanDecisionReason: string;
  humanDecisionRequestedAction: string;
  humanDecisionRisk: string;
  scriptReviewRule: string;
  scriptReviewRules: Record<TeamGraphScriptReviewRuleId, string>;
  scriptReviewArtifactKind: string;
  joinConfigurationHint: string;
  endConfigurationHint: string;
  advancedJson: string;
  roleIdRequired: string;
  configJson: string;
  invalidJson: string;
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
  startCronExpression: string;
  startTriggerHint: string;
  nodePaletteDescriptions: Record<TeamGraphCanvasNodeKind, string>;
  defaultOutputPort: string;
  edges: string;
  noEdges: string;
};

type TeamRunGraphCanvasProps = {
  graph: TeamGraphSnapshotRecord | null | undefined;
  runStatus?: string;
  roles?: TeamRoleBindingRecord[];
  headerActions?: ReactNode;
  emptyLabel: string;
  titleLabel: string;
  executorLabel: string;
  webhookAuth?: TeamWebhookAuthProjection | null;
  labels: TeamRunGraphCanvasLabels;
  onSaveGraph?: (graph: TeamGraphSnapshotRecord) => Promise<void> | void;
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
const COLUMN_GAP = 280;
const ROW_GAP = 190;
const CANVAS_PADDING = 72;
const DRAG_THRESHOLD = 3;
const NODE_PALETTE: Array<{ kind: TeamGraphCanvasNodeKind; title: string; sourcePort: string }> = [
  { kind: 'start', title: 'Trigger', sourcePort: 'completed' },
  { kind: 'work', title: 'Role step', sourcePort: 'completed' },
  { kind: 'review', title: 'Review', sourcePort: 'passed' },
  { kind: 'human_decision', title: 'Decision', sourcePort: 'approved' },
  { kind: 'script_review', title: 'Script check', sourcePort: 'passed' },
  { kind: 'join', title: 'Join', sourcePort: 'joined' },
  { kind: 'end', title: 'Finish', sourcePort: 'completed' },
];

const SCRIPT_REVIEW_RULE_IDS: TeamGraphScriptReviewRuleId[] = [
  'passThrough',
  'assertAllUpstreamCompleted',
  'assertNoBlockingGate',
  'assertArtifactExists',
];

const EDGE_VISUALS: Record<string, TeamGraphEdgeVisual> = {
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
  return edge.sourcePort || edge.kind || edge.label || '';
}

function positionNodes(nodes: TeamGraphNodeRecord[], draftPositions: Record<string, { x: number; y: number }>): PositionedNode[] {
  return nodes.map((node, index) => {
    const position = draftPositions[node.nodeId] ?? readNodePosition(node) ?? {
      x: CANVAS_PADDING + (index % 4) * COLUMN_GAP,
      y: CANVAS_PADDING + Math.floor(index / 4) * ROW_GAP,
    };
    return { ...node, x: position.x, y: position.y };
  });
}

function createEdgePath(source: PositionedNode, target: PositionedNode, sourceWidth: number, sourceHeight: number, targetHeight: number): string {
  const startX = source.x + sourceWidth;
  const startY = source.y + sourceHeight / 2;
  const endX = target.x;
  const endY = target.y + targetHeight / 2;
  const controlOffset = Math.max(80, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;
}

function parseJsonObject(value: string, fieldLabel: string, invalidJsonLabel: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldLabel}: ${invalidJsonLabel}`);
  }
  return parsed as Record<string, unknown>;
}

function stringifyJsonObject(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function readNodePrompt(node: TeamGraphNodeRecord | null): string {
  const prompt = node?.config?.prompt;
  return typeof prompt === 'string' ? prompt : '';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNodeConfigString(node: TeamGraphNodeRecord | null, field: string): string {
  const value = node?.config?.[field];
  return typeof value === 'string' ? value : '';
}

function readNodeRoleId(node: TeamGraphNodeRecord | null): string {
  return readString(node?.executor?.roleId) ?? readString(node?.roleId) ?? '';
}

function readReviewExecutorKind(node: TeamGraphNodeRecord | null): TeamGraphReviewExecutorKind {
  return node?.executor?.kind === 'team-role' ? 'team-role' : 'human';
}

function readScriptReviewRuleId(node: TeamGraphNodeRecord | null): TeamGraphScriptReviewRuleId {
  const ruleId = readNodeConfigString(node, 'ruleId');
  if (ruleId === 'assertAllUpstreamCompleted' || ruleId === 'assertNoBlockingGate' || ruleId === 'assertArtifactExists') return ruleId;
  return 'passThrough';
}

function writeOptionalString(record: Record<string, unknown>, field: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) {
    record[field] = trimmed;
  } else {
    delete record[field];
  }
}

function createProjectionEdgeId(sourceNodeId: string, targetNodeId: string, sourcePort: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  const rawId = cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `projection-edge:${sourceNodeId}:${sourcePort || 'out'}:${targetNodeId}:${rawId}`;
}

function createProjectionNodeId(kind: TeamGraphCanvasNodeKind): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  const rawId = cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `canvas-node:${kind}:${rawId}`;
}

function hasRecordEntries(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

const EMPTY_TEAM_GRAPH: TeamGraphSnapshotRecord = {
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

function readNodePosition(node: TeamGraphNodeRecord): { x: number; y: number } | null {
  const position = node.metadata?.position;
  if (!position || typeof position !== 'object' || Array.isArray(position)) return null;
  const x = (position as Record<string, unknown>).x;
  const y = (position as Record<string, unknown>).y;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}

function writeNodePosition(node: TeamGraphNodeRecord, x: number, y: number): TeamGraphNodeRecord {
  return {
    ...node,
    metadata: {
      ...(node.metadata ?? {}),
      position: { x, y },
    },
  };
}

function defaultConfigForNode(kind: TeamGraphCanvasNodeKind, title: string): Record<string, unknown> | undefined {
  if (kind === 'work') return { prompt: title };
  if (kind === 'script_review') return { runtime: 'python', timeoutMs: 60_000, outputLimitBytes: 32_768 };
  if (kind === 'start') return { trigger: defaultStartTrigger('webhook') };
  return undefined;
}

function defaultStartTrigger(mode: TeamGraphStartTriggerMode): Record<string, unknown> {
  if (mode === 'cron') return { mode: 'cron', cron: '0 9 * * *' };
  return { mode: 'webhook', path: '' };
}

function normalizeWebhookPathInput(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeWebhookPublicBaseUrlInput(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildWebhookRoutePreview(path: string): string {
  const normalizedPath = normalizeWebhookPathInput(path);
  return normalizedPath ? `/api/team-runtime/webhooks/${normalizedPath}` : '/api/team-runtime/webhooks/{path}';
}

function buildWebhookPublicUrl(publicBaseUrl: string, path: string): string {
  const normalizedBaseUrl = normalizeWebhookPublicBaseUrlInput(publicBaseUrl);
  if (!normalizedBaseUrl) return '';
  return `${normalizedBaseUrl}${buildWebhookRoutePreview(path)}`;
}

function isValidWebhookPublicBaseUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function readStartTrigger(node: TeamGraphNodeRecord | null): { mode: TeamGraphStartTriggerMode; cron: string; path: string; publicBaseUrl: string } {
  const trigger = node?.config?.trigger;
  const record = trigger && typeof trigger === 'object' && !Array.isArray(trigger) ? (trigger as Record<string, unknown>) : {};
  const mode: TeamGraphStartTriggerMode = record.mode === 'cron' ? 'cron' : 'webhook';
  return {
    mode,
    cron: typeof record.cron === 'string' ? record.cron : '',
    path: typeof record.path === 'string' ? record.path : '',
    publicBaseUrl: typeof record.publicBaseUrl === 'string' ? record.publicBaseUrl : '',
  };
}

function defaultExecutorForNode(kind: TeamGraphCanvasNodeKind): Record<string, unknown> | undefined {
  if (kind === 'work') return { kind: 'team-role', roleId: 'leader' };
  if (kind === 'review') return { kind: 'team-role', roleId: 'leader' };
  if (kind === 'human_decision') return { kind: 'human' };
  if (kind === 'script_review') return { kind: 'script', runtime: 'python' };
  return undefined;
}

function defaultSourcePortForNode(node: TeamGraphNodeRecord): string {
  switch (node.kind) {
    case 'review':
    case 'script_review':
      return 'passed';
    case 'human_decision':
      return 'approved';
    case 'join':
      return 'joined';
    default:
      return 'completed';
  }
}

function defaultTargetPortForNode(): string {
  return 'input';
}

function defaultEdgeTypeForSourcePort(sourcePort: string): string {
  if (sourcePort === 'completed') return 'completed_success';
  if (sourcePort === 'failed' || sourcePort === 'rejected') return 'rework';
  if (sourcePort === 'approved') return 'approval';
  return sourcePort || 'control';
}

function sourcePortOptionsForNode(node: TeamGraphNodeRecord | null): string[] {
  switch (node?.kind) {
    case 'start':
      return ['completed'];
    case 'review':
    case 'script_review':
      return ['passed', 'failed'];
    case 'human_decision':
      return ['approved', 'rejected', 'aborted'];
    case 'join':
      return ['joined'];
    default:
      return ['completed', 'failed'];
  }
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

type NodeBasicsEditorProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
};

function NodeBasicsEditor({ label, value, onChange }: NodeBasicsEditorProps) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

type RoleIdEditorProps = {
  readonly label: string;
  readonly value: string;
  readonly roles: readonly TeamRoleBindingRecord[];
  readonly onChange: (value: string) => void;
};

function RoleIdEditor({ label, value, roles, onChange }: RoleIdEditorProps) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      {roles.length > 0 ? (
        <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">-</option>
          {roles.map((role) => <option key={role.roleId} value={role.roleId}>{role.roleId}</option>)}
        </select>
      ) : (
        <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
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
  onSaveGraph,
}: TeamRunGraphCanvasProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [configurationSheet, setConfigurationSheet] = useState<ConfigurationSheet>(null);
  const [nodeTitle, setNodeTitle] = useState('');
  const [roleId, setRoleId] = useState('');
  const [executorJson, setExecutorJson] = useState('{}');
  const [prompt, setPrompt] = useState('');
  const [outputArtifactKind, setOutputArtifactKind] = useState('');
  const [reviewExecutorKind, setReviewExecutorKind] = useState<TeamGraphReviewExecutorKind>('team-role');
  const [humanDecisionReason, setHumanDecisionReason] = useState('');
  const [humanDecisionRequestedAction, setHumanDecisionRequestedAction] = useState('');
  const [humanDecisionRisk, setHumanDecisionRisk] = useState('');
  const [scriptReviewRule, setScriptReviewRule] = useState<TeamGraphScriptReviewRuleId>('passThrough');
  const [scriptReviewArtifactKind, setScriptReviewArtifactKind] = useState('');
  const [configJson, setConfigJson] = useState('{}');
  const [startTriggerMode, setStartTriggerMode] = useState<TeamGraphStartTriggerMode>('webhook');
  const [startWebhookPath, setStartWebhookPath] = useState('');
  const [startWebhookPublicBaseUrl, setStartWebhookPublicBaseUrl] = useState('');
  const [startCronExpression, setStartCronExpression] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [edgeSourcePort, setEdgeSourcePort] = useState('completed');
  const [edgeTargetPort, setEdgeTargetPort] = useState('input');
  const [edgeType, setEdgeType] = useState('completed_success');
  const [edgeLabel, setEdgeLabel] = useState('');
  const [edgeAction, setEdgeAction] = useState<'activate' | 'rework' | 'gate' | 'finish'>('activate');
  const [edgeIncludeUpstreamResult, setEdgeIncludeUpstreamResult] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [copiedWebhookPublicUrl, setCopiedWebhookPublicUrl] = useState(false);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [draftPositions, setDraftPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [nodeSizes, setNodeSizes] = useState<Record<string, NodeSize>>({});
  const canvasScrollerRef = useRef<HTMLDivElement | null>(null);
  const nodeElementsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const suppressClickNodeIdRef = useRef<string | null>(null);

  const effectiveGraph = useMemo<TeamGraphSnapshotRecord>(() => graph ?? EMPTY_TEAM_GRAPH, [graph]);
  const positionedNodes = useMemo(() => positionNodes(effectiveGraph.nodes, draftPositions), [effectiveGraph.nodes, draftPositions]);
  const nodeById = useMemo(
    () => new Map(positionedNodes.map((node) => [node.nodeId, node])),
    [positionedNodes],
  );
  const selectedNode = useMemo(() => (
    effectiveGraph.nodes.find((node) => node.nodeId === selectedNodeId) ?? null
  ), [effectiveGraph.nodes, selectedNodeId]);
  const selectedNodeKind = selectedNode ? visualKindForNodeKind(selectedNode.kind) : null;
  const selectedEdge = useMemo(() => (
    effectiveGraph.edges.find((edge) => edge.edgeId === selectedEdgeId) ?? null
  ), [effectiveGraph.edges, selectedEdgeId]);
  const selectedEdgeSourceNode = useMemo(() => (
    selectedEdge ? effectiveGraph.nodes.find((node) => node.nodeId === selectedEdge.sourceNodeId) ?? null : null
  ), [effectiveGraph.nodes, selectedEdge]);
  const selectedEdgeTargetNode = useMemo(() => (
    selectedEdge ? effectiveGraph.nodes.find((node) => node.nodeId === selectedEdge.targetNodeId) ?? null : null
  ), [effectiveGraph.nodes, selectedEdge]);
  const selectedEdgeTargetHasMultipleInboundEdges = useMemo(() => (
    selectedEdge ? effectiveGraph.edges.filter((edge) => edge.targetNodeId === selectedEdge.targetNodeId).length > 1 : false
  ), [effectiveGraph.edges, selectedEdge]);
  const canvasWidth = Math.max(820, ...positionedNodes.map((node) => node.x + (nodeSizes[node.nodeId]?.width ?? NODE_WIDTH) + CANVAS_PADDING));
  const canvasHeight = Math.max(440, ...positionedNodes.map((node) => node.y + (nodeSizes[node.nodeId]?.height ?? NODE_HEIGHT) + CANVAS_PADDING));
  const webhookPublicUrl = buildWebhookPublicUrl(startWebhookPublicBaseUrl, startWebhookPath);

  useEffect(() => {
    setDraftPositions({});
  }, [graph]);

  useEffect(() => {
    const activeNodeIds = new Set(positionedNodes.map((node) => node.nodeId));
    for (const nodeId of Object.keys(nodeElementsRef.current)) {
      if (!activeNodeIds.has(nodeId)) delete nodeElementsRef.current[nodeId];
    }
  }, [positionedNodes]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      setNodeSizes((current) => {
        let changed = false;
        const next = { ...current };
        for (const [nodeId, element] of Object.entries(nodeElementsRef.current)) {
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          const size = { width: Math.ceil(rect.width || NODE_WIDTH), height: Math.ceil(rect.height || NODE_HEIGHT) };
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
          const size = { width: Math.ceil(entry.contentRect.width || NODE_WIDTH), height: Math.ceil(entry.contentRect.height || NODE_HEIGHT) };
          if (next[nodeId]?.width !== size.width || next[nodeId]?.height !== size.height) {
            next[nodeId] = size;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
    for (const element of Object.values(nodeElementsRef.current)) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [positionedNodes]);

  useEffect(() => {
    setCopiedWebhookPublicUrl(false);
  }, [startWebhookPath, startWebhookPublicBaseUrl]);

  useEffect(() => {
    if (!selectedNode) {
      setNodeTitle('');
      setRoleId('');
      setExecutorJson('{}');
      setPrompt('');
      setOutputArtifactKind('');
      setReviewExecutorKind('team-role');
      setHumanDecisionReason('');
      setHumanDecisionRequestedAction('');
      setHumanDecisionRisk('');
      setScriptReviewRule('passThrough');
      setScriptReviewArtifactKind('');
      setConfigJson('{}');
      return;
    }
    setNodeTitle(selectedNode.title ?? '');
    setRoleId(readNodeRoleId(selectedNode));
    setExecutorJson(stringifyJsonObject(selectedNode.executor));
    setPrompt(readNodePrompt(selectedNode));
    setOutputArtifactKind(readNodeConfigString(selectedNode, 'outputArtifactKind'));
    setReviewExecutorKind(readReviewExecutorKind(selectedNode));
    setHumanDecisionReason(readNodeConfigString(selectedNode, 'reason'));
    setHumanDecisionRequestedAction(readNodeConfigString(selectedNode, 'requestedAction'));
    setHumanDecisionRisk(readNodeConfigString(selectedNode, 'risk'));
    setScriptReviewRule(readScriptReviewRuleId(selectedNode));
    setScriptReviewArtifactKind(readNodeConfigString(selectedNode, 'artifactKind'));
    setConfigJson(stringifyJsonObject(selectedNode.config));
    const trigger = readStartTrigger(selectedNode);
    setStartTriggerMode(trigger.mode);
    setStartWebhookPath(trigger.path);
    setStartWebhookPublicBaseUrl(trigger.publicBaseUrl);
    setStartCronExpression(trigger.cron);
    setFormError(null);
  }, [selectedNode]);

  useEffect(() => {
    if (!selectedEdge) {
      setEdgeSourcePort('completed');
      setEdgeTargetPort('input');
      setEdgeType('completed_success');
      setEdgeLabel('');
      setEdgeAction('activate');
      setEdgeIncludeUpstreamResult(true);
      return;
    }
    const nextSourcePort = selectedEdge.sourcePort ?? defaultSourcePortForNode(selectedEdgeSourceNode ?? { nodeId: selectedEdge.sourceNodeId, kind: 'work' });
    setEdgeSourcePort(nextSourcePort);
    setEdgeTargetPort(selectedEdge.targetPort ?? defaultTargetPortForNode());
    setEdgeType(selectedEdge.edgeType ?? selectedEdge.kind ?? defaultEdgeTypeForSourcePort(nextSourcePort));
    setEdgeLabel(selectedEdge.label ?? '');
    setEdgeAction(selectedEdge.action ?? 'activate');
    setEdgeIncludeUpstreamResult(selectedEdge.payload?.includeUpstreamResult !== false);
    setFormError(null);
  }, [selectedEdge, selectedEdgeSourceNode]);

  const saveGraphProjection = async (nextGraph: TeamGraphSnapshotRecord): Promise<void> => {
    if (!onSaveGraph) {
      setFormError(labels.saveGraphUnavailable);
      return;
    }
    setIsSaving(true);
    setFormError(null);
    try {
      await onSaveGraph(nextGraph);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const appendEdge = async (input: { sourceNodeId: string; targetNodeId: string; sourcePort: string; label?: string }): Promise<void> => {
    if (!input.sourceNodeId || !input.targetNodeId || input.sourceNodeId === input.targetNodeId) {
      setFormError(`${labels.sourceNode} / ${labels.targetNode}`);
      return;
    }
    const nextEdge: TeamGraphEdgeRecord = {
      edgeId: createProjectionEdgeId(input.sourceNodeId, input.targetNodeId, input.sourcePort),
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      sourcePort: input.sourcePort,
      targetPort: defaultTargetPortForNode(),
      edgeType: defaultEdgeTypeForSourcePort(input.sourcePort),
      ...(input.label ? { label: input.label } : {}),
      action: 'activate',
      payload: { includeUpstreamResult: true },
      kind: 'projection',
    };
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      edges: [...effectiveGraph.edges, nextEdge],
    });
    setSelectedEdgeId(nextEdge.edgeId);
    setConfigurationSheet({ kind: 'edge', edgeId: nextEdge.edgeId });
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

  const handleSaveStartNode = async (): Promise<void> => {
    if (!selectedNode) return;
    const normalizedWebhookPath = normalizeWebhookPathInput(startWebhookPath);
    if (startTriggerMode === 'webhook' && !normalizedWebhookPath) {
      setFormError(labels.startWebhookPathRequired);
      return;
    }
    if (startTriggerMode === 'webhook' && normalizedWebhookPath.includes('..')) {
      setFormError(labels.startWebhookPathInvalid);
      return;
    }
    const normalizedPublicBaseUrl = normalizeWebhookPublicBaseUrlInput(startWebhookPublicBaseUrl);
    if (startTriggerMode === 'webhook' && !isValidWebhookPublicBaseUrl(normalizedPublicBaseUrl)) {
      setFormError(labels.startWebhookPublicBaseUrlInvalid);
      return;
    }
    const trigger: Record<string, unknown> = startTriggerMode === 'cron'
      ? { mode: 'cron', cron: startCronExpression.trim() }
      : {
        mode: 'webhook',
        path: normalizedWebhookPath,
        ...(normalizedPublicBaseUrl ? { publicBaseUrl: normalizedPublicBaseUrl } : {}),
      };
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      nodes: effectiveGraph.nodes.map((node) => node.nodeId === selectedNode.nodeId
        ? {
          ...node,
          title: nodeTitle.trim() || undefined,
          config: { ...(node.config ?? {}), trigger },
        }
        : node),
    });
    setConfigurationSheet(null);
  };

  const handleSaveNode = async (): Promise<void> => {
    if (!selectedNode) return;

    let nextExecutor: Record<string, unknown>;
    let nextConfig: Record<string, unknown>;
    try {
      nextExecutor = parseJsonObject(executorJson, labels.executorJson, labels.invalidJson);
      nextConfig = parseJsonObject(configJson, labels.configJson, labels.invalidJson);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return;
    }

    let nextRoleId: string | undefined;
    switch (selectedNode.kind) {
      case 'review': {
        if (reviewExecutorKind === 'team-role') {
          const role = roleId.trim();
          if (!role) {
            setFormError(labels.roleIdRequired);
            return;
          }
          nextRoleId = role;
          nextExecutor = { ...nextExecutor, kind: 'team-role', roleId: role };
          writeOptionalString(nextConfig, 'prompt', prompt);
        } else {
          nextExecutor = { ...nextExecutor, kind: 'human' };
          delete nextExecutor.roleId;
          delete nextConfig.prompt;
        }
        break;
      }
      case 'human_decision':
        nextExecutor = { ...nextExecutor, kind: 'human' };
        delete nextExecutor.roleId;
        delete nextConfig.prompt;
        writeOptionalString(nextConfig, 'reason', humanDecisionReason);
        writeOptionalString(nextConfig, 'requestedAction', humanDecisionRequestedAction);
        writeOptionalString(nextConfig, 'risk', humanDecisionRisk);
        break;
      case 'script_review':
        nextExecutor = { ...nextExecutor, kind: 'script', runtime: readString(nextExecutor.runtime) ?? 'python' };
        delete nextExecutor.roleId;
        delete nextConfig.prompt;
        nextConfig.ruleId = scriptReviewRule;
        writeOptionalString(nextConfig, 'artifactKind', scriptReviewArtifactKind);
        break;
      case 'join':
      case 'end':
        nextExecutor = {};
        delete nextConfig.prompt;
        break;
      case 'work':
      default: {
        const role = roleId.trim();
        if (!role) {
          setFormError(labels.roleIdRequired);
          return;
        }
        nextRoleId = role;
        nextExecutor = { ...nextExecutor, kind: 'team-role', roleId: role };
        writeOptionalString(nextConfig, 'prompt', prompt);
        writeOptionalString(nextConfig, 'outputArtifactKind', outputArtifactKind);
        break;
      }
    }

    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      nodes: effectiveGraph.nodes.map((node) => node.nodeId === selectedNode.nodeId
        ? {
          ...node,
          title: nodeTitle.trim() || undefined,
          roleId: nextRoleId,
          executor: hasRecordEntries(nextExecutor) ? nextExecutor : undefined,
          config: hasRecordEntries(nextConfig) ? nextConfig : undefined,
        }
        : node),
    });
    setConfigurationSheet(null);
  };

  const handleSaveEdge = async (): Promise<void> => {
    if (!selectedEdge) return;
    const nextSourcePort = edgeSourcePort.trim() || defaultSourcePortForNode(selectedEdgeSourceNode ?? { nodeId: selectedEdge.sourceNodeId, kind: 'work' });
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      edges: effectiveGraph.edges.map((edge) => edge.edgeId === selectedEdge.edgeId
        ? {
          ...edge,
          sourcePort: nextSourcePort,
          targetPort: edgeTargetPort.trim() || defaultTargetPortForNode(),
          edgeType: edgeType.trim() || defaultEdgeTypeForSourcePort(nextSourcePort),
          kind: edge.kind ?? 'projection',
          label: edgeLabel.trim() || undefined,
          action: edgeAction,
          payload: { includeUpstreamResult: edgeIncludeUpstreamResult },
        }
        : edge),
    });
    setConfigurationSheet(null);
  };

  const handleDeleteNode = async (): Promise<void> => {
    if (!selectedNode) return;
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      nodes: effectiveGraph.nodes.filter((node) => node.nodeId !== selectedNode.nodeId),
      edges: effectiveGraph.edges.filter((edge) => edge.sourceNodeId !== selectedNode.nodeId && edge.targetNodeId !== selectedNode.nodeId),
    });
    setSelectedNodeId(null);
    setConfigurationSheet(null);
  };

  const handleDeleteEdge = async (): Promise<void> => {
    if (!selectedEdge) return;
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      edges: effectiveGraph.edges.filter((edge) => edge.edgeId !== selectedEdge.edgeId),
    });
    setSelectedEdgeId(null);
    setConfigurationSheet(null);
  };

  const handleAddNode = async (kind: TeamGraphCanvasNodeKind): Promise<void> => {
    const paletteItem = NODE_PALETTE.find((item) => item.kind === kind)!;
    const nodeId = createProjectionNodeId(kind);
    const position = nextNodePosition(positionedNodes, nodeSizes, readCanvasViewport(canvasScrollerRef.current));
    const node: TeamGraphNodeRecord = {
      nodeId,
      kind,
      title: paletteItem.title,
      status: 'pending',
      ...(kind === 'work' || kind === 'review' ? { roleId: 'leader' } : {}),
      ...(kind === 'work' ? { taskId: nodeId } : {}),
      executor: defaultExecutorForNode(kind),
      config: defaultConfigForNode(kind, paletteItem.title),
      metadata: { position },
    };
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      nodes: [...effectiveGraph.nodes, node],
    });
    setSelectedNodeId(nodeId);
  };

  const persistNodePosition = async (nodeId: string, x: number, y: number): Promise<void> => {
    await saveGraphProjection({
      ...effectiveGraph,
      updatedAt: Date.now(),
      nodes: effectiveGraph.nodes.map((node) => node.nodeId === nodeId ? writeNodePosition(node, x, y) : node),
    });
  };

  const handleNodePointerDown = (event: PointerEvent<HTMLDivElement>, node: PositionedNode): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragState({
      nodeId: node.nodeId,
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      pointerStartY: event.clientY,
      nodeStartX: node.x,
      nodeStartY: node.y,
      currentX: node.x,
      currentY: node.y,
      moved: false,
    });
  };

  const handleNodePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragState.pointerStartX;
    const dy = event.clientY - dragState.pointerStartY;
    const nextX = Math.max(CANVAS_PADDING / 2, dragState.nodeStartX + dx);
    const nextY = Math.max(CANVAS_PADDING / 2, dragState.nodeStartY + dy);
    const moved = dragState.moved || Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
    setDraftPositions((current) => ({ ...current, [dragState.nodeId]: { x: nextX, y: nextY } }));
    setDragState({ ...dragState, currentX: nextX, currentY: nextY, moved });
  };

  const handleNodePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const finishedDrag = dragState;
    setDragState(null);
    if (finishedDrag.moved) {
      suppressClickNodeIdRef.current = finishedDrag.nodeId;
      window.setTimeout(() => { suppressClickNodeIdRef.current = null; }, 0);
      void persistNodePosition(finishedDrag.nodeId, finishedDrag.currentX, finishedDrag.currentY);
    }
  };

  const handleStartConnection = (event: MouseEvent<HTMLButtonElement>, node: TeamGraphNodeRecord): void => {
    event.stopPropagation();
    const nextPort = defaultSourcePortForNode(node);
    setConnectionDraft({ sourceNodeId: node.nodeId, sourcePort: nextPort });
  };

  const handleFinishConnection = (event: MouseEvent<HTMLButtonElement>, target: TeamGraphNodeRecord): void => {
    event.stopPropagation();
    if (!connectionDraft) return;
    void appendEdge({
      sourceNodeId: connectionDraft.sourceNodeId,
      targetNodeId: target.nodeId,
      sourcePort: connectionDraft.sourcePort,
      label: connectionDraft.sourcePort,
    });
    setConnectionDraft(null);
  };

  return (
    <div className="space-y-3">
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
                <div key={role.roleId} title={`${role.roleId} · ${role.agentId}`} className="grid h-8 w-8 place-items-center rounded-full border-2 border-background bg-primary/15 text-[10px] font-semibold text-primary">
                  {role.roleId.slice(0, 2).toUpperCase()}
                </div>
              ))}
              {roles.length > 4 ? <div className="grid h-8 min-w-8 place-items-center rounded-full border-2 border-background bg-muted px-2 text-[10px] font-semibold text-muted-foreground">+{roles.length - 4}</div> : null}
            </div>
          ) : null}
          {headerActions}
          {connectionDraft ? <div className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-xs text-primary">{labels.connectionDraft}: {connectionDraft.sourcePort}</div> : null}
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

      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1.7fr)_24rem]">
        <div ref={canvasScrollerRef} className="relative min-h-[520px] overflow-auto rounded-2xl border border-border bg-muted/25 p-4 text-foreground shadow-inner">
          <div
            aria-label={labels.workflowCanvas}
            className="relative rounded-xl"
            onClick={() => {
              setSelectedEdgeId(null);
              setHoveredEdgeId(null);
              if (configurationSheet?.kind === 'edge') setConfigurationSheet(null);
            }}
            style={{
              width: canvasWidth,
              height: canvasHeight,
              backgroundImage: 'radial-gradient(circle at 1px 1px, hsl(var(--border)) 1px, transparent 0)',
              backgroundSize: '22px 22px',
            }}
          >
            <svg className="absolute inset-0" width={canvasWidth} height={canvasHeight} role="img" aria-label={labels.workflowEdges}>
              <defs>
                {[...Object.values(EDGE_VISUALS), FALLBACK_EDGE_VISUAL].map((visual) => (
                  <marker key={visual.markerId} id={visual.markerId} markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
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
                const sourceSize = nodeSizes[source.nodeId] ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
                const targetSize = nodeSizes[target.nodeId] ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
                const startX = source.x + sourceSize.width;
                const startY = source.y + sourceSize.height / 2;
                const endX = target.x;
                const endY = target.y + targetSize.height / 2;
                const labelX = (startX + endX) / 2;
                const labelY = (startY + endY) / 2 - 12;
                const edgeVisual = edgeVisualForEdge(edge);
                const edgeLabel = edgeDisplayLabel(edge);
                const isSelectedEdge = selectedEdgeId === edge.edgeId;
                const isHoveredEdge = hoveredEdgeId === edge.edgeId;
                const shouldShowEdgeLabel = Boolean(edgeLabel && (isSelectedEdge || isHoveredEdge));
                return (
                  <g key={edge.edgeId} onMouseEnter={() => setHoveredEdgeId(edge.edgeId)} onMouseLeave={() => setHoveredEdgeId((current) => current === edge.edgeId ? null : current)}>
                    <path
                      d={createEdgePath(source, target, sourceSize.width, sourceSize.height, targetSize.height)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="14"
                      strokeLinecap="round"
                      className="cursor-pointer"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedEdgeId(edge.edgeId);
                        setConfigurationSheet({ kind: 'edge', edgeId: edge.edgeId });
                      }}
                    />
                    <path
                      d={createEdgePath(source, target, sourceSize.width, sourceSize.height, targetSize.height)}
                      fill="none"
                      stroke={edgeVisual.stroke}
                      strokeWidth={isSelectedEdge ? '3.5' : '2.5'}
                      strokeLinecap="round"
                      strokeDasharray={edgeVisual.dashArray}
                      markerEnd={`url(#${edgeVisual.markerId})`}
                      className="pointer-events-none transition-all"
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
                      event.stopPropagation();
                      setSelectedNodeId(node.nodeId);
                      setConfigurationSheet({ kind: 'node', nodeId: node.nodeId });
                    }
                  }}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={handleNodePointerUp}
                  className={`absolute cursor-grab overflow-hidden rounded-[18px] border p-0 text-left shadow-md shadow-slate-900/10 transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-slate-900/15 active:cursor-grabbing ${visual.canvasClassName} ${isSelected ? 'ring-2 ring-primary/35 ring-offset-2 ring-offset-background' : ''}`}
                  style={{ left: node.x, top: node.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
                >
                  <div className={`h-1 w-full ${visual.accentClassName}`} />
                  <button
                    type="button"
                    aria-label={formatTemplate(labels.connectToNode, { title: node.title ?? node.nodeId })}
                    className="group absolute -left-5 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => handleFinishConnection(event, node)}
                  >
                    <span className={`h-4 w-4 rounded-full border shadow-sm transition group-hover:ring-4 group-hover:ring-primary/10 group-focus-visible:ring-4 group-focus-visible:ring-primary/10 ${connectionDraft ? visual.handleClassName : 'border-border bg-background'}`} />
                  </button>
                  <button
                    type="button"
                    aria-label={formatTemplate(labels.connectFromNode, { title: node.title ?? node.nodeId })}
                    className="group absolute -right-5 top-1/2 z-20 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => handleStartConnection(event, node)}
                  >
                    <span className={`h-4 w-4 rounded-full border shadow-sm transition group-hover:ring-4 group-hover:ring-primary/10 group-focus-visible:ring-4 group-focus-visible:ring-primary/10 ${connectionDraft?.sourceNodeId === node.nodeId ? visual.handleClassName : 'border-border bg-background'}`} />
                  </button>
                  <div className="space-y-3 p-3">
                    <div className="flex items-start gap-3">
                      <div className={`grid h-10 w-10 shrink-0 place-items-center border border-border/90 ${visual.iconClassName} ${visual.iconShape}`}>
                        <NodeIcon className={`h-4 w-4 ${visualKindForNodeKind(node.kind) === 'join' ? '-rotate-45' : ''}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold tracking-tight text-foreground">{node.title ?? node.nodeId}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide opacity-80">
                          <span className="rounded-full border border-border/80 bg-muted/70 px-1.5 py-0.5 text-muted-foreground">{node.kind ?? 'node'}</span>
                          <span className="rounded-full border border-border/80 bg-muted/70 px-1.5 py-0.5 text-muted-foreground">{node.status ?? 'pending'}</span>
                        </div>
                      </div>
                    </div>
                    {node.roleId ? (
                      <div className="flex items-center justify-between rounded-xl border border-border/80 bg-muted/50 px-2 py-1.5 text-[11px]">
                        <span className="truncate text-muted-foreground">{executorLabel}</span>
                        <span className="ml-2 truncate font-medium text-foreground">{node.roleId}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-border/80 bg-card p-3 shadow-sm">
            <div className="text-sm font-medium">{labels.nodePalette}</div>
            <div className="mt-3 max-h-[17rem] space-y-2 overflow-y-auto pr-1 text-xs">
              {NODE_PALETTE.map((item) => {
                const visual = NODE_VISUALS[item.kind];
                const PaletteIcon = visual.Icon;
                return (
                  <button
                    key={item.kind}
                    type="button"
                    className={`group relative flex w-full items-center gap-3 overflow-hidden rounded-[18px] border p-3 text-left text-foreground shadow-sm shadow-slate-900/10 transition hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-900/15 disabled:cursor-not-allowed disabled:opacity-60 ${visual.paletteClassName}`}
                    onClick={() => void handleAddNode(item.kind)}
                    disabled={isSaving}
                  >
                    <span className={`absolute inset-y-0 left-0 w-1 ${visual.accentClassName}`} />
                    <span className={`grid h-11 w-11 shrink-0 place-items-center border border-border/90 ${visual.iconClassName} ${visual.iconShape} transition group-hover:scale-105`}>
                      <PaletteIcon className={`h-4 w-4 ${item.kind === 'join' ? '-rotate-45' : ''}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold tracking-tight">{item.title}</span>
                        <span className="rounded-full border border-border/80 bg-muted/70 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{item.kind}</span>
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">{labels.nodePaletteDescriptions[item.kind]}</span>
                    </span>
                    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm">
                      {labels.defaultOutputPort}: {item.sourcePort}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>


          {formError ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{formError}</div> : null}
        </aside>
      </div>

      <Sheet open={configurationSheet !== null} onOpenChange={(open) => { if (!open) setConfigurationSheet(null); }}>
        <SheetContent side="right" className="w-[28rem] overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{configurationSheet?.kind === 'edge' ? labels.edgeConfiguration : labels.nodeConfiguration}</SheetTitle>
            <SheetDescription>{configurationSheet?.kind === 'edge' ? labels.edgeConfigurationDescription : labels.nodeConfigurationDescription}</SheetDescription>
          </SheetHeader>

          {configurationSheet?.kind === 'node' && selectedNode && selectedNodeKind === 'start' ? (
            <div className="mt-4 space-y-3 text-sm">
              <label className="grid gap-1 text-xs text-muted-foreground">
                {labels.nodeTitle}
                <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={nodeTitle} onChange={(event) => setNodeTitle(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                {labels.startTriggerMode}
                <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={startTriggerMode} onChange={(event) => setStartTriggerMode(event.target.value === 'cron' ? 'cron' : 'webhook')}>
                  <option value="webhook">{labels.startTriggerWebhook}</option>
                  <option value="cron">{labels.startTriggerCron}</option>
                </select>
              </label>
              {startTriggerMode === 'webhook' ? (
                <div className="space-y-3">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.startWebhookPath}
                    <input className="rounded border bg-background px-2 py-1 font-mono text-xs text-foreground" value={startWebhookPath} onChange={(event) => setStartWebhookPath(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.startWebhookPublicBaseUrl}
                    <input className="rounded border bg-background px-2 py-1 font-mono text-xs text-foreground" value={startWebhookPublicBaseUrl} onChange={(event) => setStartWebhookPublicBaseUrl(event.target.value)} placeholder="https://example.ngrok.app" />
                  </label>
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">{labels.startWebhookPublicBaseUrlHint}</div>
                </div>
              ) : (
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {labels.startCronExpression}
                  <input className="rounded border bg-background px-2 py-1 font-mono text-xs text-foreground" value={startCronExpression} onChange={(event) => setStartCronExpression(event.target.value)} />
                </label>
              )}
              {startTriggerMode === 'webhook' ? (
                <div className="rounded border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
                  <div>{labels.startWebhookPathPreview}: <span className="break-all font-mono text-foreground">{buildWebhookRoutePreview(startWebhookPath)}</span></div>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0">{labels.startWebhookToken}:</span>
                    <span className="min-w-0 flex-1 break-all font-mono text-foreground">{webhookAuth?.maskedToken || labels.startWebhookTokenUnavailable}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      disabled
                    >
                      {labels.copyWebhookToken}
                    </button>
                  </div>
                  <div className="mt-2 flex items-start gap-2">
                    <span className="shrink-0">{labels.startWebhookPublicUrl}:</span>
                    <span className="min-w-0 flex-1 break-all font-mono text-foreground">{webhookPublicUrl || labels.startWebhookPublicUrlUnavailable}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void copyTextToClipboard(webhookPublicUrl, setCopiedWebhookPublicUrl)}
                      disabled={!webhookPublicUrl}
                    >
                      {copiedWebhookPublicUrl ? labels.copiedWebhookPublicUrl : labels.copyWebhookPublicUrl}
                    </button>
                  </div>
                  <div>{labels.startWebhookPathPreviewHint}</div>
                </div>
              ) : null}
              <div className="rounded border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">{labels.startTriggerHint}</div>
              <div className="flex gap-2">
                <button type="button" className="rounded border px-3 py-1.5 text-xs font-medium" onClick={() => void handleSaveStartNode()} disabled={isSaving}>
                  {labels.saveNode}
                </button>
                <button type="button" className="rounded border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive" onClick={() => void handleDeleteNode()} disabled={isSaving}>
                  {labels.deleteNode}
                </button>
              </div>
            </div>
          ) : null}

          {configurationSheet?.kind === 'node' && selectedNode && selectedNodeKind && selectedNodeKind !== 'start' ? (
            <div className="mt-4 space-y-3 text-sm">
              <NodeBasicsEditor label={labels.nodeTitle} value={nodeTitle} onChange={setNodeTitle} />

              {selectedNodeKind === 'work' ? (
                <>
                  <RoleIdEditor label={labels.roleId} value={roleId} roles={roles} onChange={setRoleId} />
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.workPrompt}
                    <textarea className="min-h-24 rounded border bg-background px-2 py-1 text-sm text-foreground" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.outputArtifactKind}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={outputArtifactKind} onChange={(event) => setOutputArtifactKind(event.target.value)} />
                  </label>
                </>
              ) : null}

              {selectedNodeKind === 'review' ? (
                <>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.reviewExecutorKind}
                    <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={reviewExecutorKind} onChange={(event) => setReviewExecutorKind(event.target.value === 'team-role' ? 'team-role' : 'human')}>
                      <option value="team-role">{labels.reviewExecutorTeamRole}</option>
                      <option value="human">{labels.reviewExecutorHuman}</option>
                    </select>
                  </label>
                  {reviewExecutorKind === 'team-role' ? (
                    <>
                      <RoleIdEditor label={labels.roleId} value={roleId} roles={roles} onChange={setRoleId} />
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        {labels.reviewPrompt}
                        <textarea className="min-h-24 rounded border bg-background px-2 py-1 text-sm text-foreground" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
                      </label>
                    </>
                  ) : null}
                </>
              ) : null}

              {selectedNodeKind === 'human_decision' ? (
                <>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.humanDecisionReason}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={humanDecisionReason} onChange={(event) => setHumanDecisionReason(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.humanDecisionRequestedAction}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={humanDecisionRequestedAction} onChange={(event) => setHumanDecisionRequestedAction(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.humanDecisionRisk}
                    <textarea className="min-h-20 rounded border bg-background px-2 py-1 text-sm text-foreground" value={humanDecisionRisk} onChange={(event) => setHumanDecisionRisk(event.target.value)} />
                  </label>
                </>
              ) : null}

              {selectedNodeKind === 'script_review' ? (
                <>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.scriptReviewRule}
                    <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={scriptReviewRule} onChange={(event) => setScriptReviewRule(event.target.value as TeamGraphScriptReviewRuleId)}>
                      {SCRIPT_REVIEW_RULE_IDS.map((ruleId) => <option key={ruleId} value={ruleId}>{labels.scriptReviewRules[ruleId]}</option>)}
                    </select>
                  </label>
                  {scriptReviewRule === 'assertArtifactExists' ? (
                    <label className="grid gap-1 text-xs text-muted-foreground">
                      {labels.scriptReviewArtifactKind}
                      <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={scriptReviewArtifactKind} onChange={(event) => setScriptReviewArtifactKind(event.target.value)} />
                    </label>
                  ) : null}
                </>
              ) : null}

              {selectedNodeKind === 'join' ? <div className="rounded border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">{labels.joinConfigurationHint}</div> : null}
              {selectedNodeKind === 'end' ? <div className="rounded border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">{labels.endConfigurationHint}</div> : null}

              <details className="rounded border border-border/60 bg-muted/20 p-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground">{labels.advancedJson}</summary>
                <div className="mt-3 space-y-3">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.executorJson}
                    <textarea className="min-h-24 rounded border bg-background px-2 py-1 font-mono text-xs text-foreground" value={executorJson} onChange={(event) => setExecutorJson(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.configJson}
                    <textarea className="min-h-28 rounded border bg-background px-2 py-1 font-mono text-xs text-foreground" value={configJson} onChange={(event) => setConfigJson(event.target.value)} />
                  </label>
                </div>
              </details>

              <div className="flex gap-2">
                <button type="button" className="rounded border px-3 py-1.5 text-xs font-medium" onClick={() => void handleSaveNode()} disabled={isSaving}>
                  {labels.saveNode}
                </button>
                <button type="button" className="rounded border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive" onClick={() => void handleDeleteNode()} disabled={isSaving}>
                  {labels.deleteNode}
                </button>
              </div>
            </div>
          ) : null}

          {configurationSheet?.kind === 'edge' && selectedEdge ? (
            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                <div className="mb-1 font-medium text-foreground">{labels.edgeConnection}</div>
                <div className="break-all">
                  {selectedEdgeSourceNode?.title ?? selectedEdge.sourceNodeId} → {selectedEdgeTargetNode?.title ?? selectedEdge.targetNodeId}
                </div>
              </div>
              <label className="grid gap-1 text-xs text-muted-foreground">
                {labels.edgeTriggerCondition}
                <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={edgeSourcePort} onChange={(event) => {
                  const nextPort = event.target.value;
                  setEdgeSourcePort(nextPort);
                  setEdgeType(defaultEdgeTypeForSourcePort(nextPort));
                }}>
                  {sourcePortOptionsForNode(selectedEdgeSourceNode).map((port) => <option key={port} value={port}>{port}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                {labels.edgeAction}
                <select className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={edgeAction} onChange={(event) => setEdgeAction(event.target.value as TeamGraphEdgeAction)}>
                  {TEAM_GRAPH_EDGE_ACTIONS.map((action) => <option key={action} value={action}>{labels.edgeActionOptions[action]}</option>)}
                </select>
              </label>
              {selectedEdgeTargetNode?.kind === 'join' && selectedEdgeTargetHasMultipleInboundEdges && edgeAction !== 'gate' ? (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">{labels.edgeJoinGateHint}</div>
              ) : null}
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div>{labels.edgeDataTransfer}</div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={edgeIncludeUpstreamResult} onChange={(event) => setEdgeIncludeUpstreamResult(event.target.checked)} />
                  {labels.includeUpstreamResult}
                </label>
              </div>
              <details className="rounded border border-border/60 bg-muted/20 p-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground">{labels.edgeAdvancedFields}</summary>
                <div className="mt-3 space-y-3">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.sourcePort}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={edgeSourcePort} onChange={(event) => {
                      const nextPort = event.target.value;
                      setEdgeSourcePort(nextPort);
                      setEdgeType(defaultEdgeTypeForSourcePort(nextPort));
                    }} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.targetPort}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={edgeTargetPort} onChange={(event) => setEdgeTargetPort(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.edgeType}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={edgeType} onChange={(event) => setEdgeType(event.target.value)} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    {labels.edgeLabel}
                    <input className="rounded border bg-background px-2 py-1 text-sm text-foreground" value={edgeLabel} onChange={(event) => setEdgeLabel(event.target.value)} />
                  </label>
                  <div className="grid gap-1 text-xs text-muted-foreground">
                    ID
                    <div className="rounded border bg-background px-2 py-1 font-mono text-[11px] text-foreground break-all">{selectedEdge.edgeId}</div>
                  </div>
                </div>
              </details>
              <div className="flex gap-2">
                <button type="button" className="rounded border px-3 py-1.5 text-xs font-medium" onClick={() => void handleSaveEdge()} disabled={isSaving}>
                  {labels.saveEdge}
                </button>
                <button type="button" className="rounded border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive" onClick={() => void handleDeleteEdge()} disabled={isSaving}>
                  {labels.deleteEdge}
                </button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

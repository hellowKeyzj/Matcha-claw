import ELK, { type ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type {
  GraphEdgeRoute,
  GraphLayoutInput,
  GraphLayoutNode,
  GraphLayoutResult,
  GraphPoint,
} from './team-graph-layout-types';

const NODE_GAP = 72;
const CLEARANCE = 12;
const PORT_STUB = 24;
type Rect = { id: string; left: number; top: number; right: number; bottom: number };

function sourceOffset(node: GraphLayoutNode, port: string): number {
  const index = Math.max(0, node.sourcePorts.indexOf(port));
  return node.height / 2 + (index - (node.sourcePorts.length - 1) / 2) * 36;
}

function nodeRects(input: GraphLayoutInput, positions: Record<string, GraphPoint>): Rect[] {
  return input.nodes.map((node) => {
    const point = positions[node.id];
    if (!point) throw new Error(`Missing graph position: ${node.id}`);
    return { id: node.id, left: point.x, top: point.y, right: point.x + node.width, bottom: point.y + node.height };
  });
}

function isPathClear(points: GraphPoint[], obstacles: Rect[]): boolean {
  return points.every((b, index) => {
    if (index === 0) return true;
    const a = points[index - 1];
    return !obstacles.some((rect) => a.y === b.y
      ? a.y > rect.top && a.y < rect.bottom && Math.max(a.x, b.x) > rect.left && Math.min(a.x, b.x) < rect.right
      : a.x > rect.left && a.x < rect.right && Math.max(a.y, b.y) > rect.top && Math.min(a.y, b.y) < rect.bottom);
  });
}

function edgeRoute(points: GraphPoint[]): GraphEdgeRoute {
  const compact: GraphPoint[] = [];
  for (const point of points) {
    const last = compact[compact.length - 1];
    if (last?.x === point.x && last.y === point.y) continue;
    const before = compact[compact.length - 2];
    if (before && ((before.x === last.x && last.x === point.x && (last.y - before.y) * (point.y - last.y) >= 0)
      || (before.y === last.y && last.y === point.y && (last.x - before.x) * (point.x - last.x) >= 0))) compact.pop();
    compact.push(point);
  }
  let length = -1;
  let label = compact[0];
  for (let index = 1; index < compact.length; index += 1) {
    const a = compact[index - 1];
    const b = compact[index];
    const segmentLength = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (segmentLength > length) {
      length = segmentLength;
      label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return { points: compact, label };
}

function graphBounds(rects: Rect[], routes: Record<string, GraphEdgeRoute>): GraphLayoutResult['bounds'] {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  };
  for (const rect of rects) {
    include(rect.left, rect.top);
    include(rect.right, rect.bottom);
  }
  for (const route of Object.values(routes)) {
    for (const point of route.points) include(point.x, point.y);
  }
  return left === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: left, y: top, width: right - left, height: bottom - top };
}

function orthogonalPath(start: GraphPoint, end: GraphPoint, obstacles: Rect[], bounds: GraphLayoutResult['bounds']): GraphPoint[] {
  const middle = (start.x + end.x) / 2;
  const candidates = [
    [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end],
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
    ...[bounds.y + bounds.height + PORT_STUB, bounds.y - PORT_STUB].map((y) => [start, { x: start.x, y }, { x: end.x, y }, end]),
    ...[bounds.x + bounds.width + PORT_STUB, bounds.x - PORT_STUB].map((x) => [start, { x, y: start.y }, { x, y: end.y }, end]),
  ];
  // ponytail: seven deterministic channels keep drag routing O(edges × nodes).
  // Arbitrary overlapping manual positions remain drawable, not a promise of obstacle-free routing.
  return candidates.find((points) => isPathClear(points, obstacles)) ?? candidates[0];
}

function routeEdges(
  input: GraphLayoutInput,
  positions: Record<string, GraphPoint>,
  elkRoutes: Record<string, GraphEdgeRoute> = {},
): Pick<GraphLayoutResult, 'routes' | 'bounds'> {
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const rects = nodeRects(input, positions);
  const bounds = graphBounds(rects, {});
  const obstacles = rects.map((rect) => ({ ...rect, left: rect.left - CLEARANCE, top: rect.top - CLEARANCE, right: rect.right + CLEARANCE, bottom: rect.bottom + CLEARANCE }));
  const routes: Record<string, GraphEdgeRoute> = {};
  let reworkLane = 0;
  for (const edge of input.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) throw new Error(`Unknown graph edge endpoint: ${edge.id}`);
    const start = { x: positions[source.id].x + source.width, y: positions[source.id].y + sourceOffset(source, edge.sourcePort) };
    const end = { x: positions[target.id].x, y: positions[target.id].y + target.height / 2 };
    const actualRoute = elkRoutes[edge.id];
    if (actualRoute) {
      const first = actualRoute.points[0];
      const last = actualRoute.points[actualRoute.points.length - 1];
      if (first.x === start.x && first.y === start.y && last.x === end.x && last.y === end.y && isPathClear(actualRoute.points, rects)) {
        routes[edge.id] = actualRoute;
        continue;
      }
    }
    const exit = { x: start.x + PORT_STUB, y: start.y };
    const entry = { x: end.x - PORT_STUB, y: end.y };
    if (edge.rework) {
      const laneY = bounds.y + bounds.height + PORT_STUB * (2 + reworkLane++);
      const from = { x: exit.x, y: laneY };
      const to = { x: entry.x, y: laneY };
      routes[edge.id] = edgeRoute([start, ...orthogonalPath(exit, from, obstacles, bounds), to, ...orthogonalPath(to, entry, obstacles, bounds), end]);
    } else {
      routes[edge.id] = edgeRoute([start, ...orthogonalPath(exit, entry, obstacles, bounds), end]);
    }
  }
  return { routes, bounds: graphBounds(rects, routes) };
}

export function routeGraphEdges(input: GraphLayoutInput, positions: Record<string, GraphPoint>): Pick<GraphLayoutResult, 'routes' | 'bounds'> {
  return routeEdges(input, positions);
}

function elkGraph(input: GraphLayoutInput): ElkNode {
  const nodeIds = new Map(input.nodes.map((node, index) => [node.id, `n${index}`]));
  const portIds = new Map(input.nodes.map((node) => [node.id, new Map(node.sourcePorts.map((port, index) => [port, `${nodeIds.get(node.id)}-out${index}`]))]));
  const ordered = [...input.nodes].sort((a, b) => {
    const previousA = input.previousPositions?.[a.id];
    const previousB = input.previousPositions?.[b.id];
    if (!previousA || !previousB) return Number(Boolean(previousB)) - Number(Boolean(previousA));
    return previousA.y - previousB.y || previousA.x - previousB.x;
  });
  return {
    id: 'team-graph',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(NODE_GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    children: ordered.map((node) => ({
      id: nodeIds.get(node.id)!,
      ...input.previousPositions?.[node.id],
      width: node.width,
      height: node.height,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: [
        { id: `${nodeIds.get(node.id)}-in`, x: 0, y: node.height / 2, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } },
        ...node.sourcePorts.map((port) => ({
          id: portIds.get(node.id)!.get(port)!, x: node.width, y: sourceOffset(node, port), width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' },
        })),
      ],
    })),
    edges: input.edges.flatMap((edge, index) => {
      if (edge.rework) return [];
      const sourcePorts = portIds.get(edge.source);
      const source = sourcePorts?.get(edge.sourcePort) ?? sourcePorts?.values().next().value;
      const target = nodeIds.get(edge.target);
      if (!source || !target) throw new Error(`Unknown graph edge endpoint or port: ${edge.id}`);
      return [{ id: `e${index}`, sources: [source], targets: [`${target}-in`] }];
    }),
  };
}

function layoutResult(input: GraphLayoutInput, result: ElkNode): GraphLayoutResult {
  // Private ELK ids prevent arbitrary user node/port/edge ids colliding in its namespace.
  const originalIds = new Map(input.nodes.map((node, index) => [`n${index}`, node.id]));
  const automatic: Record<string, GraphPoint> = {};
  for (const node of result.children ?? []) {
    if (node.x === undefined || node.y === undefined) throw new Error(`ELK returned no graph position for ${node.id}`);
    automatic[originalIds.get(node.id)!] = { x: node.x, y: node.y };
  }
  const positions = { ...automatic };
  const fixed = input.nodes.filter((node) => input.fixedPositions[node.id]);
  if (fixed.length) {
    for (const node of input.nodes) {
      positions[node.id] = input.fixedPositions[node.id] ?? { ...automatic[node.id] };
    }
    const occupied = nodeRects({ ...input, nodes: fixed }, positions).sort((a, b) => a.top - b.top);
    // ponytail: fixed-node collision placement is O(nodes²); keep automatic x layers intact.
    for (const node of input.nodes) {
      if (input.fixedPositions[node.id]) continue;
      const point = positions[node.id];
      for (const rect of occupied) {
        if (point.x + node.width <= rect.left || point.x >= rect.right) continue;
        if (point.y + node.height <= rect.top || point.y >= rect.bottom) continue;
        point.y = rect.bottom + NODE_GAP;
      }
      const rect = { id: node.id, left: point.x, top: point.y, right: point.x + node.width, bottom: point.y + node.height };
      const index = occupied.findIndex((other) => other.top > rect.top);
      occupied.splice(index < 0 ? occupied.length : index, 0, rect);
    }
  }
  const routes: Record<string, GraphEdgeRoute> = {};
  for (const edge of result.edges ?? []) {
    const section = edge.sections?.[0];
    if (!section || edge.sections?.length !== 1) throw new Error(`ELK returned no continuous graph route for ${edge.id}`);
    const original = input.edges[Number(edge.id.slice(1))];
    const dx = positions[original.source].x - automatic[original.source].x;
    const dy = positions[original.source].y - automatic[original.source].y;
    routes[original.id] = edgeRoute([section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({ x: point.x + dx, y: point.y + dy })));
  }
  return { positions, ...routeEdges(input, positions, routes) };
}

export function createGraphLayoutEngine(): { layout(input: GraphLayoutInput): Promise<GraphLayoutResult>; dispose(): void } {
  let elk: InstanceType<typeof ELK> | undefined;
  let disposed = false;
  const pending = new Set<(error: Error) => void>();
  const stop = (error: Error) => {
    elk?.terminateWorker();
    elk = undefined;
    for (const reject of pending) reject(error);
    pending.clear();
  };
  return {
    layout(input) {
      if (disposed) return Promise.reject(new Error('The graph layout engine has been disposed.'));
      return new Promise((resolve, reject) => {
        pending.add(reject);
        void (async () => {
          elk ??= new ELK({
            algorithms: ['layered'],
            workerFactory: () => {
              const worker = new Worker(elkWorkerUrl);
              worker.addEventListener('error', () => stop(new Error('The graph layout worker failed. Retry layout.')));
              worker.addEventListener('messageerror', () => stop(new Error('The graph layout worker returned an unreadable response. Retry layout.')));
              return worker;
            },
          });
          const result = await elk.layout(elkGraph(input));
          if (pending.has(reject)) resolve(layoutResult(input, result));
        })().catch(reject).finally(() => pending.delete(reject));
      });
    },
    dispose() {
      disposed = true;
      stop(new Error('The graph layout engine has been disposed.'));
    },
  };
}

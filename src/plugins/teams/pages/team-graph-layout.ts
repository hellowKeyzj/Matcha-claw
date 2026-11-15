import ELK, { type ElkNode } from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { graphPortPosition } from '@/plugins/teams/pages/team-graph-geometry';
import type {
  GraphEdgeRoute,
  GraphEdgeRouter,
  GraphLayoutDirection,
  GraphLayoutInput,
  GraphLayoutResult,
  GraphPoint,
} from '@/plugins/teams/pages/team-graph-layout-types';

const NODE_GAP = 72;
const CLEARANCE = 12;
const PORT_STUB = 24;
type Rect = { id: string; left: number; top: number; right: number; bottom: number };
type RouteDependencies = { paths: GraphPoint[][]; boundsMask: number };
type EdgeRoutingState = {
  previous?: {
    input: Pick<GraphLayoutInput, 'direction' | 'nodes' | 'edges'>;
    rects: Rect[];
    nodeBounds: GraphLayoutResult['bounds'];
    result: ReturnType<GraphEdgeRouter>;
    dependencies: RouteDependencies[];
  };
};

function expandedObstacle(rect: Rect): Rect {
  return { ...rect, left: rect.left - CLEARANCE, top: rect.top - CLEARANCE, right: rect.right + CLEARANCE, bottom: rect.bottom + CLEARANCE };
}

function nodeRects(input: GraphLayoutInput, positions: Record<string, GraphPoint>): Rect[] {
  return input.nodes.map((node) => {
    const point = Object.hasOwn(positions, node.id) ? positions[node.id] : undefined;
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

function orthogonalPath(
  start: GraphPoint,
  end: GraphPoint,
  obstacles: Rect[],
  bounds: GraphLayoutResult['bounds'],
  direction: GraphLayoutDirection,
  dependencies?: RouteDependencies,
): GraphPoint[] {
  const vertical = direction === 'vertical';
  const middle = vertical ? (start.y + end.y) / 2 : (start.x + end.x) / 2;
  const horizontalChannels = [bounds.y + bounds.height + PORT_STUB, bounds.y - PORT_STUB]
    .map((y) => [start, { x: start.x, y }, { x: end.x, y }, end]);
  const verticalChannels = [bounds.x + bounds.width + PORT_STUB, bounds.x - PORT_STUB]
    .map((x) => [start, { x, y: start.y }, { x, y: end.y }, end]);
  const candidates = [
    vertical
      ? [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end]
      : [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end],
    [start, vertical ? { x: start.x, y: end.y } : { x: end.x, y: start.y }, end],
    [start, vertical ? { x: end.x, y: start.y } : { x: start.x, y: end.y }, end],
    ...(vertical ? verticalChannels : horizontalChannels),
    ...(vertical ? horizontalChannels : verticalChannels),
  ];
  const outerBoundsBits = vertical ? [4, 8, 1, 2] : [1, 2, 4, 8];
  // ponytail: seven deterministic channels keep drag routing O(edges × nodes).
  // Arbitrary overlapping manual positions remain drawable, not a promise of obstacle-free routing.
  return candidates.find((points, index) => {
    if (dependencies) {
      // Rejected earlier channels matter too: removing an obstacle can make them win.
      dependencies.paths.push(points);
      if (index >= 3) dependencies.boundsMask |= outerBoundsBits[index - 3];
    }
    return isPathClear(points, obstacles);
  }) ?? candidates[0];
}

function routeEdges(
  input: GraphLayoutInput,
  positions: Record<string, GraphPoint>,
  elkRoutes: Record<string, GraphEdgeRoute> = {},
  state?: EdgeRoutingState,
): Pick<GraphLayoutResult, 'routes' | 'bounds'> {
  const rects = nodeRects(input, positions);
  const bounds = graphBounds(rects, {});
  const previous = state?.previous;
  const sameShape = previous && input.direction === previous.input.direction
    && input.nodes.length === previous.input.nodes.length && input.edges.length === previous.input.edges.length
    && input.nodes.every((node, index) => {
      const old = previous.input.nodes[index];
      return node.id === old.id && Object.is(node.width, old.width) && Object.is(node.height, old.height)
        && node.sourcePorts.length === old.sourcePorts.length && node.sourcePorts.every((port, portIndex) => port === old.sourcePorts[portIndex]);
    }) && input.edges.every((edge, index) => {
      const old = previous.input.edges[index];
      return edge.id === old.id && edge.source === old.source && edge.target === old.target && edge.sourcePort === old.sourcePort && edge.rework === old.rework;
    });
  const moved: number[] = [];
  if (sameShape) {
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (!Object.is(rect.left, previous.rects[index].left) || !Object.is(rect.top, previous.rects[index].top)) moved.push(index);
    }
  }
  if (sameShape && moved.length === 0) return previous.result;
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const obstacles = rects.map(expandedObstacle);
  const changedObstacles = sameShape ? moved.flatMap((index) => [expandedObstacle(previous.rects[index]), obstacles[index]]) : [];
  // Physical bounds bits stay bottom=1, top=2, right=4, left=8 in either direction.
  let changedBounds = 0;
  if (sameShape) {
    if (bounds.y + bounds.height !== previous.nodeBounds.y + previous.nodeBounds.height) changedBounds |= 1;
    if (bounds.y !== previous.nodeBounds.y) changedBounds |= 2;
    if (bounds.x + bounds.width !== previous.nodeBounds.x + previous.nodeBounds.width) changedBounds |= 4;
    if (bounds.x !== previous.nodeBounds.x) changedBounds |= 8;
  }
  const routes: Record<string, GraphEdgeRoute> = Object.create(null);
  const dependencies: RouteDependencies[] | undefined = state ? [] : undefined;
  const movedIds = new Set(moved.map((index) => rects[index].id));
  const vertical = input.direction === 'vertical';
  let reworkLane = 0;
  for (const [index, edge] of input.edges.entries()) {
    const oldDependencies = sameShape ? previous.dependencies[index] : undefined;
    // No decision can change unless a tried channel meets an old/new obstacle or a bound it used moves.
    if (oldDependencies && !movedIds.has(edge.source) && !movedIds.has(edge.target)
      && !(oldDependencies.boundsMask & changedBounds)
      && oldDependencies.paths.every((points) => isPathClear(points, changedObstacles))) {
      routes[edge.id] = previous!.result.routes[edge.id];
      dependencies!.push(oldDependencies);
      if (edge.rework) reworkLane += 1;
      continue;
    }
    const dependency = dependencies ? { paths: [], boundsMask: edge.rework ? (vertical ? 4 : 1) : 0 } : undefined;
    if (dependency) dependencies!.push(dependency);
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) throw new Error(`Unknown graph edge endpoint: ${edge.id}`);
    const sourcePort = graphPortPosition(source, input.direction, edge.sourcePort);
    const targetPort = graphPortPosition(target, input.direction);
    const start = { x: positions[source.id].x + sourcePort.x, y: positions[source.id].y + sourcePort.y };
    const end = { x: positions[target.id].x + targetPort.x, y: positions[target.id].y + targetPort.y };
    const actualRoute = Object.hasOwn(elkRoutes, edge.id) ? elkRoutes[edge.id] : undefined;
    if (actualRoute) {
      const first = actualRoute.points[0];
      const last = actualRoute.points[actualRoute.points.length - 1];
      if (first.x === start.x && first.y === start.y && last.x === end.x && last.y === end.y && isPathClear(actualRoute.points, rects)) {
        routes[edge.id] = actualRoute;
        continue;
      }
    }
    const exit = { x: start.x + (vertical ? 0 : PORT_STUB), y: start.y + (vertical ? PORT_STUB : 0) };
    const entry = { x: end.x - (vertical ? 0 : PORT_STUB), y: end.y - (vertical ? PORT_STUB : 0) };
    if (edge.rework) {
      const lane = (vertical ? bounds.x + bounds.width : bounds.y + bounds.height) + PORT_STUB * (2 + reworkLane++);
      const from = vertical ? { x: lane, y: exit.y } : { x: exit.x, y: lane };
      const to = vertical ? { x: lane, y: entry.y } : { x: entry.x, y: lane };
      routes[edge.id] = edgeRoute([start, ...orthogonalPath(exit, from, obstacles, bounds, input.direction, dependency), to, ...orthogonalPath(to, entry, obstacles, bounds, input.direction, dependency), end]);
    } else {
      routes[edge.id] = edgeRoute([start, ...orthogonalPath(exit, entry, obstacles, bounds, input.direction, dependency), end]);
    }
  }
  const result = { routes, bounds: graphBounds(rects, routes) };
  if (state) {
    state.previous = {
      input: sameShape ? previous.input : {
        direction: input.direction,
        nodes: input.nodes.map((node) => ({ ...node, sourcePorts: [...node.sourcePorts] })),
        edges: input.edges.map((edge) => ({ ...edge })),
      },
      rects, nodeBounds: bounds, result, dependencies: dependencies!,
    };
  }
  return result;
}

export function routeGraphEdges(input: GraphLayoutInput, positions: Record<string, GraphPoint>): Pick<GraphLayoutResult, 'routes' | 'bounds'> {
  return routeEdges(input, positions);
}

export function createGraphEdgeRouter(): GraphEdgeRouter {
  // One previous geometry per consumer scope; no routes survive a new router.
  const state: EdgeRoutingState = {};
  return (input, positions) => routeEdges(input, positions, {}, state);
}

function elkGraph(input: GraphLayoutInput): ElkNode {
  const vertical = input.direction === 'vertical';
  const nodeIds = new Map(input.nodes.map((node, index) => [node.id, `n${index}`]));
  const portIds = new Map(input.nodes.map((node) => [node.id, new Map(node.sourcePorts.map((port, index) => [port, `${nodeIds.get(node.id)}-out${index}`]))]));
  const previousPositions = new Map(Object.entries(input.previousPositions ?? {}));
  const ordered = [...input.nodes].sort((a, b) => {
    const previousA = previousPositions.get(a.id);
    const previousB = previousPositions.get(b.id);
    if (!previousA || !previousB) return Number(Boolean(previousB)) - Number(Boolean(previousA));
    return vertical ? previousA.x - previousB.x || previousA.y - previousB.y
      : previousA.y - previousB.y || previousA.x - previousB.x;
  });
  return {
    id: 'team-graph',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': vertical ? 'DOWN' : 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(NODE_GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    children: ordered.map((node) => ({
      id: nodeIds.get(node.id)!,
      ...previousPositions.get(node.id),
      width: node.width,
      height: node.height,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: [
        { id: `${nodeIds.get(node.id)}-in`, ...graphPortPosition(node, input.direction), width: 0, height: 0, layoutOptions: { 'elk.port.side': vertical ? 'NORTH' : 'WEST' } },
        ...node.sourcePorts.map((port) => ({
          id: portIds.get(node.id)!.get(port)!, ...graphPortPosition(node, input.direction, port), width: 0, height: 0, layoutOptions: { 'elk.port.side': vertical ? 'SOUTH' : 'EAST' },
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
  const vertical = input.direction === 'vertical';
  // Private ELK ids prevent arbitrary user node/port/edge ids colliding in its namespace.
  const originalIds = new Map(input.nodes.map((node, index) => [`n${index}`, node.id]));
  const automatic: Record<string, GraphPoint> = Object.create(null);
  for (const node of result.children ?? []) {
    if (node.x === undefined || node.y === undefined) throw new Error(`ELK returned no graph position for ${node.id}`);
    automatic[originalIds.get(node.id)!] = { x: node.x, y: node.y };
  }
  const positions: Record<string, GraphPoint> = Object.assign(Object.create(null), automatic);
  const fixedPositions = new Map(Object.entries(input.fixedPositions));
  const fixed = input.nodes.filter((node) => fixedPositions.has(node.id));
  if (fixed.length) {
    for (const node of input.nodes) {
      positions[node.id] = fixedPositions.get(node.id) ?? { ...automatic[node.id] };
    }
    const occupied = nodeRects({ ...input, nodes: fixed }, positions).sort((a, b) => vertical ? a.left - b.left : a.top - b.top);
    // ponytail: fixed-node collision placement is O(nodes²); preserve the automatic main-axis layers.
    for (const node of input.nodes) {
      if (fixedPositions.has(node.id)) continue;
      const point = positions[node.id];
      for (const rect of occupied) {
        if (point.x + node.width <= rect.left || point.x >= rect.right) continue;
        if (point.y + node.height <= rect.top || point.y >= rect.bottom) continue;
        if (vertical) point.x = rect.right + NODE_GAP;
        else point.y = rect.bottom + NODE_GAP;
      }
      const rect = { id: node.id, left: point.x, top: point.y, right: point.x + node.width, bottom: point.y + node.height };
      const index = occupied.findIndex((other) => vertical ? other.left > rect.left : other.top > rect.top);
      occupied.splice(index < 0 ? occupied.length : index, 0, rect);
    }
  }
  for (const node of input.nodes) {
    const point = positions[node.id];
    if (!fixedPositions.has(node.id)) positions[node.id] = { x: Math.round(point.x), y: Math.round(point.y) };
  }
  const routes: Record<string, GraphEdgeRoute> = Object.create(null);
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

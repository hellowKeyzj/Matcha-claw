import type { WikiGraphEdge, WikiGraphNode, WikiGraphResult } from './wiki-model';

export type GraphFilters = Readonly<{
  query: string;
  hiddenTypes: ReadonlySet<string>;
  hiddenNodeIds: ReadonlySet<string>;
  hideStructural: boolean;
  hideIsolated: boolean;
  minLinks: string;
  maxLinks: string;
}>;

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  query: '', hiddenTypes: new Set(), hiddenNodeIds: new Set(),
  hideStructural: true, hideIsolated: false, minLinks: '', maxLinks: '',
};

export function graphNodeType(node: WikiGraphNode): string {
  return node.kind.trim().toLowerCase() || 'other';
}

export function isStructuralGraphNode(node: WikiGraphNode): boolean {
  const path = node.relativePath.replace(/\\/g, '/').toLowerCase();
  const name = path.split('/').pop()?.replace(/\.md$/, '');
  return graphNodeType(node) === 'overview'
    || name === 'schema' || name === 'purpose'
    || ((path.includes('/wiki/') || path.startsWith('wiki/') || !path.includes('/'))
      && (name === 'index' || name === 'overview' || name === 'log'));
}

export function indexGraph(graph: WikiGraphResult | null) {
  const nodes = graph?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  const incident = new Map(nodes.map((node) => [node.id, [] as WikiGraphEdge[]]));
  const searchText = new Map<string, string>();
  const typeCounts = new Map<string, number>();
  const edges = (graph?.edges ?? []).filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  for (const node of nodes) {
    const type = graphNodeType(node);
    searchText.set(node.id, `${node.label} ${node.id} ${type} ${node.relativePath}`.toLowerCase());
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  for (const edge of edges) {
    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
    degree.set(edge.source, degree.get(edge.source)! + 1);
    degree.set(edge.target, degree.get(edge.target)! + 1);
    incident.get(edge.source)!.push(edge);
    if (edge.target !== edge.source) incident.get(edge.target)!.push(edge);
  }
  return { nodes, edges, byId, neighbors, degree, incident, searchText, typeCounts };
}

export type GraphIndex = ReturnType<typeof indexGraph>;

export function filterGraph(index: GraphIndex, filters: GraphFilters) {
  const tokens = filters.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const min = filters.minLinks === '' ? undefined : Number(filters.minLinks);
  const max = filters.maxLinks === '' ? undefined : Number(filters.maxLinks);
  const nodes = index.nodes.filter((node) => {
    const degree = index.degree.get(node.id)!;
    return !filters.hiddenTypes.has(graphNodeType(node))
      && !filters.hiddenNodeIds.has(node.id)
      && (!filters.hideStructural || !isStructuralGraphNode(node))
      && (!filters.hideIsolated || degree > 0)
      && (min === undefined || degree >= min)
      && (max === undefined || degree <= max)
      && tokens.every((token) => index.searchText.get(node.id)!.includes(token));
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = index.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return { nodes, edges, ids };
}

export type GraphPoint = Readonly<{ x: number; y: number }>;

export function layoutGraph(index: GraphIndex): Map<string, GraphPoint> {
  const positions = new Map<string, GraphPoint>();
  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const node of index.nodes) {
    if (visited.has(node.id)) continue;
    const group = [node.id];
    visited.add(node.id);
    for (let cursor = 0; cursor < group.length; cursor++) {
      for (const neighbor of index.neighbors.get(group[cursor])!) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          group.push(neighbor);
        }
      }
    }
    groups.push(group);
  }
  const sizes = groups.map((group) => Math.max(180, Math.sqrt(group.length) * 140));
  const rowWidth = Math.max(400, Math.sqrt(sizes.reduce((area, size) => area + size * size, 0)) * 1.4);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  // ponytail: O(V+E) component/spiral layout; replace with worker force-layout only if topology readability needs it.
  groups.forEach((group, groupIndex) => {
    const size = sizes[groupIndex];
    if (x > 0 && x + size > rowWidth) {
      y += rowHeight + 60;
      x = 0;
      rowHeight = 0;
    }
    group.forEach((id, nodeIndex) => {
      const radius = 62 * Math.sqrt(nodeIndex);
      const angle = nodeIndex * Math.PI * (3 - Math.sqrt(5));
      positions.set(id, { x: x + size / 2 + Math.cos(angle) * radius, y: y + size / 2 + Math.sin(angle) * radius });
    });
    x += size + 60;
    rowHeight = Math.max(rowHeight, size);
  });
  return positions;
}

// Fixed hues + shapes keep type identity stable when filters change; custom types retain their text labels.
export function graphNodeAppearance(type: string) {
  if (type === 'source') return { color: '[--graph-color:#eb6834] dark:[--graph-color:#d95926]', shape: 'square' } as const;
  if (type === 'concept' || type === 'synthesis' || type === 'comparison') return { color: '[--graph-color:#1baf7a] dark:[--graph-color:#199e70]', shape: 'diamond' } as const;
  return { color: '[--graph-color:#2a78d6] dark:[--graph-color:#3987e5]', shape: 'circle' } as const;
}

export type GraphPoint = { x: number; y: number };
export type GraphNodeSize = { width: number; height: number };

export type GraphLayoutNode = GraphNodeSize & {
  id: string;
  sourcePorts: string[];
};

export type GraphLayoutEdge = {
  id: string;
  source: string;
  target: string;
  sourcePort: string;
  rework: boolean;
};

export type GraphLayoutInput = {
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  fixedPositions: Record<string, GraphPoint>;
  previousPositions?: Record<string, GraphPoint>;
};

export type GraphEdgeRoute = {
  points: GraphPoint[];
  label: GraphPoint;
};

export type GraphLayoutResult = {
  positions: Record<string, GraphPoint>;
  routes: Record<string, GraphEdgeRoute>;
  bounds: { x: number; y: number; width: number; height: number };
};

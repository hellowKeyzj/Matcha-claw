import type { GraphLayoutDirection, GraphLayoutNode, GraphNodeSize, GraphPoint } from './team-graph-layout-types';

// Saved positions retain their horizontal coordinate basis; the vertical view swaps axes.
export function graphPositionForDirection(point: GraphPoint, direction: GraphLayoutDirection): GraphPoint {
  return direction === 'vertical' ? { x: point.y, y: point.x } : point;
}

export function graphPortPosition(
  node: GraphNodeSize & Pick<GraphLayoutNode, 'sourcePorts'>,
  direction: GraphLayoutDirection,
  sourcePort?: string,
): GraphPoint {
  const vertical = direction === 'vertical';
  const offset = sourcePort === undefined ? 0
    : (Math.max(0, node.sourcePorts.indexOf(sourcePort)) - (node.sourcePorts.length - 1) / 2) * 36;
  return vertical
    ? { x: node.width / 2 + offset, y: sourcePort === undefined ? 0 : node.height }
    : { x: sourcePort === undefined ? 0 : node.width, y: node.height / 2 + offset };
}

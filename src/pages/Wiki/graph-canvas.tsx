import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WikiGraphEdge, WikiGraphNode } from './wiki-model';
import { graphNodeAppearance, graphNodeType, type GraphIndex, type GraphPoint } from './graph-data';

type View = Readonly<{ x: number; y: number; scale: number }>;

type GraphCanvasProps = Readonly<{
  nodes: readonly WikiGraphNode[];
  edges: readonly WikiGraphEdge[];
  index: GraphIndex;
  positions: ReadonlyMap<string, GraphPoint>;
  selectedId: string | null;
  selectedPath: string;
  nodeScale: number;
  spacing: number;
  onSelect(id: string | null): void;
  onOpenNode(path: string): void;
}>;

export function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  const { nodes, edges, index, positions, selectedId, selectedPath, nodeScale, spacing, onSelect, onOpenNode } = props;
  const { t } = useTranslation('wiki');
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; view: View } | null>(null);
  const dragged = useRef(false);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [camera, setCamera] = useState<{ frame: View; view: View } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const activeId = hoveredId ?? selectedId;
  const neighbors = activeId ? index.neighbors.get(activeId) : undefined;
  const activeNode = activeId ? index.byId.get(activeId) : undefined;
  const maxDegree = useMemo(() => {
    let max = 1;
    for (const node of nodes) max = Math.max(max, index.degree.get(node.id)!);
    return max;
  }, [index, nodes]);

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fittedView = useMemo<View>(() => {
    if (nodes.length === 0) return { x: 0, y: 0, scale: 1 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      const point = positions.get(node.id)!;
      minX = Math.min(minX, point.x * spacing);
      minY = Math.min(minY, point.y * spacing);
      maxX = Math.max(maxX, point.x * spacing);
      maxY = Math.max(maxY, point.y * spacing);
    }
    const scale = Math.max(0.02, Math.min(2, (size.width - 100) / Math.max(100, maxX - minX), (size.height - 100) / Math.max(100, maxY - minY)));
    return { scale, x: size.width / 2 - (minX + maxX) / 2 * scale, y: size.height / 2 - (minY + maxY) / 2 * scale };
  }, [nodes, positions, size, spacing]);
  const view = camera?.frame === fittedView ? camera.view : fittedView;

  const zoom = useCallback((factor: number, x: number, y: number) => {
    setCamera((previous) => {
      const current = previous?.frame === fittedView ? previous.view : fittedView;
      const scale = Math.max(0.02, Math.min(8, current.scale * factor));
      const ratio = scale / current.scale;
      return { frame: fittedView, view: { scale, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio } };
    });
  }, [fittedView]);

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoom]);

  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view };
    dragged.current = false;
  }

  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) > 4) {
      dragged.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setCamera({ frame: fittedView, view: { ...start.view, x: start.view.x + dx, y: start.view.y + dy } });
    }
  }

  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }

  return (
    <div className="relative min-h-[280px] min-w-0 flex-1 overflow-hidden bg-[hsl(var(--shell-surface-muted))]">
      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none text-foreground"
        role="group"
        aria-label={t('graph.canvasLabel', { defaultValue: '知识图谱；滚轮缩放，拖动平移，点选节点查看关联，双击打开页面' })}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onClick={() => { if (!dragged.current) onSelect(null); }}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((edge, i) => {
            const source = positions.get(edge.source)!;
            const target = positions.get(edge.target)!;
            const active = activeId === edge.source || activeId === edge.target;
            return (
              <line
                key={`${edge.source}:${edge.target}:${i}`}
                x1={source.x * spacing} y1={source.y * spacing}
                x2={target.x * spacing} y2={target.y * spacing}
                vectorEffect="non-scaling-stroke"
                className={active ? 'stroke-[hsl(var(--shell-icon-active))]' : 'stroke-muted-foreground'}
                strokeWidth={active ? 2 : 1}
                opacity={active ? 0.85 : activeId ? 0.08 : 0.22}
                pointerEvents="none"
              />
            );
          })}
          {nodes.map((node) => {
            const point = positions.get(node.id)!;
            const type = graphNodeType(node);
            const appearance = graphNodeAppearance(type);
            const degree = index.degree.get(node.id)!;
            const radius = (7 + Math.sqrt(degree / maxDegree) * 9) * nodeScale;
            const active = node.id === activeId;
            const related = neighbors?.has(node.id);
            const showLabel = active || related || nodes.length <= 35;
            return (
              <g
                key={node.id}
                transform={`translate(${point.x * spacing} ${point.y * spacing})`}
                className={cn('cursor-pointer outline-none', appearance.color)}
                role="button"
                tabIndex={0}
                aria-pressed={node.id === selectedId}
                aria-label={t('graph.nodeAccessibleLabel', { defaultValue: '{{label}}，{{type}}，{{count}} 条连接', label: node.label, type, count: degree })}
                onPointerEnter={() => setHoveredId(node.id)}
                onPointerLeave={() => setHoveredId(null)}
                onFocus={() => setHoveredId(node.id)}
                onBlur={() => setHoveredId(null)}
                onClick={(event) => { event.stopPropagation(); if (!dragged.current) onSelect(node.id); }}
                onDoubleClick={(event) => { event.stopPropagation(); if (!dragged.current) onOpenNode(node.relativePath); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); }
                  if (event.key === 'Escape') onSelect(null);
                }}
              >
                <title>{`${node.label}\n${type} · ${degree}\n${node.relativePath}`}</title>
                <circle r={Math.max(radius + 5, 14 / view.scale)} fill="transparent" />
                <g fill="var(--graph-color)" className="forced-colors:fill-[CanvasText]" opacity={activeId && !active && !related ? 0.2 : 1} stroke="hsl(var(--shell-surface-muted))" strokeWidth={2} vectorEffect="non-scaling-stroke">
                  {appearance.shape === 'square' ? <rect x={-radius} y={-radius} width={radius * 2} height={radius * 2} rx={3} />
                    : appearance.shape === 'diamond' ? <path d={`M 0 ${-radius * 1.2} L ${radius * 1.2} 0 L 0 ${radius * 1.2} L ${-radius * 1.2} 0 Z`} />
                      : <circle r={radius} />}
                </g>
                {node.id === selectedId || node.relativePath === selectedPath || active ? <circle r={radius + 4} fill="none" stroke="hsl(var(--shell-icon-active))" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null}
                {showLabel ? <text y={radius + 6 + 12 / view.scale} textAnchor="middle" className="fill-current" fontSize={12 / view.scale} pointerEvents="none">{node.label.length > 24 ? `${node.label.slice(0, 24)}…` : node.label}</text> : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute right-3 top-3 flex flex-col gap-1 rounded-2xl border bg-card/95 p-1 shadow-sm">
        {[
          { label: t('graph.zoomIn', { defaultValue: '放大' }), Icon: ZoomIn, action: () => zoom(1.3, size.width / 2, size.height / 2) },
          { label: t('graph.zoomOut', { defaultValue: '缩小' }), Icon: ZoomOut, action: () => zoom(1 / 1.3, size.width / 2, size.height / 2) },
          { label: t('graph.fitGraph', { defaultValue: '适应窗口' }), Icon: Maximize, action: () => setCamera(null) },
        ].map(({ label, Icon, action }) => <Button key={label} type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" title={label} aria-label={label} onClick={action}><Icon className="h-4 w-4" /></Button>)}
      </div>
      {activeNode ? (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] rounded-2xl border bg-card/95 px-3 py-2 text-xs shadow-sm" role="status">
          <div className="truncate font-medium">{activeNode.label}</div>
          <div className="mt-1 truncate text-muted-foreground">{graphNodeType(activeNode)} · {t('graph.connectionCount', { defaultValue: '{{count}} 条连接', count: index.degree.get(activeNode.id) })}</div>
          <div className="truncate text-muted-foreground">{activeNode.relativePath}</div>
        </div>
      ) : <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-muted-foreground">{t('graph.interactionHint', { defaultValue: '滚轮缩放 · 拖动平移 · 点选探索 · 双击打开' })}</div>}
    </div>
  );
}

import { useMemo, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOff, Filter, GitBranch, List, Network, RotateCcw, Search, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { WikiGraphResult } from '../wiki-model';
import { DEFAULT_GRAPH_FILTERS, filterGraph, graphNodeAppearance, graphNodeType, indexGraph, layoutGraph } from '../graph-data';
import { GraphCanvas } from '../graph-canvas';
import { WikiEmpty, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type GraphPanelProps = Readonly<{
  graph: WikiGraphResult | null;
  selectedPath: string;
  highlightedNodeIds?: readonly string[];
  busy: string | null;
  onLoadGraph(): void;
  onEmbedPage(): void;
  onOpenNode(path: string): void;
}>;

export function GraphPanel(props: GraphPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const { graph, selectedPath, highlightedNodeIds, busy, onLoadGraph, onEmbedPage, onOpenNode } = props;
  const [filters, setFilters] = useState(DEFAULT_GRAPH_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showList, setShowList] = useState(false);
  const [selection, setSelection] = useState<{ id: string | null; highlights: readonly string[] | undefined }>({ id: null, highlights: highlightedNodeIds });
  const [focusNeighbors, setFocusNeighbors] = useState(false);
  const [nodeScale, setNodeScale] = useState(1);
  const [spacing, setSpacing] = useState(1);
  const index = useMemo(() => indexGraph(graph), [graph]);
  const positions = useMemo(() => layoutGraph(index), [index]);
  const filtered = useMemo(() => filterGraph(index, filters), [index, filters]);
  const highlightedIds = useMemo(() => new Set(highlightedNodeIds?.filter((id) => index.byId.has(id))), [highlightedNodeIds, index]);
  const selectedId = useMemo(() => selection.highlights === highlightedNodeIds ? selection.id : highlightedNodeIds?.find((id) => index.byId.has(id)) ?? null, [highlightedNodeIds, index, selection]);
  const selected = selectedId ? index.byId.get(selectedId) : undefined;
  const visible = useMemo(() => {
    if (highlightedIds.size > 0) return {
      nodes: index.nodes.filter((node) => highlightedIds.has(node.id)),
      ids: highlightedIds,
      edges: index.edges.filter((edge) => highlightedIds.has(edge.source) && highlightedIds.has(edge.target)),
    };
    if (!focusNeighbors || !selectedId || !filtered.ids.has(selectedId)) return filtered;
    const neighbors = index.neighbors.get(selectedId)!;
    const nodes = filtered.nodes.filter((node) => node.id === selectedId || neighbors.has(node.id));
    const ids = new Set(nodes.map((node) => node.id));
    return { nodes, ids, edges: filtered.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [filtered, focusNeighbors, highlightedIds, index, selectedId]);
  const relations = useMemo(() => selectedId ? (index.incident.get(selectedId) ?? []).filter((edge) => visible.ids.has(edge.source) && visible.ids.has(edge.target)) : [], [index, selectedId, visible.ids]);
  const isBusy = busy !== null;
  const types = useMemo(() => [...index.typeCounts.entries()].sort(([a], [b]) => a.localeCompare(b)), [index]);

  function resetFilters() {
    setFilters(DEFAULT_GRAPH_FILTERS);
    setFocusNeighbors(false);
    setNodeScale(1);
    setSpacing(1);
  }

  function selectNode(id: string | null) {
    setSelection({ id, highlights: highlightedNodeIds });
    if (id === null) setFocusNeighbors(false);
  }

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('graph.title')}
        subtitle={t('graph.subtitle', { nodes: index.nodes.length, edges: index.edges.length })}
        icon={Network}
        actions={(
          <>
            <WikiPrimaryButton size="sm" onClick={onLoadGraph} disabled={isBusy}>
              <GitBranch className="h-4 w-4" />
              {t('graph.load')}
            </WikiPrimaryButton>
            <Button size="sm" variant="outline" onClick={onEmbedPage} disabled={isBusy || !selectedPath.trim()} className="h-8 rounded-full bg-card">
              <Sparkles className="h-4 w-4" />
              {t('graph.embed')}
            </Button>
          </>
        )}
      />

      {graph === null ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center"><WikiEmpty title={t('graph.empty')} icon={Network} className="px-12 py-10" /></div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-3 [border-color:hsl(var(--shell-border))]">
            <div className="relative min-w-40 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filters.query}
                onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                onKeyDown={(event) => { if (event.key === 'Escape') setFilters((current) => ({ ...current, query: '' })); }}
                placeholder={t('graph.searchPlaceholder', { defaultValue: '搜索节点名称、路径或类型（匹配全部关键词）' })}
                aria-label={t('graph.searchLabel', { defaultValue: '搜索图谱节点' })}
                className="h-8 rounded-full pl-9 pr-9 text-xs"
              />
              {filters.query ? <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-label={t('graph.clearSearch', { defaultValue: '清除搜索' })} onClick={() => setFilters((current) => ({ ...current, query: '' }))}><X className="h-3.5 w-3.5" /></button> : null}
            </div>
            <Button size="sm" variant={showFilters ? 'secondary' : 'ghost'} className="h-8 rounded-full" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}><Filter className="h-4 w-4" />{t('graph.filter', { defaultValue: '筛选' })}</Button>
            <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={resetFilters}><RotateCcw className="h-4 w-4" />{t('graph.resetFilters', { defaultValue: '重置筛选' })}</Button>
            <Button size="sm" variant={showList ? 'secondary' : 'ghost'} className="h-8 rounded-full" aria-pressed={showList} onClick={() => setShowList(!showList)}><List className="h-4 w-4" />{t('graph.listView', { defaultValue: '节点列表' })}</Button>
            <span className="text-xs text-muted-foreground" role="status">{t('graph.visibleStats', { defaultValue: '{{nodes}}/{{totalNodes}} 节点 · {{edges}}/{{totalEdges}} 关系', nodes: visible.nodes.length, totalNodes: index.nodes.length, edges: visible.edges.length, totalEdges: index.edges.length })}</span>
          </div>

          {showFilters ? (
            <div className="flex max-h-52 shrink-0 flex-wrap items-center gap-x-5 gap-y-3 overflow-auto border-b px-5 py-3 text-xs [border-color:hsl(var(--shell-border))]">
              <label className="flex items-center gap-2"><input type="checkbox" checked={filters.hideStructural} onChange={(event) => setFilters((current) => ({ ...current, hideStructural: event.target.checked }))} />{t('graph.hideStructural', { defaultValue: '隐藏索引、总览等结构节点' })}</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={filters.hideIsolated} onChange={(event) => setFilters((current) => ({ ...current, hideIsolated: event.target.checked }))} />{t('graph.hideIsolated', { defaultValue: '隐藏孤立节点' })}</label>
              {(['minLinks', 'maxLinks'] as const).map((field) => (
                <label key={field} className="flex items-center gap-2">
                  {field === 'minLinks' ? t('graph.minLinks', { defaultValue: '最少连接数' }) : t('graph.maxLinks', { defaultValue: '最多连接数' })}
                  <Input type="number" min={0} step={1} value={filters[field]} placeholder={t('graph.any', { defaultValue: '不限' })} className="h-8 w-20 rounded-lg px-2 text-xs" onChange={(event) => {
                    const raw = event.target.value;
                    setFilters((current) => ({ ...current, [field]: raw === '' ? '' : String(Math.max(0, Number(raw))) }));
                  }} />
                </label>
              ))}
              <label className="flex items-center gap-2">{t('graph.nodeSize', { defaultValue: '节点大小' })}<input type="range" min={0.5} max={1.5} step={0.05} value={nodeScale} onChange={(event) => setNodeScale(Number(event.target.value))} className="w-24" /></label>
              <label className="flex items-center gap-2">{t('graph.spacing', { defaultValue: '节点间距' })}<input type="range" min={0.6} max={2.2} step={0.05} value={spacing} onChange={(event) => setSpacing(Number(event.target.value))} className="w-24" /></label>
              {filters.hiddenNodeIds.size > 0 ? <div className="flex w-full flex-wrap items-center gap-2"><span className="text-muted-foreground">{t('graph.hiddenNodes', { defaultValue: '已隐藏节点' })}</span>{[...filters.hiddenNodeIds].map((id) => <Button key={id} size="sm" variant="outline" className="h-7 max-w-48 rounded-full text-xs" onClick={() => setFilters((current) => { const hiddenNodeIds = new Set(current.hiddenNodeIds); hiddenNodeIds.delete(id); return { ...current, hiddenNodeIds }; })}><span className="truncate">{index.byId.get(id)?.label ?? id}</span><X className="h-3 w-3" /><span className="sr-only">{t('graph.show', { defaultValue: '显示' })}</span></Button>)}</div> : null}
            </div>
          ) : null}

          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-2 text-xs [border-color:hsl(var(--shell-border))]" aria-label={t('graph.nodeTypes', { defaultValue: '节点类型' })}>
            {types.map(([type, count]) => {
              const appearance = graphNodeAppearance(type);
              return <label key={type} className={cn('flex cursor-pointer items-center gap-1.5', filters.hiddenTypes.has(type) && 'text-muted-foreground')}><input type="checkbox" checked={!filters.hiddenTypes.has(type)} onChange={(event) => setFilters((current) => { const hiddenTypes = new Set(current.hiddenTypes); if (event.target.checked) hiddenTypes.delete(type); else hiddenTypes.add(type); return { ...current, hiddenTypes }; })} /><span className={cn('inline-block h-2.5 w-2.5 shrink-0 bg-[var(--graph-color)] forced-colors:bg-[CanvasText]', appearance.color, appearance.shape === 'circle' ? 'rounded-full' : appearance.shape === 'diamond' ? 'rotate-45' : 'rounded-sm')} /><span>{t(`graph.types.${type}`, { defaultValue: type })}</span><span className="text-muted-foreground">{count}</span></label>;
            })}
          </div>

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <div className="relative flex min-h-[280px] min-w-0 flex-1">
              {showList ? (
                <section className="min-h-0 w-full overflow-auto p-5">
                  {visible.nodes.length > 0 ? <table className="w-full text-left text-xs"><thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">{t('graph.nodes')}</th><th className="pb-2 font-medium">{t('graph.nodeTypes', { defaultValue: '类型' })}</th><th className="pb-2 font-medium">{t('graph.connections', { defaultValue: '连接数' })}</th></tr></thead><tbody>{visible.nodes.map((node) => <tr key={node.id} className={cn('border-t border-border/70', (highlightedIds.has(node.id) || node.id === selectedId || node.relativePath === selectedPath) && 'bg-primary/5')}><td className="py-2 pr-3"><button type="button" className="text-left hover:underline" onClick={() => selectNode(node.id)}><span className="font-medium">{node.label}</span><span className="mt-1 block break-all text-muted-foreground">{node.relativePath}</span></button></td><td className="pr-3">{graphNodeType(node)}</td><td className="tabular-nums">{index.degree.get(node.id)}</td></tr>)}</tbody></table> : null}
                </section>
              ) : <GraphCanvas nodes={visible.nodes} edges={visible.edges} index={index} positions={positions} selectedId={selected && visible.ids.has(selected.id) ? selected.id : null} selectedPath={selectedPath} nodeScale={nodeScale} spacing={spacing} onSelect={selectNode} onOpenNode={onOpenNode} />}
              {visible.nodes.length === 0 ? <div className="absolute inset-0 flex items-center justify-center p-8"><WikiEmpty icon={Network} title={index.nodes.length === 0 ? t('graph.emptyNodes') : t('graph.noVisibleNodes', { defaultValue: '没有符合搜索或筛选条件的节点' })} /></div> : null}
            </div>

            {selected ? (
              <aside className="max-h-64 w-full shrink-0 overflow-auto border-t p-5 lg:max-h-none lg:w-72 lg:border-l lg:border-t-0 [border-color:hsl(var(--shell-border))]">
                <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="break-words text-sm font-medium">{selected.label}</div><div className="mt-1 break-all text-xs text-muted-foreground">{selected.relativePath}</div></div><Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" aria-label={t('graph.closeSelection', { defaultValue: '关闭节点详情' })} onClick={() => selectNode(null)}><X className="h-4 w-4" /></Button></div>
                <div className="my-3 flex flex-wrap items-center gap-2"><Badge variant={selected.relativePath === selectedPath ? 'default' : 'outline'}>{graphNodeType(selected)}</Badge><span className="text-xs text-muted-foreground">{t('graph.connectionCount', { defaultValue: '{{count}} 条连接', count: index.degree.get(selected.id) })}</span></div>
                <div className="flex flex-wrap gap-2"><WikiPrimaryButton size="sm" disabled={isBusy} onClick={() => onOpenNode(selected.relativePath)}>{t('graph.openPage', { defaultValue: '打开页面' })}</WikiPrimaryButton><Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => setFilters((current) => ({ ...current, hiddenNodeIds: new Set([...current.hiddenNodeIds, selected.id]) }))}><EyeOff className="h-4 w-4" />{t('graph.hideThisNode', { defaultValue: '隐藏节点' })}</Button></div>
                <label className="my-4 flex items-center gap-2 text-xs"><input type="checkbox" checked={focusNeighbors} disabled={highlightedIds.size > 0} onChange={(event) => setFocusNeighbors(event.target.checked)} />{t('graph.focusNeighbors', { defaultValue: '仅显示此节点及直接关联' })}</label>
                {!visible.ids.has(selected.id) ? <p className="mb-3 text-xs text-muted-foreground">{t('graph.selectedHidden', { defaultValue: '此节点已被当前筛选隐藏' })}</p> : null}
                <div className="mb-2 text-xs font-medium">{t('graph.relatedNodes', { defaultValue: '关联关系' })}</div>
                {relations.length === 0 ? <WikiEmpty title={t('graph.noRelatedNodes', { defaultValue: '当前可见图中没有关联关系' })} /> : <div className="space-y-2">{relations.map((edge, i) => {
                  const otherId = edge.source === selected.id ? edge.target : edge.source;
                  const other = index.byId.get(otherId)!;
                  return <button key={`${edge.source}:${edge.target}:${i}`} type="button" className="w-full rounded-2xl border border-border/70 bg-card px-3 py-2 text-left hover:bg-secondary/35" onClick={() => selectNode(other.id)}><div className="flex gap-2 text-xs"><span className="text-muted-foreground">{edge.source === selected.id ? '→' : '←'}</span><span className="min-w-0 flex-1 truncate font-medium">{other.label}</span></div><div className="mt-1 truncate text-xs text-muted-foreground">{edge.label}</div></button>;
                })}</div>}
              </aside>
            ) : null}
          </div>
        </>
      )}
    </WikiPanel>
  );
}

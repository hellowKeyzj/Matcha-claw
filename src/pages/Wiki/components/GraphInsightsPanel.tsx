import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { AlertTriangle, Lightbulb, Link2, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { hostWikiDismissGraphInsight, hostWikiGraphInsights } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import type { WikiGraphInsightsReceipt } from '@/types/wiki-capabilities';
import { WikiEmpty, WikiIconButton, WikiPanelHeader, WikiSurface } from './WikiChrome';

export type GraphInsightsPanelProps = Readonly<{
  projectId: string;
  busy: string | null;
  onLocateNodes(nodeIds: readonly string[]): void;
}>;

export function GraphInsightsPanel(props: GraphInsightsPanelProps): JSX.Element {
  return <ProjectInsights key={props.projectId} {...props} />;
}

function ProjectInsights({ projectId, busy, onLocateNodes }: GraphInsightsPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [receipt, setReceipt] = useState<WikiGraphInsightsReceipt | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);
  const disabled = busy !== null || pending !== null;
  const dismissed = new Set(receipt?.dismissedKeys ?? []);
  const connections = receipt?.surprisingConnections.filter((item) => !dismissed.has(item.key)) ?? [];
  const gaps = receipt?.knowledgeGaps.filter((item) => !dismissed.has(item.key)) ?? [];

  const applyReceipt = useCallback((next: WikiGraphInsightsReceipt) => {
    if (next.projectId !== projectId) throw new Error(t('graph.insightsProjectMismatch', { defaultValue: '洞察结果与当前知识库不匹配，请重新加载。' }));
    if (mounted.current) setReceipt(next);
  }, [projectId, t]);

  const run = useCallback(async (operation: string, task: () => Promise<void>) => {
    if (!mounted.current || running.current) return;
    running.current = true;
    setPending(operation);
    setError('');
    try {
      await task();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('graph.insightsFailed', { defaultValue: '洞察操作失败，请重试。' }));
    } finally {
      running.current = false;
      if (mounted.current) setPending(null);
    }
  }, [t]);

  const load = useCallback(() => run('load', async () => {
    applyReceipt(await hostWikiGraphInsights({ projectId }));
  }), [applyReceipt, projectId, run]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!selectedKey || !receipt) return;
    if (!receipt.dismissedKeys.includes(selectedKey) && [...receipt.surprisingConnections, ...receipt.knowledgeGaps].some((item) => item.key === selectedKey)) return;
    setSelectedKey(null);
    onLocateNodes([]);
  }, [onLocateNodes, receipt, selectedKey]);

  function locate(key: string, nodeIds: readonly string[]): void {
    const next = selectedKey === key ? null : key;
    setSelectedKey(next);
    onLocateNodes(next ? nodeIds : []);
  }

  async function dismiss(insightKey: string): Promise<void> {
    const next = await hostWikiDismissGraphInsight({ projectId, insightKey });
    applyReceipt(next);
    if (!next.dismissedKeys.includes(insightKey)) throw new Error(t('graph.insightsDismissUnconfirmed', { defaultValue: '后台尚未确认忽略此洞察，请刷新后重试。' }));
    if (mounted.current && selectedKey === insightKey) {
      setSelectedKey(null);
      onLocateNodes([]);
    }
  }

  const dismissLabel = t('graph.dismissInsight', { defaultValue: '忽略洞察' });
  const locateLabel = t('graph.locateInsight', { defaultValue: '定位关联节点' });
  return (
    <aside className="flex min-h-0 w-full shrink-0 flex-col border-t bg-[hsl(var(--shell-surface))] lg:w-80 lg:border-l lg:border-t-0 [border-color:hsl(var(--shell-border))]" aria-label={t('graph.insights', { defaultValue: '图谱洞察' })}>
      <WikiPanelHeader title={t('graph.insights', { defaultValue: '图谱洞察' })} icon={Lightbulb} actions={<WikiIconButton onClick={() => { void load(); }} disabled={disabled} title={t('graph.loadInsights', { defaultValue: '加载洞察' })} aria-label={t('graph.loadInsights', { defaultValue: '加载洞察' })}>{pending === 'load' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</WikiIconButton>} />
      <div className="max-h-96 min-h-0 flex-1 space-y-4 overflow-auto p-4 lg:max-h-none" aria-busy={pending !== null}>
        {error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p> : null}
        {!receipt ? <WikiEmpty title={pending === 'load' ? t('graph.insightsLoading', { defaultValue: '正在读取图谱洞察…' }) : t('graph.insightsNotLoaded', { defaultValue: '点击加载，读取当前知识库的图谱洞察。' })} icon={Lightbulb} /> : null}
        {receipt && connections.length === 0 && gaps.length === 0 ? <WikiEmpty title={t('graph.insightsEmpty', { defaultValue: '当前没有待处理的图谱洞察。' })} icon={Lightbulb} /> : null}
        {connections.length > 0 ? <section className="space-y-2"><h3 className="flex items-center gap-2 text-xs font-semibold"><Link2 className="h-4 w-4" />{t('graph.surprisingConnections', { defaultValue: '跨域连接' })}</h3>{connections.map((connection) => (
          <WikiSurface key={connection.key} className={cn('p-3', selectedKey === connection.key && 'ring-1 ring-primary')}>
            <div className="flex items-start gap-2"><button type="button" className="min-w-0 flex-1 break-words text-left text-xs font-medium hover:underline" disabled={disabled} aria-pressed={selectedKey === connection.key} aria-label={`${locateLabel}：${connection.sourceId} ↔ ${connection.targetId}`} onClick={() => locate(connection.key, [connection.sourceId, connection.targetId])}>{connection.sourceId} ↔ {connection.targetId}</button><WikiIconButton className="h-6 w-6 shrink-0" disabled={disabled} aria-label={dismissLabel} title={dismissLabel} onClick={() => { void run('dismiss', () => dismiss(connection.key)); }}><X className="h-3.5 w-3.5" /></WikiIconButton></div>
            <p className="mt-2 break-words text-xs text-muted-foreground">{connection.reasons.join(' · ')}</p>
            <p className="mt-2 text-xs text-muted-foreground">{t('graph.insightScore', { score: connection.score, defaultValue: '连接得分：{{score}}' })}</p>
          </WikiSurface>
        ))}</section> : null}
        {gaps.length > 0 ? <section className="space-y-2"><h3 className="flex items-center gap-2 text-xs font-semibold"><AlertTriangle className="h-4 w-4" />{t('graph.knowledgeGaps', { defaultValue: '知识缺口' })}</h3>{gaps.map((gap) => (
          <WikiSurface key={gap.key} className={cn('p-3', selectedKey === gap.key && 'ring-1 ring-primary')}>
            <div className="flex items-start gap-2"><button type="button" className="min-w-0 flex-1 break-words text-left text-xs font-medium hover:underline" disabled={disabled || gap.nodeIds.length === 0} aria-pressed={selectedKey === gap.key} aria-label={`${locateLabel}：${gap.title}`} onClick={() => locate(gap.key, gap.nodeIds)}>{gap.title}</button><WikiIconButton className="h-6 w-6 shrink-0" disabled={disabled} aria-label={dismissLabel} title={dismissLabel} onClick={() => { void run('dismiss', () => dismiss(gap.key)); }}><X className="h-3.5 w-3.5" /></WikiIconButton></div>
            <Badge variant="outline" className="mt-2">{t(`graph.gapTypes.${gap.type}`, { defaultValue: gap.type === 'isolated-node' ? '孤立页面' : gap.type === 'sparse-community' ? '稀疏社区' : '关键桥接' })}</Badge>
            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{gap.description}</p>
            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{gap.suggestion}</p>
            <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" className="h-7 rounded-full text-xs" disabled={disabled || gap.nodeIds.length === 0} onClick={() => locate(gap.key, gap.nodeIds)}>{locateLabel}</Button></div>
          </WikiSurface>
        ))}</section> : null}
      </div>
    </aside>
  );
}

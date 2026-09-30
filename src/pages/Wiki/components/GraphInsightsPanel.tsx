import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Lightbulb, Link2, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { waitForCall } from '@/lib/call-log-await';
import {
  hostWikiCallResult,
  hostWikiDismissGraphInsight,
  hostWikiGraphInsights,
  hostWikiPrepareInsightResearch,
  type HostWikiResearchInput,
} from '@/lib/host-api';
import { cn } from '@/lib/utils';
import type { WikiGraphInsightsReceipt } from '@/types/wiki-capabilities';
import { WikiEmpty, WikiIconButton, WikiPanelHeader, WikiPrimaryButton, WikiSurface } from './WikiChrome';

export type GraphInsightsPanelProps = Readonly<{
  projectId: string;
  modelRef: string;
  busy: string | null;
  onLocateNodes(nodeIds: readonly string[]): void;
  onResearch(input: HostWikiResearchInput): Promise<void>;
}>;

type ResearchDraft = { insightKey: string; topic: string; searchQueries: string[] };
const RESEARCH_INPUT_OPERATION = 'graph.insights.research-input';

export function GraphInsightsPanel(props: GraphInsightsPanelProps): JSX.Element {
  return <ProjectInsights key={props.projectId} {...props} />;
}

function ProjectInsights({ projectId, modelRef, busy, onLocateNodes, onResearch }: GraphInsightsPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [receipt, setReceipt] = useState<WikiGraphInsightsReceipt | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ResearchDraft | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);
  const prepareController = useRef<AbortController | null>(null);
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
      prepareController.current?.abort();
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

  function closeDraft(): void {
    if (pending === 'research') return;
    prepareController.current?.abort();
    setDraft(null);
  }

  function prepare(insightKey: string): void {
    if (disabled) return;
    void run('prepare', async () => {
      const selectedModel = modelRef.trim();
      if (!selectedModel) throw new Error(t('research.modelRequired', { defaultValue: '请先在来源设置中选择生成模型，再开始研究。' }));
      const controller = new AbortController();
      prepareController.current = controller;
      setDraft({ insightKey, topic: '', searchQueries: [] });
      try {
        const accepted = await hostWikiPrepareInsightResearch({ projectId, insightKey, modelRef: selectedModel });
        const call = await waitForCall(accepted, 'wiki', { signal: controller.signal });
        if (call.command !== RESEARCH_INPUT_OPERATION || call.detail.operation !== RESEARCH_INPUT_OPERATION
          || call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
          throw new Error(t('graph.insightsResearchUnconfirmed', { defaultValue: '后台未成功生成研究主题，请重试。' }));
        }
        const result = await hostWikiCallResult({ callId: call.callId });
        if (result.callId !== call.callId || result.operation !== RESEARCH_INPUT_OPERATION
          || result.result.projectId !== projectId || result.result.insightKey !== insightKey) {
          throw new Error(t('graph.insightsResearchUnconfirmed', { defaultValue: '后台未成功生成研究主题，请重试。' }));
        }
        if (mounted.current && !controller.signal.aborted) {
          setDraft({ insightKey, topic: result.result.topic, searchQueries: [...result.result.searchQueries] });
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (mounted.current) setDraft(null);
        throw cause;
      } finally {
        if (prepareController.current === controller) prepareController.current = null;
      }
    });
  }

  function confirmResearch(event: FormEvent): void {
    event.preventDefault();
    if (!draft || disabled || !draft.topic.trim()) return;
    const confirmed = draft;
    void run('research', async () => {
      await onResearch({ topic: confirmed.topic.trim(), searchQueries: confirmed.searchQueries.map((query) => query.trim()).filter(Boolean) });
      if (mounted.current) setDraft(null);
      try {
        // Admission is durable; finish this project's dismissal even if the research tab unmounts the panel.
        await dismiss(confirmed.insightKey);
      } catch (cause) {
        const message = t('graph.insightsResearchDismissFailed', { defaultValue: '研究已提交，但未能忽略原洞察；请刷新后单独忽略，勿重复提交研究。' });
        toast.error(message);
        throw new Error(`${message}\n${cause instanceof Error ? cause.message : ''}`, { cause });
      }
    });
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
            <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" className="h-7 rounded-full text-xs" disabled={disabled || gap.nodeIds.length === 0} onClick={() => locate(gap.key, gap.nodeIds)}>{locateLabel}</Button><WikiPrimaryButton size="sm" className="h-7 px-3 text-xs" disabled={disabled} onClick={() => prepare(gap.key)}><Search className="h-3.5 w-3.5" />{t('graph.deepResearch', { defaultValue: '深度研究' })}</WikiPrimaryButton></div>
          </WikiSurface>
        ))}</section> : null}
      </div>
      <Dialog.Root open={draft !== null} onOpenChange={(open) => { if (!open) closeDraft(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content onEscapeKeyDown={(event) => { if (pending === 'research') event.preventDefault(); }} onPointerDownOutside={(event) => { if (pending === 'research') event.preventDefault(); }} className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-border bg-background p-5 shadow-xl">
            <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><Dialog.Title className="text-sm font-semibold">{t('graph.deepResearch', { defaultValue: '深度研究' })}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">{t('graph.researchConfirmDescription', { defaultValue: '确认研究主题和搜索词，提交后由后台继续执行。' })}</Dialog.Description></div><Dialog.Close asChild><WikiIconButton disabled={pending === 'research'} aria-label={t('graph.cancel', { defaultValue: '取消' })}><X className="h-4 w-4" /></WikiIconButton></Dialog.Close></div>
            {pending === 'prepare' ? <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('graph.generatingTopic', { defaultValue: '正在生成研究主题…' })}</p> : draft ? <form className="mt-4 space-y-4" onSubmit={confirmResearch}>
              {error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p> : null}
              <label className="block space-y-2 text-xs font-medium"><span>{t('graph.researchTopic', { defaultValue: '研究主题' })}</span><Input autoFocus value={draft.topic} disabled={disabled} onChange={(event) => setDraft((current) => current ? { ...current, topic: event.target.value } : current)} /></label>
              <fieldset disabled={disabled} className="space-y-2"><legend className="mb-2 text-xs font-medium">{t('graph.searchQueries', { defaultValue: '搜索词' })}</legend>{draft.searchQueries.map((query, index) => <Input key={index} value={query} aria-label={t('graph.searchQueryLabel', { index: index + 1, defaultValue: '搜索词 {{index}}' })} onChange={(event) => setDraft((current) => current ? { ...current, searchQueries: current.searchQueries.map((value, queryIndex) => queryIndex === index ? event.target.value : value) } : current)} />)}</fieldset>
              <div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={pending === 'research'} onClick={closeDraft}>{t('graph.cancel', { defaultValue: '取消' })}</Button><WikiPrimaryButton type="submit" disabled={disabled || !draft.topic.trim()}>{pending === 'research' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}{t('graph.startResearch', { defaultValue: '开始研究' })}</WikiPrimaryButton></div>
            </form> : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
}

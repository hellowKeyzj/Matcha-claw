import { useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BrainCircuit, CheckCircle2, ListChecks, Loader2, RefreshCw, Settings2, Trash2, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Textarea } from '@/components/ui/textarea';
import { waitForCall } from '@/lib/call-log-await';
import {
  hostWikiCallResult,
  hostWikiCancelLint,
  hostWikiDeleteLint,
  hostWikiDismissLint,
  hostWikiFixLint,
  hostWikiLintConfig,
  hostWikiLintState,
  hostWikiReviewLint,
  hostWikiRunLint,
  hostWikiUpdateLintConfig,
} from '@/lib/host-api';
import { fetchSelectableProviderModels } from '@/lib/provider-models';
import type { ModelCatalogEntry } from '@/types/subagent';
import type { WikiLintConfig, WikiLintFinding, WikiLintFixReceipt, WikiLintState } from '@/types/wiki-capabilities';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader, WikiSurface } from './WikiChrome';

export type LintPanelProps = Readonly<{
  projectId: string;
  busy: string | null;
  initialModelRef?: string;
  onOpenFile(path: string): void;
  onFilesChanged(projectId: string, writtenPages: string[], deletedPages: string[]): Promise<void>;
}>;

type FixOperation = 'lint.fix' | 'lint.review' | 'lint.delete';

function isRunning(state: WikiLintState | null): boolean {
  return state !== null && ['reading', 'structural', 'semantic'].includes(state.phase);
}

export function LintPanel(props: LintPanelProps): JSX.Element {
  return <LintBody key={props.projectId} {...props} />;
}

function LintBody({ projectId, busy, initialModelRef, onOpenFile, onFilesChanged }: LintPanelProps): JSX.Element {
  const { t, i18n } = useTranslation('wiki');
  const [state, setState] = useState<WikiLintState | null>(null);
  const [config, setConfig] = useState<WikiLintConfig | null>(null);
  const [ignoredPages, setIgnoredPages] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [modelRef, setModelRef] = useState(initialModelRef?.trim() ?? '');
  const [submittedModel, setSubmittedModel] = useState<{ taskId: string; modelRef: string } | null>(null);
  const [models, setModels] = useState<readonly ModelCatalogEntry[]>([]);
  const [modelError, setModelError] = useState('');
  const [pending, setPending] = useState<string | null>('load');
  const [cancelling, setCancelling] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [deleteItem, setDeleteItem] = useState<WikiLintFinding | null>(null);
  const [fixReceipt, setFixReceipt] = useState<WikiLintFixReceipt | null>(null);
  const [error, setError] = useState('');
  const [pollPaused, setPollPaused] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const observing = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const running = isRunning(state);
  const disabled = busy !== null || pending !== null || running;
  const items = state?.items ?? [];
  const selected = items.filter((item) => selectedIds.has(item.id));
  const allSelected = items.length > 0 && selected.length === items.length;
  const selectedModel = models.find((model) => model.modelReferences?.includes(modelRef));
  const text = (key: string, defaultValue: string) => t(`lint.${key}`, { defaultValue });
  const unconfirmed = () => new Error(text('unconfirmed', '无法确认检查或修复结果，请刷新查看；不要重复提交。'));

  async function readState(signal: AbortSignal): Promise<WikiLintState | null> {
    const next = await hostWikiLintState({ projectId });
    if (signal.aborted) return null;
    if (next.projectId !== projectId) throw unconfirmed();
    setState(next);
    setSelectedIds((current) => new Set(next.items.filter((item) => current.has(item.id)).map((item) => item.id)));
    return next;
  }

  useEffect(() => {
    const controller = new AbortController();
    observing.current = controller;
    void Promise.all([
      hostWikiLintConfig({ projectId }).then((next) => {
        if (controller.signal.aborted) return;
        setConfig(next);
        setIgnoredPages(next.ignorePages.join('\n'));
      }),
      readState(controller.signal),
    ]).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setPending(null); });
    void fetchSelectableProviderModels('chat').then((next) => {
      if (!controller.signal.aborted) setModels(next);
    }).catch((cause) => {
      if (!controller.signal.aborted) setModelError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { controller.abort(); };
    // Project changes remount this body; its observers never cross projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!running || !state?.taskId) return;
    let cancelled = false;
    let failures = 0;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const signal = observing.current!.signal;
    const poll = async () => {
      try {
        const next = await hostWikiLintState({ projectId });
        if (cancelled || signal.aborted) return;
        if (next.projectId !== projectId) throw unconfirmed();
        setState(next);
        failures = 0;
        if (!isRunning(next)) return;
      } catch {
        if (cancelled || signal.aborted) return;
        failures++;
      }
      if (++attempts >= 600 || failures >= 3) {
        setPollPaused(true);
        return;
      }
      timer = setTimeout(() => { void poll(); }, 1000);
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
    // Only task identity and active/terminal transitions restart the poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, running, state?.taskId, pollVersion]);

  async function act(label: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = observing.current?.signal;
    if (locked.current || !signal || signal.aborted || busy !== null) return;
    locked.current = true;
    setPending(label);
    setError('');
    try {
      await task(signal);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      if (!signal.aborted) setPending(null);
    }
  }

  function draftConfig(): WikiLintConfig {
    return { ...config!, ignorePages: ignoredPages.split(/[,，\n]/).map((page) => page.trim()).filter(Boolean) };
  }

  async function refresh(): Promise<void> {
    await act('refresh', async (signal) => {
      await readState(signal);
      if (!config && !signal.aborted) {
        const next = await hostWikiLintConfig({ projectId });
        if (signal.aborted) return;
        setConfig(next);
        setIgnoredPages(next.ignorePages.join('\n'));
      }
      if ((!models.length || modelError) && !signal.aborted) {
        try {
          const next = await fetchSelectableProviderModels('chat');
          if (signal.aborted) return;
          setModels(next);
          setModelError('');
        } catch (cause) {
          if (!signal.aborted) setModelError(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (!signal.aborted) {
        setPollPaused(false);
        setPollVersion((version) => version + 1);
      }
    });
  }

  async function runLint(): Promise<void> {
    if (disabled || !config || (semantic && !selectedModel)) return;
    await act('run', async (signal) => {
      const receipt = await hostWikiRunLint({ projectId, semantic, modelRef: semantic ? modelRef : undefined, outputLanguage: i18n.language, config: draftConfig() });
      if (signal.aborted) return;
      setSubmittedModel(semantic ? { taskId: receipt.callId, modelRef } : null);
      setFixReceipt(null);
      setSelectedIds(new Set());
      setPollPaused(false);
      const next = await readState(signal);
      if (!next || signal.aborted) return;
      if (next.taskId !== receipt.callId) throw unconfirmed();
      const call = await waitForCall(receipt, 'wiki', { signal });
      if (signal.aborted) return;
      const finished = await readState(signal);
      if (call.command !== 'lint.run' || call.detail.operation !== 'lint.run' || call.status === 'unknown') throw unconfirmed();
      if (finished?.phase === 'cancelled' && call.detail.outcome === 'cancelled') return;
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') throw new Error(finished?.error || text('runFailed', '检查未完成，请查看错误后重试。'));
    });
  }

  async function cancel(): Promise<void> {
    const signal = observing.current?.signal;
    if (!running || !state?.taskId || cancelling || !signal || signal.aborted) return;
    setCancelling(true);
    try {
      const next = await hostWikiCancelLint({ projectId, taskId: state.taskId });
      if (signal.aborted) return;
      if (next.projectId !== projectId) throw unconfirmed();
      setState(next);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal.aborted) setCancelling(false);
    }
  }

  async function fix(operation: FixOperation, ids: string[]): Promise<void> {
    if (disabled || ids.length === 0) return;
    await act(operation, async (signal) => {
      setFixReceipt(null);
      setDeleteItem(null);
      const receipt = await (operation === 'lint.fix' ? hostWikiFixLint : operation === 'lint.review' ? hostWikiReviewLint : hostWikiDeleteLint)({ projectId, ids });
      if (signal.aborted) return;
      const call = await waitForCall(receipt, 'wiki', { signal });
      if (signal.aborted) return;
      if (call.command !== operation || call.detail.operation !== operation || call.status === 'unknown') throw unconfirmed();
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') throw new Error(text('fixFailed', '修复未完成，请刷新检查结果。'));
      const result = await hostWikiCallResult({ callId: call.callId });
      if (signal.aborted) return;
      if (result.callId !== call.callId || result.operation !== operation || result.result.projectId !== projectId) throw unconfirmed();
      setFixReceipt(result.result);
      // Partial receipts can contain successful writes as well as failures.
      try {
        if (result.result.writtenPages.length || result.result.deletedPages.length || result.result.reviewedIds.length) {
          await onFilesChanged(projectId, result.result.writtenPages, result.result.deletedPages);
        }
      } finally {
        if (!signal.aborted) await readState(signal);
      }
    });
  }

  async function dismiss(ids: string[]): Promise<void> {
    if (disabled || !ids.length) return;
    await act('dismiss', async (signal) => {
      const next = await hostWikiDismissLint({ projectId, ids });
      if (signal.aborted) return;
      if (next.projectId !== projectId) throw unconfirmed();
      setState(next);
      setSelectedIds(new Set());
    });
  }

  function toggleSelected(id: string, checked: boolean): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  const phaseLabels: Record<WikiLintState['phase'], string> = {
    idle: text('phases.idle', '尚未检查'),
    reading: text('phases.reading', '读取知识页面'),
    structural: text('phases.structural', '结构检查'),
    semantic: text('phases.semantic', '语义检查'),
    done: text('phases.done', '检查完成'),
    cancelled: text('phases.cancelled', '检查已取消'),
    error: text('phases.error', '检查失败'),
  };
  const typeLabels: Record<WikiLintFinding['type'], string> = {
    orphan: text('types.orphan', '孤立页面'),
    'broken-link': text('types.broken-link', '失效链接'),
    'no-outlinks': text('types.no-outlinks', '没有出链'),
    semantic: text('types.semantic', '语义问题'),
  };

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={text('title', '知识库检查')}
        subtitle={text('subtitle', '检查页面结构与语义，逐项修复或送入审核')}
        icon={ListChecks}
        actions={(
          <>
            <WikiIconButton title={text('ruleSettings', '检查规则')} aria-label={text('ruleSettings', '检查规则')} onClick={() => setShowRules((value) => !value)}><Settings2 className="h-4 w-4" /></WikiIconButton>
            <WikiIconButton title={text('refresh', '刷新检查结果')} aria-label={text('refresh', '刷新检查结果')} disabled={busy !== null || pending !== null} onClick={() => { void refresh(); }}><RefreshCw className="h-4 w-4" /></WikiIconButton>
          </>
        )}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        <WikiSurface className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">{text('structural', '结构检查')}</span>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={semantic} disabled={disabled} onChange={(event) => setSemantic(event.target.checked)} />{text('semantic', '同时检查语义')}</label>
            {semantic ? (
              <select aria-label={text('model', '语义检查模型')} value={modelRef} disabled={disabled} onChange={(event) => setModelRef(event.target.value)} className="h-8 min-w-0 max-w-full rounded-lg border border-input bg-background px-2 text-sm">
                <option value="">{text('selectModel', '选择语义检查模型')}</option>
                {modelRef && !selectedModel ? <option value={modelRef}>{text('invalidModel', '当前模型不可用')}</option> : null}
                {models.filter((model) => model.modelReferences?.length).map((model) => <option key={model.id} value={model.modelReferences!.includes(modelRef) ? modelRef : model.modelReferences![0]}>{model.displayLabel}</option>)}
              </select>
            ) : null}
            <Button type="button" size="sm" className="ml-auto h-8 rounded-full" disabled={disabled || !config || (semantic && !selectedModel)} onClick={() => { void runLint(); }}><ListChecks className="h-4 w-4" />{text('run', '开始检查')}</Button>
            {running ? <Button type="button" size="sm" variant="outline" className="h-8 rounded-full" disabled={cancelling} onClick={() => { void cancel(); }}>{cancelling ? text('cancelling', '正在取消…') : text('cancel', '取消检查')}</Button> : null}
          </div>
          <p className="text-xs text-muted-foreground">{text('description', '结构检查不调用模型；语义检查将知识页面摘要发送给所选模型。检查结果由知识库后端提供。')}</p>
          {semantic && (!selectedModel || modelError) ? <p className="text-xs text-destructive">{modelError || text('modelRequired', '请选择可用模型后再运行语义检查。')}</p> : null}
          {state ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <Badge variant={state.phase === 'error' ? 'destructive' : state.phase === 'done' ? 'success' : 'secondary'}>{phaseLabels[state.phase]}</Badge>
              <span>{t('lint.progress', { defaultValue: '已处理 {{completed}} / {{total}}', completed: state.completed, total: state.total })}</span>
              {submittedModel?.taskId === state.taskId ? <span className="break-all">{t('lint.submittedModel', { defaultValue: '本次提交模型：{{modelRef}}', modelRef: submittedModel.modelRef })}</span> : null}
            </div>
          ) : null}
          {pollPaused ? <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">{text('progressPaused', '自动进度刷新已暂停，后台任务不受影响。')}<Button type="button" size="sm" variant="outline" onClick={() => { setPollPaused(false); setPollVersion((version) => version + 1); }}>{text('resumeProgress', '继续查看进度')}</Button></div> : null}
        </WikiSurface>

        {showRules && config ? (
          <WikiSurface className="space-y-3 p-4">
            <h3 className="text-sm font-medium">{text('ruleSettings', '检查规则')}</h3>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.ignoreOrphan} disabled={disabled} onChange={(event) => setConfig({ ...config, ignoreOrphan: event.target.checked })} />{text('ignoreOrphan', '忽略孤立页面')}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.ignoreNoOutlinks} disabled={disabled} onChange={(event) => setConfig({ ...config, ignoreNoOutlinks: event.target.checked })} />{text('ignoreNoOutlinks', '忽略没有出链的页面')}</label>
            <label className="block space-y-2 text-sm"><span>{text('ignorePages', '忽略页面（每行一个，或以逗号分隔）')}</span><Textarea value={ignoredPages} disabled={disabled} onChange={(event) => setIgnoredPages(event.target.value)} className="min-h-20 font-mono text-xs" /></label>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void act('config', async (signal) => {
              const saved = await hostWikiUpdateLintConfig({ projectId, ...draftConfig() });
              if (signal.aborted) return;
              setConfig(saved);
              setIgnoredPages(saved.ignorePages.join('\n'));
              setShowRules(false);
            }); }}>{text('saveRules', '保存规则')}</Button>
          </WikiSurface>
        ) : null}

        {error || state?.error ? <div role="alert" className="whitespace-pre-wrap break-words rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error || state?.error}</div> : null}
        {fixReceipt ? (
          <WikiSurface className="space-y-2 p-3 text-sm">
            <p role="status">{t('lint.fixSummary', { defaultValue: '已修复 {{fixed}} 项 · 已送审核 {{reviewed}} 项 · 失败 {{failed}} 项', fixed: fixReceipt.fixedIds.length, reviewed: fixReceipt.reviewedIds.length, failed: fixReceipt.failures.length })}</p>
            {fixReceipt.failures.map((failure) => <p key={failure.id} role="alert" className="break-words text-xs text-destructive">{items.find((item) => item.id === failure.id)?.page || failure.id}：{failure.message}</p>)}
          </WikiSurface>
        ) : null}

        {items.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allSelected} disabled={disabled} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)))} />{text('selectAll', '全选')}</label>
              <span className="text-xs text-muted-foreground">{t('lint.selectedCount', { defaultValue: '已选 {{count}} 项', count: selected.length })}</span>
              <Button type="button" size="sm" variant="outline" disabled={disabled || !selected.length} onClick={() => { void fix('lint.fix', selected.map((item) => item.id)); }}>{text('fixSelected', '修复所选')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={disabled || !selected.length} onClick={() => { void fix('lint.review', selected.map((item) => item.id)); }}>{text('reviewSelected', '送入审核')}</Button>
              <Button type="button" size="sm" variant="ghost" disabled={disabled || !selected.length} onClick={() => { void dismiss(selected.map((item) => item.id)); }}>{text('ignoreSelected', '忽略所选')}</Button>
            </div>
            {(['warning', 'info'] as const).map((severity) => {
              const findings = items.filter((item) => item.severity === severity);
              return findings.length ? (
                <section key={severity} className="space-y-3">
                  <h3 className="text-xs font-semibold text-muted-foreground">{severity === 'warning' ? text('warnings', '警告') : text('info', '提示')} · {findings.length}</h3>
                  {findings.map((item) => (
                    <WikiSurface key={item.id} className="p-4">
                      <div className="flex items-start gap-3">
                        <input type="checkbox" className="mt-1" checked={selectedIds.has(item.id)} disabled={disabled} aria-label={t('lint.selectItem', { defaultValue: '选择 {{page}}', page: item.page })} onChange={(event) => toggleSelected(item.id, event.target.checked)} />
                        {item.type === 'semantic' ? <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                        <div className="min-w-0 flex-1">
                          <h4 className="break-words text-sm font-semibold">{item.page}</h4>
                          <Badge variant="outline" className="mt-1">{typeLabels[item.type]}</Badge>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.detail}</p>
                          {item.brokenTarget ? <p className="mt-2 break-words text-xs text-muted-foreground">{t('lint.brokenTarget', { defaultValue: '失效目标：{{page}}', page: item.brokenTarget })}</p> : null}
                          {item.suggestedSource ? <p className="mt-2 break-words text-xs text-muted-foreground">{t('lint.suggestedSource', { defaultValue: '建议链接来源：{{page}}', page: item.suggestedSource })}</p> : null}
                          {item.suggestedTarget ? <p className="mt-2 break-words text-xs text-muted-foreground">{t('lint.suggestedTarget', { defaultValue: '建议链接目标：{{page}}', page: item.suggestedTarget })}</p> : null}
                          <div className="mt-3 flex flex-wrap gap-2">
                            {item.affectedPages.map((page) => <Button key={page} type="button" size="sm" variant="ghost" disabled={disabled} className="h-auto max-w-full break-all whitespace-normal text-left text-xs" onClick={() => onOpenFile(page)}>{page}</Button>)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        {item.type !== 'semantic' ? <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onOpenFile(item.page)}>{text('open', '打开页面')}</Button> : null}
                        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void fix('lint.fix', [item.id]); }}><Wrench className="h-4 w-4" />{text('fix', '修复')}</Button>
                        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { void fix('lint.review', [item.id]); }}>{text('review', '送入审核')}</Button>
                        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { void dismiss([item.id]); }}>{text('ignore', '忽略此项')}</Button>
                        {item.type === 'orphan' ? <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={disabled} onClick={() => setDeleteItem(item)}><Trash2 className="h-4 w-4" />{text('delete', '删除孤立页面')}</Button> : null}
                      </div>
                    </WikiSurface>
                  ))}
                </section>
              ) : null;
            })}
          </>
        ) : <WikiEmpty icon={state?.phase === 'done' ? CheckCircle2 : ListChecks} title={state?.phase === 'done' && !state.error ? text('allClear', '检查完成，当前没有待处理问题。') : running ? text('running', '正在检查，请等待后端结果。') : text('runHint', '运行检查，查看失效链接、孤立页面和语义问题。')} />}
      </div>
      <ConfirmDialog open={deleteItem !== null} title={text('deleteTitle', '删除孤立页面？')} message={t('lint.deleteConfirm', { defaultValue: '将删除 {{page}}，并清理索引、向量和其他页面中的引用；此操作无法撤销。确认删除？', page: deleteItem?.page })} variant="destructive" confirmLabel={text('confirmDelete', '确认删除')} cancelLabel={text('keepPage', '保留页面')} onCancel={() => setDeleteItem(null)} onConfirm={() => deleteItem ? fix('lint.delete', [deleteItem.id]) : undefined} />
    </WikiPanel>
  );
}

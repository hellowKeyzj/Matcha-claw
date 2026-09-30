import { useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FileText, Loader2, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { MarkdownPreview } from '@/components/file-preview/MarkdownPreview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { HostWikiResearchInput } from '@/lib/host-api';
import { hasActiveResearchRerun, isTerminalResearchTask, type WikiResearchTask } from '../research-model';
import { formatDateTime } from '../wiki-model';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader, WikiPrimaryButton, WikiSurface } from './WikiChrome';

export type ResearchPanelProps = Readonly<{
  tasks: readonly WikiResearchTask[];
  busy: string | null;
  onStart(input: HostWikiResearchInput): void;
  onRerun(task: WikiResearchTask): void;
  onRemove(taskId: string): void;
  onOpenFile(path: string): void;
  onRefresh(): void;
}>;

const STATUS_LABELS: Record<WikiResearchTask['status'], string> = {
  queued: '排队中', searching: '搜索中', synthesizing: '综合研究中', saving: '保存中', done: '已完成', error: '失败',
};

export function ResearchPanel({ tasks, busy, onStart, onRerun, onRemove, onOpenFile, onRefresh }: ResearchPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [topic, setTopic] = useState('');
  const isBusy = busy !== null;
  const activeCount = tasks.filter((task) => !isTerminalResearchTask(task)).length;

  function start(event: FormEvent): void {
    event.preventDefault();
    if (!topic.trim() || isBusy) return;
    onStart({ topic: topic.trim() });
    setTopic('');
  }

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('research.title', { defaultValue: '深度研究' })}
        subtitle={t('research.active', { count: activeCount, defaultValue: '{{count}} 项研究进行中' })}
        icon={Search}
        actions={<WikiIconButton onClick={onRefresh} disabled={isBusy} title={t('common.refresh')}><RefreshCw className="h-4 w-4" /></WikiIconButton>}
      />
      <form onSubmit={start} className="flex shrink-0 gap-2 border-b px-5 py-3 [border-color:hsl(var(--shell-border))]">
        <Input value={topic} onChange={(event) => setTopic(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} placeholder={t('research.inputPlaceholder', { defaultValue: '输入研究主题' })} aria-label={t('research.topic', { defaultValue: '研究主题' })} />
        <WikiPrimaryButton type="submit" disabled={isBusy || !topic.trim()}><Search className="h-4 w-4" />{t('research.start', { defaultValue: '开始研究' })}</WikiPrimaryButton>
      </form>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tasks.length === 0 ? <WikiEmpty title={t('research.emptyTitle', { defaultValue: '暂无研究任务，输入主题开始研究' })} icon={Search} /> : (
          <div className="space-y-3">
            {tasks.map((task) => {
              const terminal = isTerminalResearchTask(task);
              const rerunPending = hasActiveResearchRerun(tasks, task.id);
              return (
                <WikiSurface key={task.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {!terminal ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : task.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
                    <h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{task.topic}</h3>
                    <Badge variant={task.status === 'error' ? 'destructive' : terminal ? 'success' : 'warning'}>{t(`research.status.${task.status}`, { defaultValue: STATUS_LABELS[task.status] })}</Badge>
                    <span className="text-xs text-muted-foreground">{formatDateTime(task.createdAt, '')}</span>
                  </div>
                  {task.rerunOfTaskId ? <p className="mt-2 text-xs text-muted-foreground">{t('research.rerunTask', { defaultValue: '重新研究（保留原任务）' })}</p> : null}
                  {task.searchQueries.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">{task.searchQueries.join(' · ')}</p> : null}
                  {task.error ? <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-destructive">{task.error}</p> : null}
                  {task.webResults.length > 0 ? (
                    <details className="mt-3 rounded-xl border p-3">
                      <summary className="cursor-pointer text-xs font-medium">{t('research.sourcesCount', { count: task.webResults.length, defaultValue: '{{count}} 个研究来源' })}</summary>
                      <div className="mt-2 space-y-2">
                        {task.webResults.map((source, index) => <div key={`${source.url}:${index}`} className="text-xs"><div className="font-medium">{source.title}</div><div className="break-all text-muted-foreground">{source.source} · {source.url}</div><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{source.snippet}</p></div>)}
                      </div>
                    </details>
                  ) : null}
                  {task.synthesis ? <div className="mt-3 max-h-96 overflow-auto rounded-xl border" aria-live={task.status === 'synthesizing' ? 'polite' : 'off'}><MarkdownPreview filePath={task.savedPath ?? task.id} markdown={task.synthesis} />{task.status === 'synthesizing' ? <p className="px-4 pb-3 text-xs text-muted-foreground">{t('research.streaming', { defaultValue: '研究内容持续更新中…' })}</p> : null}</div> : null}
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {task.savedPath ? <Button size="sm" variant="outline" onClick={() => { if (task.savedPath) onOpenFile(task.savedPath); }} disabled={isBusy}><FileText className="h-4 w-4" />{t('research.open', { defaultValue: '打开已保存页面' })}</Button> : null}
                    {terminal ? <><Button size="sm" variant="outline" onClick={() => onRerun(task)} disabled={isBusy || rerunPending}><RotateCcw className="h-4 w-4" />{t(task.status === 'error' ? 'research.retry' : 'research.rerun', { defaultValue: task.status === 'error' ? '重试' : '重新研究' })}</Button><Button size="sm" variant="ghost" onClick={() => onRemove(task.id)} disabled={isBusy}><Trash2 className="h-4 w-4" />{t('research.remove', { defaultValue: '移除任务' })}</Button></> : null}
                  </div>
                </WikiSurface>
              );
            })}
          </div>
        )}
      </div>
    </WikiPanel>
  );
}

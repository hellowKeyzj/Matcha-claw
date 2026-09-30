import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { BookmarkPlus, Check, Copy, FileText, Loader2, RotateCcw } from 'lucide-react';
import { MarkdownPreview } from '@/components/file-preview/MarkdownPreview';
import { Button } from '@/components/ui/button';
import type { WikiQuestionTask } from '@/types/wiki-capabilities';
import { resolveWikiMarkdownImage } from '../wiki-media';
import { WikiSurface } from './WikiChrome';

type QuestionTask = WikiQuestionTask;

export type QuestionTurn = Readonly<{
  id: string;
  question: string;
  task: QuestionTask | null;
  error: string | null;
  savedPath?: string;
  localWaitEnded?: boolean;
}>;

function visibleAnswer(answer: string): string {
  return answer.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/gi, '').trim();
}

function referenceMarkdown(answer: string, references: QuestionTask['references']): string {
  return answer.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[(\d+)\](?!\()/g, (match, path: string | undefined, label: string | undefined, number: string | undefined) => {
    const index = number ? Number(number) - 1 : references.findIndex((reference) => {
      const target = reference.path.replace(/^wiki\//, '').replace(/\.md$/, '');
      return path === reference.path || path === target;
    });
    if (index < 0 || index >= references.length) return match;
    return `[${label ?? path ?? number}](#wiki-qa-reference-${index})`;
  });
}

export function QuestionMessage({ turn, disabled, saving, canSave, canRegenerate, onSave, onRegenerate, onOpenFile }: Readonly<{
  turn: QuestionTurn;
  disabled: boolean;
  saving: boolean;
  canSave: boolean;
  canRegenerate: boolean;
  onSave(): void;
  onRegenerate(): void;
  onOpenFile(path: string): void;
}>): JSX.Element {
  const { t } = useTranslation('wiki');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const task = turn.task;
  const answer = visibleAnswer(task?.answer ?? '');
  const references = task?.references ?? [];
  const savedPath = turn.savedPath ?? task?.savedPath;
  const thinking = [...(task?.answer ?? '').matchAll(/<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi)].map((match) => match[1]).join('\n\n');
  const active = task && ['queued', 'retrieving', 'answering'].includes(task.status);
  const statusLabels = { queued: '排队中', retrieving: '检索证据中', answering: '回答生成中', done: '已完成', cancelled: '已停止', error: '回答失败' };

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopyError(t('qa.copyFailed', { defaultValue: '复制失败，请重试。' }));
    }
  }

  return (
    <article className="space-y-3">
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground">{turn.question}</div>
      <WikiSurface>
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground" role="status">
          {!turn.localWaitEnded && (active || (!task && !turn.error)) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          <span>{turn.localWaitEnded ? t('qa.localWaitEnded', { defaultValue: '已结束本地等待（后台状态未变）' }) : task ? t(`qa.status.${task.status}`, { defaultValue: statusLabels[task.status] }) : turn.error ? t('qa.unconfirmed', { defaultValue: '任务结果尚未确认' }) : t('qa.starting', { defaultValue: '正在提交问题…' })}</span>
          {task ? <span className="ml-auto truncate" title={task.modelRef}>{task.modelRef}</span> : null}
        </div>
        {thinking ? <details className="m-4 rounded-xl border border-border/60 p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('qa.thinking', { defaultValue: '思考过程' })}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">{thinking}</pre></details> : null}
        {answer ? (
          <div onClickCapture={(event) => {
            const anchor = (event.target as HTMLElement).closest('a');
            const href = anchor?.getAttribute('href');
            const index = href?.match(/^#wiki-qa-reference-(\d+)$/)?.[1];
            const reference = index === undefined ? references.find((item) => item.path === href) : references[Number(index)];
            if (!reference) return;
            event.preventDefault();
            event.stopPropagation();
            if (!disabled) onOpenFile(reference.path);
          }} aria-live={active ? 'polite' : 'off'}>
            <MarkdownPreview filePath={savedPath ?? 'wiki/queries/answer.md'} markdown={referenceMarkdown(answer, references)} resolveImageSrc={resolveWikiMarkdownImage} />
          </div>
        ) : null}
        {task?.error || turn.error || copyError ? <p role="alert" className="px-4 py-3 whitespace-pre-wrap text-sm text-destructive">{turn.error || task?.error || copyError}</p> : null}
        {references.length > 0 ? (
          <details className="mx-4 mb-3 rounded-xl border border-border/60 p-3">
            <summary className="cursor-pointer text-xs font-medium">{t('qa.references', { count: references.length, defaultValue: '{{count}} 条检索证据' })}</summary>
            <div className="mt-2 space-y-3">
              {references.map((reference, index) => <div key={`${reference.path}:${index}`} className="text-xs"><button type="button" disabled={disabled} onClick={() => onOpenFile(reference.path)} className="flex max-w-full items-center gap-2 rounded text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><FileText className="h-3.5 w-3.5 shrink-0" /><span className="break-words">[{index + 1}] {reference.title}</span></button><p className="mt-1 break-all text-muted-foreground">{reference.path}</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{reference.snippet}</p>{reference.graphRelatedTo.length > 0 ? <p className="mt-1 text-muted-foreground">{t('qa.graphRelated', { pages: reference.graphRelatedTo.join('、'), defaultValue: '图谱关联：{{pages}}' })}</p> : null}</div>)}
            </div>
          </details>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 px-4 pb-3">
          {answer ? <Button size="sm" variant="ghost" onClick={() => { void copy(); }}><Copy className="h-3.5 w-3.5" />{t(copied ? 'qa.copied' : 'qa.copy', { defaultValue: copied ? '已复制' : '复制' })}</Button> : null}
          {savedPath ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onOpenFile(savedPath)}><Check className="h-3.5 w-3.5" />{t('qa.openSaved', { defaultValue: '打开已保存页面' })}</Button> : task?.status === 'done' && answer ? <Button size="sm" variant="outline" disabled={disabled || saving || !canSave} onClick={onSave}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookmarkPlus className="h-3.5 w-3.5" />}{t(saving ? 'qa.saving' : 'qa.save', { defaultValue: saving ? '保存中…' : '保存为问答页面' })}</Button> : null}
          {canRegenerate ? <Button size="sm" variant="ghost" disabled={disabled} onClick={onRegenerate}><RotateCcw className="h-3.5 w-3.5" />{t(task?.status === 'error' ? 'qa.retry' : 'qa.regenerate', { defaultValue: task?.status === 'error' ? '重试' : '重新生成' })}</Button> : null}
        </div>
      </WikiSurface>
    </article>
  );
}

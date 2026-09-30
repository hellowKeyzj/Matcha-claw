import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, MessageSquare, Plus, RefreshCw, Send, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiAskQuestion, hostWikiCallResult, hostWikiCancelQuestion, hostWikiQuestionTask, hostWikiSaveQuestion } from '@/lib/host-api';
import { fetchSelectableProviderModels, resolveModelCatalogEntry, resolveModelRuntimeReference } from '@/lib/provider-models';
import type { ModelCatalogEntry } from '@/types/subagent';
import type { WikiQuestionTask } from '@/types/wiki-capabilities';
import { QuestionMessage, type QuestionTurn } from './QuestionMessage';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type QuestionPanelProps = Readonly<{
  projectId: string;
  initialModelRef?: string;
  busy?: string | null;
  onOpenFile(path: string): void | Promise<void>;
  onSaved(path: string): void | Promise<void>;
}>;

type QuestionTask = WikiQuestionTask;
type Conversation = Readonly<{ id: string; title: string; turns: readonly QuestionTurn[] }>;
type Action = 'ask' | 'cancel' | 'save' | 'refresh' | null;

function isTerminal(task: QuestionTask | null): boolean {
  return task !== null && ['done', 'cancelled', 'error'].includes(task.status);
}

export function QuestionPanel({ projectId, initialModelRef, busy, onOpenFile, onSaved }: QuestionPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [modelRef, setModelRef] = useState(initialModelRef ?? '');
  const [models, setModels] = useState<readonly ModelCatalogEntry[]>([]);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [modelVersion, setModelVersion] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(10);
  const [action, setAction] = useState<Action>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [observeTaskId, setObserveTaskId] = useState<string | null>(null);
  const [localWaitingTaskId, setLocalWaitingTaskId] = useState<string | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const [error, setError] = useState('');
  const conversationsRef = useRef(conversations);
  const actionRef = useRef<Action>(null);
  const serialRef = useRef<Promise<unknown>>(Promise.resolve());
  const lifecycleRef = useRef(0);
  const waitControllerRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onOpenFile, onSaved });
  callbacksRef.current = { onOpenFile, onSaved };

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    return () => {
      lifecycleRef.current = lifecycle + 1;
      waitControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setModelLoading(true);
    setModelError('');
    void fetchSelectableProviderModels('chat').then((catalog) => {
      if (!cancelled) setModels(catalog);
    }).catch(() => {
      if (!cancelled) setModelError(t('qa.modelsFailed', { defaultValue: '无法读取可用模型，请刷新重试。' }));
    }).finally(() => { if (!cancelled) setModelLoading(false); });
    return () => { cancelled = true; };
  }, [modelVersion, t]);

  function updateConversations(update: (current: readonly Conversation[]) => readonly Conversation[]): void {
    const next = update(conversationsRef.current);
    conversationsRef.current = next;
    setConversations(next);
  }

  const serial = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const next = serialRef.current.then(operation);
    serialRef.current = next.catch(() => {});
    return next;
  }, []);

  const projectFailure = useCallback(() => new Error(t('qa.identityMismatch', { defaultValue: '任务身份不匹配，已停止读取。' })), [t]);

  const applyTask = useCallback((task: QuestionTask): void => {
    const next = conversationsRef.current.map((conversation) => ({
      ...conversation,
      turns: conversation.turns.map((turn) => turn.id !== task.id || (turn.task && turn.task.revision > task.revision)
        ? turn : { ...turn, task, error: null, localWaitEnded: false }),
    }));
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const readTask = useCallback(async (taskId: string, isCurrent: () => boolean): Promise<QuestionTask | null> => {
    const receipt = await hostWikiQuestionTask({ projectId, taskId });
    if (!isCurrent()) return null;
    if (receipt.projectId !== projectId || receipt.task.projectId !== projectId || receipt.task.id !== taskId) throw projectFailure();
    const previous = conversationsRef.current.flatMap((conversation) => conversation.turns).find((turn) => turn.id === taskId)?.task;
    if (previous && receipt.task.revision < previous.revision) return previous;
    applyTask(receipt.task);
    return receipt.task;
  }, [applyTask, projectFailure, projectId]);

  useEffect(() => {
    if (!observeTaskId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const isCurrent = () => !cancelled;
    const poll = async () => {
      if (cancelled) return;
      if (actionRef.current) {
        timer = setTimeout(() => { void poll(); }, 1000);
        return;
      }
      try {
        const task = await serial(() => cancelled || actionRef.current ? Promise.resolve(null) : readTask(observeTaskId, isCurrent));
        if (cancelled) return;
        if (isTerminal(task)) {
          setObserveTaskId(null);
          setLocalWaitingTaskId((current) => current === observeTaskId ? null : current);
          return;
        }
        if (++polls >= 600) {
          setError(t('qa.progressPaused', { defaultValue: '后台任务未结束，自动刷新已暂停；点击刷新继续查看。' }));
          return;
        }
        timer = setTimeout(() => { void poll(); }, 1000);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t('qa.readFailed', { defaultValue: '无法读取任务进度，请刷新重试。' }));
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [observeTaskId, pollVersion, readTask, serial, t]);

  const activeConversation = conversations.find((conversation) => conversation.id === conversationId);
  const turns = activeConversation?.turns ?? [];
  const lastTurn = turns.at(-1);
  const pendingTurn = conversations.flatMap((conversation) => conversation.turns).find((turn) => turn.id === localWaitingTaskId && !isTerminal(turn.task));
  const disabled = Boolean(busy) || action !== null;
  const canAsk = !disabled && !pendingTurn && !modelLoading && !modelError && Boolean(resolveModelCatalogEntry(models, modelRef));
  const scrollKey = `${conversationId}:${turns.length}:${lastTurn?.task?.answer.length ?? 0}`;
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [scrollKey]);

  async function run(nextAction: Exclude<Action, null>, operation: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (actionRef.current) return;
    actionRef.current = nextAction;
    setAction(nextAction);
    setError('');
    const lifecycle = lifecycleRef.current;
    const isCurrent = () => lifecycleRef.current === lifecycle;
    try {
      await serial(() => isCurrent() ? operation(isCurrent) : Promise.resolve());
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : t('qa.actionFailed', { defaultValue: '操作失败，请重试。' }));
    } finally {
      actionRef.current = null;
      if (isCurrent()) {
        setAction(null);
        setSavingTaskId(null);
      }
    }
  }

  function createConversation(): void {
    if (disabled || pendingTurn) return;
    const id = crypto.randomUUID();
    updateConversations((current) => [{ id, title: t('qa.newConversation', { defaultValue: '新会话' }), turns: [] }, ...current]);
    setConversationId(id);
    setQuestion('');
    setError('');
  }

  function ask(regenerate = false): void {
    const text = regenerate ? lastTurn?.question ?? '' : question.trim();
    const reference = resolveModelRuntimeReference(models, modelRef);
    if (actionRef.current || !canAsk || (!regenerate && lastTurn && !isTerminal(lastTurn.task)) || !text || !reference) return;
    const id = crypto.randomUUID();
    const selectedId = conversationId ?? crypto.randomUUID();
    const priorTurns = regenerate ? turns.slice(0, -1) : turns;
    const history = historyLimit === 0 ? [] : priorTurns.flatMap((turn) => [
      { role: 'user' as const, content: turn.question },
      ...(turn.task?.status === 'done' ? [{ role: 'assistant' as const, content: turn.task.answer }] : []),
    ]).slice(-historyLimit);
    const newTurn: QuestionTurn = { id, question: text, task: null, error: null };
    updateConversations((current) => activeConversation
      ? current.map((conversation) => conversation.id === selectedId ? { ...conversation, title: conversation.turns.length === 0 ? text.slice(0, 50) : conversation.title, turns: [...priorTurns, newTurn] } : conversation)
      : [{ id: selectedId, title: text.slice(0, 50), turns: [newTurn] }, ...current]);
    setConversationId(selectedId);
    setQuestion('');
    setLocalWaitingTaskId(id);
    void run('ask', async (isCurrent) => {
      try {
        await hostWikiAskQuestion({ projectId, taskId: id, modelRef: reference, question: text, history });
        if (!isCurrent()) return;
        await readTask(id, isCurrent);
      } catch (failure) {
        if (isCurrent()) updateConversations((current) => current.map((conversation) => ({ ...conversation, turns: conversation.turns.map((turn) => turn.id === id ? { ...turn, error: t('qa.askUnconfirmed', { defaultValue: '提交结果尚未确认，请刷新核对本次任务；未确认前不会重复提交。' }) } : turn) })));
        throw failure;
      } finally {
        if (isCurrent()) setObserveTaskId(id);
      }
    });
  }

  function stop(): void {
    if (!pendingTurn || disabled) return;
    void run('cancel', async (isCurrent) => {
      const receipt = await hostWikiCancelQuestion({ projectId, taskId: pendingTurn.id });
      if (!isCurrent()) return;
      if (receipt.projectId !== projectId || receipt.task.projectId !== projectId || receipt.task.id !== pendingTurn.id) throw projectFailure();
      applyTask(receipt.task);
      setObserveTaskId(isTerminal(receipt.task) ? null : pendingTurn.id);
      if (isTerminal(receipt.task)) setLocalWaitingTaskId(null);
      setPollVersion((version) => version + 1);
    });
  }

  function save(turn: QuestionTurn): void {
    if (disabled || actionRef.current || pendingTurn || turn.task?.status !== 'done' || turn.savedPath || turn.task.savedPath) return;
    void run('save', async (isCurrent) => {
      setSavingTaskId(turn.id);
      const receipt = await hostWikiSaveQuestion({ projectId, taskId: turn.id });
      if (!isCurrent()) return;
      const controller = new AbortController();
      waitControllerRef.current = controller;
      try {
        const call = await waitForCall(receipt, 'wiki', { signal: controller.signal });
        if (!isCurrent()) return;
        if (call.callId !== receipt.callId || call.command !== 'qa.save' || call.detail.operation !== 'qa.save'
          || call.status !== 'succeeded' || call.detail.outcome !== 'completed') throw new Error(t('qa.saveUnconfirmed', { defaultValue: '保存未确认成功，请刷新任务后重试。' }));
        const result = await hostWikiCallResult({ callId: receipt.callId });
        if (!isCurrent()) return;
        if (result.callId !== receipt.callId || result.operation !== 'qa.save' || result.result.projectId !== projectId) throw projectFailure();
        const path = result.result.savedPath;
        updateConversations((current) => current.map((conversation) => ({ ...conversation, turns: conversation.turns.map((item) => item.id === turn.id ? { ...item, savedPath: path } : item) })));
        await callbacksRef.current.onSaved(path);
      } finally {
        if (waitControllerRef.current === controller) waitControllerRef.current = null;
      }
    });
  }

  function refresh(): void {
    if (disabled) return;
    void run('refresh', async (isCurrent) => {
      const turn = pendingTurn ?? lastTurn;
      if (turn) {
        const task = await readTask(turn.id, isCurrent);
        if (!isCurrent()) return;
        setObserveTaskId(isTerminal(task) ? null : turn.id);
        setLocalWaitingTaskId(isTerminal(task) ? null : turn.id);
        setPollVersion((version) => version + 1);
        if (task?.savedPath && !turn.savedPath) {
          const path = task.savedPath;
          updateConversations((current) => current.map((conversation) => ({ ...conversation, turns: conversation.turns.map((item) => item.id === turn.id ? { ...item, savedPath: path } : item) })));
          await callbacksRef.current.onSaved(path);
        }
      }
      if (isCurrent()) setModelVersion((version) => version + 1);
    });
  }

  function openFile(path: string): void {
    const lifecycle = lifecycleRef.current;
    void Promise.resolve().then(() => callbacksRef.current.onOpenFile(path)).catch((failure) => {
      if (lifecycleRef.current === lifecycle) setError(failure instanceof Error ? failure.message : t('qa.openFailed', { defaultValue: '无法打开引用文件。' }));
    });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    ask();
  }

  return (
    <WikiPanel>
      <WikiPanelHeader title={t('qa.title', { defaultValue: '知识库问答' })} subtitle={t('qa.subtitle', { defaultValue: '基于检索证据回答，支持多轮追问' })} icon={MessageSquare} actions={<><WikiIconButton onClick={createConversation} disabled={disabled || Boolean(pendingTurn)} title={t('qa.newConversation', { defaultValue: '新会话' })}><Plus className="h-4 w-4" /></WikiIconButton><WikiIconButton onClick={refresh} disabled={disabled} title={t('common.refresh')}>{action === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</WikiIconButton></>} />
      <div className="flex min-h-0 flex-1">
        {conversations.length > 0 ? <aside className="w-36 shrink-0 overflow-auto border-r border-border/70 p-2 lg:w-44" aria-label={t('qa.conversations', { defaultValue: '问答会话' })}>{conversations.map((conversation) => <div key={conversation.id} className="mb-1 flex items-start gap-1"><button type="button" disabled={disabled || Boolean(pendingTurn)} onClick={() => { setConversationId(conversation.id); setError(''); }} className={`min-w-0 flex-1 rounded-xl px-3 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${conversation.id === conversationId ? 'bg-primary/10 text-primary' : 'hover:bg-secondary/40'}`}><span className="line-clamp-2 break-words">{conversation.title}</span></button><WikiIconButton disabled={disabled || Boolean(pendingTurn)} title={t('qa.deleteConversation', { defaultValue: '删除会话' })} onClick={() => { updateConversations((current) => current.filter((item) => item.id !== conversation.id)); if (conversationId === conversation.id) setConversationId(conversationsRef.current[0]?.id ?? null); }}><Trash2 className="h-3 w-3" /></WikiIconButton></div>)}</aside> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-5">
            <div className="mx-auto max-w-4xl space-y-5">
              {turns.length === 0 ? <WikiEmpty icon={MessageSquare} title={t('qa.empty', { defaultValue: '选择模型并提出问题，回答会附带本次检索证据。' })} /> : turns.map((turn, index) => <QuestionMessage key={turn.id} turn={turn} disabled={disabled} saving={savingTaskId === turn.id} canSave={!pendingTurn} canRegenerate={index === turns.length - 1 && isTerminal(turn.task) && canAsk} onSave={() => save(turn)} onRegenerate={() => ask(true)} onOpenFile={openFile} />)}
              <div ref={bottomRef} />
            </div>
          </div>
          {error ? <div className="shrink-0 space-y-2 px-5 py-2"><p role="alert" className="text-sm text-destructive">{error}</p><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={refresh}><RefreshCw className="h-3.5 w-3.5" />{t('qa.refreshTask', { defaultValue: '刷新任务' })}</Button>{pendingTurn ? <><Button size="sm" variant="ghost" disabled={disabled} onClick={() => { updateConversations((current) => current.map((conversation) => ({ ...conversation, turns: conversation.turns.map((turn) => turn.id === pendingTurn.id ? { ...turn, localWaitEnded: true } : turn) }))); setObserveTaskId(null); setLocalWaitingTaskId(null); setError(''); }}>{t('qa.endLocalWait', { defaultValue: '结束本地等待' })}</Button><span className="text-xs text-muted-foreground">{t('qa.localWaitOnly', { defaultValue: '仅退出本地等待，不取消后台；任务身份保留，可返回本会话刷新恢复。' })}</span></> : null}</div></div> : null}
          <form onSubmit={submit} className="shrink-0 space-y-3 border-t border-border/70 px-5 py-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <label className="flex min-w-0 items-center gap-2"><span>{t('qa.model', { defaultValue: '回答模型' })}</span><select aria-label={t('qa.model', { defaultValue: '回答模型' })} value={resolveModelCatalogEntry(models, modelRef)?.id ?? ''} disabled={disabled || Boolean(pendingTurn) || modelLoading} onChange={(event) => setModelRef(resolveModelRuntimeReference(models, event.target.value) ?? '')} className="h-8 min-w-0 max-w-80 rounded-lg border border-border bg-card px-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="">{t(modelLoading ? 'qa.modelsLoading' : 'qa.selectModel', { defaultValue: modelLoading ? '读取模型中…' : '请选择模型' })}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.displayLabel}</option>)}</select></label>
              <label className="flex items-center gap-2"><span>{t('qa.history', { defaultValue: '历史消息' })}</span><select aria-label={t('qa.history', { defaultValue: '历史消息' })} value={historyLimit} disabled={disabled || Boolean(pendingTurn)} onChange={(event) => setHistoryLimit(Number(event.target.value))} className="h-8 rounded-lg border border-border bg-card px-2 text-foreground">{[0, 4, 10, 20, 50].map((limit) => <option key={limit} value={limit}>{limit}</option>)}</select></label>
              {modelError || (!modelLoading && models.length === 0) ? <span role="alert" className="text-destructive">{modelError || t('qa.modelsEmpty', { defaultValue: '没有可用的回答模型，请先配置模型。' })}</span> : null}
            </div>
            <Textarea value={question} onChange={(event) => setQuestion(event.target.value)} disabled={disabled || Boolean(pendingTurn)} placeholder={t('qa.placeholder', { defaultValue: '向当前知识库提问；Enter 发送，Shift+Enter 换行' })} aria-label={t('qa.question', { defaultValue: '问题' })} rows={3} className="min-h-20 resize-none" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); ask(); } }} />
            <div className="flex justify-end gap-2">{pendingTurn ? <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={stop}><Square className="h-3.5 w-3.5" />{t('qa.stop', { defaultValue: '停止回答' })}</Button> : null}<WikiPrimaryButton type="submit" disabled={!canAsk || Boolean(lastTurn && !isTerminal(lastTurn.task)) || !question.trim()}>{action === 'ask' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{t('qa.send', { defaultValue: '发送问题' })}</WikiPrimaryButton></div>
          </form>
        </div>
      </div>
    </WikiPanel>
  );
}

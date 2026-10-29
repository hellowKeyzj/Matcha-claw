import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { CompileRequest, CompileSelection, Definition, DefinitionRef, ProposeChange, SemanticOperation, TaskSummary, WorldDescription, WorldRef } from '@/types/world';
import { Field, selectClass } from './components';
import { CompileSelectionFields } from './CompileSelection';

function editingKey(world: WorldRef | null, description: WorldDescription | null) {
  return JSON.stringify([world, description?.world, description?.incarnation, description?.revision,
    description?.status, description?.editingContext]);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validReference(value: unknown, world: WorldRef): value is DefinitionRef {
  return record(value) && record(value.world) && sameWorld(value.world as WorldRef, world)
    && typeof value.id === 'string' && Boolean(value.id.trim())
    && typeof value.revision === 'string' && /^[1-9]\d*$/.test(value.revision);
}

function validDefinition(value: unknown, world: WorldRef): value is Definition {
  return record(value) && validReference(value.reference, world)
    && record(value.body) && typeof value.body.kind === 'string' && Boolean(value.body.kind.trim())
    && record(value.body.body) && typeof value.contentDigest === 'string' && Boolean(value.contentDigest.trim())
    && typeof value.scope === 'string' && Boolean(value.scope.trim())
    && Array.isArray(value.dependencies) && value.dependencies.every(item => validReference(item, world))
    && Array.isArray(value.evidence) && value.evidence.every(item => validReference(item, world))
    && (value.previousRef == null || validReference(value.previousRef, world))
    && record(value.lifecycle) && typeof value.lifecycle.kind === 'string'
    && record(value.validTime) && typeof value.validTime.from === 'string'
    && (value.validTime.to == null || typeof value.validTime.to === 'string');
}

function duplicate(definitions: Definition[], existing: Definition[]) {
  const ids = new Set(existing.map(item => item.reference.id));
  return definitions.some(item => {
    if (ids.has(item.reference.id)) return true;
    ids.add(item.reference.id);
    return false;
  });
}

function taskKey(task: TaskSummary) {
  return JSON.stringify([task.reference.world, task.reference.id, task.reference.revision, task.scope]);
}

function AuthoringForm({ world, context, basisKey, existing, blocked, submit }: {
  world: WorldRef; context: CompileRequest; basisKey: string; existing: Definition[]; blocked: boolean;
  submit(request: ProposeChange): Promise<void>;
}) {
  const { t } = useTranslation('world');
  const [scope, setScope] = useState(context.scopes.length === 1 ? context.scopes[0].id : '');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedTask, setSelectedTask] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [imported, setImported] = useState<{ definitions: Definition[]; preview: string; name: string; version: number } | null>(null);
  const [reason, setReason] = useState('');
  const [compile, setCompile] = useState<{ task: string; imported: typeof imported; value: CompileSelection } | null>(null);
  const [error, setError] = useState('');
  const fileVersion = useRef(0);
  useEffect(() => () => { fileVersion.current++; }, []);
  const task = tasks.find(item => taskKey(item) === selectedTask);
  const disabled = blocked || loading || reading;
  const current = useCallback(() => {
    const latest = useWorldStore.getState();
    return editingKey(latest.world, latest.description) === basisKey;
  }, [basisKey]);
  useEffect(() => {
    let active = true;
    setTasks([]); setSelectedTask(''); setCompile(null); setNextCursor(null); setError('');
    setLoading(Boolean(scope));
    if (scope) void queryWorld(world, { kind: 'tasks', request: { scope, page: { limit: 100, cursor } } }, 'tasks')
      .then(page => {
        if (!active || !current()) return;
        if (page.items.some(item => !sameWorld(item.reference.world, world) || item.scope !== scope)) {
          throw new Error(t('model.errors.tasks'));
        }
        setTasks(page.items); setNextCursor(page.nextCursor ?? null);
      })
      .catch(error => { if (active && current()) setError(error instanceof Error ? error.message : t('model.errors.tasks')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [world, scope, cursor, refresh, current, t]);
  const readFile = async (file: File) => {
    if (disabled || !current()) return;
    const version = ++fileVersion.current;
    setImported(null); setCompile(null); setError('');
    if (file.size > 1_048_576) { setError(t('model.authoring.tooLarge')); return; }
    setReading(true);
    try {
      const preview = await file.text();
      if (version !== fileVersion.current) return;
      if (!current()) throw new Error(t('model.authoring.stale'));
      const value: unknown = JSON.parse(preview);
      const definitions: unknown[] = Array.isArray(value) ? value : [value];
      if (!definitions.length || definitions.length > 4096 || !definitions.every(item => validDefinition(item, world))) {
        throw new Error(t('model.authoring.invalid'));
      }
      if (duplicate(definitions, existing)) throw new Error(t('model.authoring.duplicate'));
      setImported({ definitions, preview, name: file.name, version });
    } catch (error) {
      if (version === fileVersion.current) setError(error instanceof SyntaxError ? t('model.authoring.invalid')
        : error instanceof Error ? error.message : t('model.authoring.invalid'));
    } finally { if (version === fileVersion.current) setReading(false); }
  };
  const propose = () => {
    if (disabled) return;
    setError('');
    if (!current()) { setError(t('model.authoring.stale')); return; }
    if (!task || !compile || compile.task !== selectedTask || compile.imported !== imported || !sameWorld(task.reference.world, world)) return;
    const definitions = imported?.definitions ?? [];
    if (duplicate(definitions, existing)) { setError(t('model.authoring.duplicate')); return; }
    const operations: SemanticOperation[] = definitions.map(definition => ({ kind: 'create_definition', definition }));
    if (reason.trim()) operations.push({ kind: 'no_op', reason: reason.trim() });
    if (!operations.length) { setError(t('model.authoring.empty')); return; }
    if (operations.length > 4096) { setError(t('model.authoring.invalid')); return; }
    const evidence = [...new Map(definitions.flatMap(definition => definition.evidence)
      .map(reference => [JSON.stringify([reference.world, reference.id, reference.revision]), reference])).values()];
    void submit({ baseRelease: context.baseRelease, operations, evidence, cases: [], task: task.reference, compile: compile.value });
  };
  return <form className="min-w-0 space-y-5" onSubmit={event => { event.preventDefault(); propose(); }}>
    <fieldset disabled={disabled} className="grid min-w-0 gap-5">
      <div className="space-y-2">
        <Field label={t('model.authoring.file')}><input type="file" accept="application/json,.json" className={`${selectClass} h-auto min-h-9 py-2`} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void readFile(file);
        }} /></Field>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{t('model.authoring.fileHint')}</p>
      </div>
      {imported && <div className="min-w-0 space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all text-sm font-medium">{imported.name} <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{imported.definitions.length}</span></p><Button type="button" size="sm" variant="ghost" onClick={() => { fileVersion.current++; setImported(null); setCompile(null); setError(''); }}>{t('model.authoring.clearImport')}</Button></div>
        <details className="min-w-0 border-t border-border pt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('model.authoring.preview')}</summary>
          <pre tabIndex={0} aria-label={t('model.authoring.preview')} className="mt-3 max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/30 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20">{imported.preview}</pre>
        </details>
      </div>}
      <div className="grid min-w-0 gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <Field label={t('model.details.scope')}><select required className={selectClass} value={scope} onChange={event => {
          fileVersion.current++; setScope(event.target.value); setCursor(null); setSelectedTask(''); setCompile(null); setError('');
        }}><option value="">{t('model.edit.selectScope')}</option>{context.scopes.filter(item => sameWorld(item.world, world)).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field>
        <Field label={t('model.edit.task')}><select required className={selectClass} value={selectedTask} onChange={event => {
          fileVersion.current++; setSelectedTask(event.target.value); setCompile(null); setError('');
        }}><option value="">{t('model.edit.selectTask')}</option>{tasks.map(item => <option key={taskKey(item)} value={taskKey(item)}>{item.goal} · {item.reference.id} · {item.reference.revision}</option>)}</select></Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!scope} onClick={() => { setSelectedTask(''); setCompile(null); setRefresh(value => value + 1); }}>{t('shell.refresh')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={!cursor} onClick={() => { setSelectedTask(''); setCompile(null); setCursor(null); }}>{t('tasks.firstPage')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={!nextCursor} onClick={() => { setSelectedTask(''); setCompile(null); setCursor(nextCursor); }}>{t('tasks.nextPage')}</Button>
      </div>
      {scope && !loading && !tasks.length && !error && <p className="text-sm text-muted-foreground">{t('model.edit.noTasks')}</p>}
      {task && <CompileSelectionFields key={`${selectedTask}:${imported?.version ?? ''}`} context={context} definitionDrafts={imported?.definitions} onChange={value => {
        fileVersion.current++; setCompile(value ? { task: selectedTask, imported, value } : null); setError('');
      }} />}
      <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('model.authoring.noOpReason')}{reason.trim() && <span className="ml-2 text-xs font-normal text-muted-foreground">NoOp</span>}</summary><div className="mt-3 space-y-2"><Field label={t('model.authoring.noOpReason')}><textarea className={`${selectClass} min-h-20 py-2`} value={reason} onChange={event => { setReason(event.target.value); setError(''); }} /></Field><p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{t('model.authoring.noOpHint')}</p></div></details>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4"><Button type="submit" size="sm" disabled={!task || !compile || compile.task !== selectedTask || compile.imported !== imported || (!imported && !reason.trim())}>{t('model.edit.submit')}</Button><Link className="text-xs text-muted-foreground underline underline-offset-4" to="/world/settings?tab=operations">{t('shell.records')}</Link></div>
    </fieldset>
    {(loading || reading) && <p className="text-sm text-muted-foreground" role="status">{t('shell.reading')}</p>}
    {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
  </form>;
}

export function ModelAuthoring() {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const state = useWorldStore();
  const world = state.world;
  const description = state.description;
  const context = description?.editingContext;
  const basisKey = editingKey(world, description);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  useEffect(() => { if (!sending.current) setError(''); }, [basisKey]);
  const ready = world && description && context && description.status === 'ready'
    && sameWorld(description.world, world) && sameWorld(context.world, world);
  const blocked = writing || state.loading || state.busy || state.operationBusy
    || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const submit = async (request: ProposeChange) => {
    const latest = useWorldStore.getState();
    if (!world || !description || !context || !ready || blocked || sending.current || latest.workspaceVersion !== state.workspaceVersion
      || latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
    if (editingKey(latest.world, latest.description) !== basisKey || request.baseRelease !== context.baseRelease
      || !sameWorld(request.task.world, world)) { setError(t('model.authoring.stale')); return; }
    const submitted = version.current;
    sending.current = true; setWriting(true); setError('');
    try {
      const result = await latest.command({ kind: 'propose_change', request });
      if (submitted !== version.current) return;
      const current = useWorldStore.getState();
      // The command refreshes the revision; its receipt still belongs to the original workspace and incarnation.
      if (current.workspaceVersion !== state.workspaceVersion || !current.world || !sameWorld(current.world, world) || !current.description
        || !sameWorld(current.description.world, world) || current.description.incarnation !== description.incarnation) return;
      if (result.kind === 'accepted') {
        if (!sameWorld(result.result.world, world) || result.result.incarnation !== description.incarnation) {
          throw new Error(t('operations.errors.receiptMismatch'));
        }
        navigate('/world/settings?tab=operations');
      } else if ((result.kind === 'candidate' && sameWorld(result.result.world, world)
        && result.result.changeSet.baseRelease === request.baseRelease)
        || (result.kind === 'change' && sameWorld(result.result.world, world) && result.result.baseRelease === request.baseRelease)) {
        navigate('/world/changes');
      } else throw new Error(t('operations.errors.receiptMismatch'));
    } catch (error) {
      if (submitted === version.current) setError(error instanceof Error ? error.message : t('model.errors.submit'));
    } finally {
      sending.current = false;
      if (submitted === version.current) setWriting(false);
    }
  };
  return <section className="min-w-0 max-w-3xl space-y-6">
    <header className="space-y-2 border-b border-border pb-5"><h2 className="text-base font-semibold tracking-tight">{t('model.authoring.title')}</h2><p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{t('model.authoring.hint')}</p></header>
    {ready ? <AuthoringForm key={basisKey} world={world} context={context} basisKey={basisKey}
      existing={[...context.definitions, ...state.definitions]} blocked={blocked} submit={submit} />
      : <p className="text-sm text-muted-foreground" role="status">{t('model.edit.noContext')}</p>}
    {writing && <p className="text-sm text-muted-foreground" role="status">{t('shell.processing')}</p>}
    {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
  </section>;
}

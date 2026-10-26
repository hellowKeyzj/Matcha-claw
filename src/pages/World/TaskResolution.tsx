import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '@/stores/world';
import { operationWorld, queryWorld, sameWorld } from '@/stores/world/client';
import type { AbstractionContract, AbstractionRef, ContextResult, Definition, InvestigationSelection, OperationAccepted, OperationResponse, QueryRequest, ResolveTaskRequest, TaskContract, TaskRef, TaskSummary, TestCase, TestRevision } from '@/types/world';
import { ValueField, readValue } from './Actions';
import { DataTable, Field, selectClass } from './components';
import { FixedRecord } from './Definitions';
import { InvestigationSession } from './InvestigationSession';
import { AbstractionAuthoring } from './AbstractionAuthoring';
import { useWorldConfirmation } from './WorldConfirmation';

export function TaskResolution({ tasks }: { tasks: TaskSummary[] }) {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const [taskKey, setTaskKey] = useState('');
  const [task, setTask] = useState<TaskContract | null>(null);
  const [abstractions, setAbstractions] = useState<AbstractionContract[]>([]);
  const [nextAbstraction, setNextAbstraction] = useState<string | null>(null);
  const [tests, setTests] = useState<TestCase[]>([]);
  const [nextTest, setNextTest] = useState<string | null>(null);
  const [abstractionKey, setAbstractionKey] = useState('');
  const [abstraction, setAbstraction] = useState<AbstractionContract | null>(null);
  const [exactDefinitions, setExactDefinitions] = useState<Definition[]>([]);
  const [authored, setAuthored] = useState<{ reference: AbstractionRef; operation: OperationAccepted } | null>(null);
  const [authorReceipt, setAuthorReceipt] = useState<Extract<OperationResponse, { kind: 'result' }>['result'] | null>(null);
  const [testKey, setTestKey] = useState('');
  const [queryKey, setQueryKey] = useState('');
  const [view, setView] = useState<ContextResult | null>(null);
  const [execution, setExecution] = useState<InvestigationSelection | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const version = useRef(0);
  const mounted = useRef(false);
  const reference = tasks.find(item => JSON.stringify(item.reference) === taskKey)?.reference;
  const sourceTypes = (abstraction ? exactDefinitions : state.definitions).filter(item => item.body.kind === 'object_type' || item.body.kind === 'relation_type');
  const definition = sourceTypes.find(item => JSON.stringify(item.reference) === queryKey);
  const test = tests.find(item => JSON.stringify([item.id, item.revision]) === testKey);
  const selection = useMemo(() => ({ taskKey, reference, task, abstractionKey, abstraction, testKey, test, execution, queryKey, definition, view, reading, reload }),
    [taskKey, reference, task, abstractionKey, abstraction, testKey, test, execution, queryKey, definition, view, reading, reload]);
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const blocked = state.loading || state.busy || state.operationBusy || Boolean(state.pending)
    || Boolean(state.pendingOperation) || state.transferBusy || reading;
  const world = state.world;
  const incarnation = state.description?.incarnation;
  const revision = state.description?.revision;
  const current = (token: number) => {
    const latest = useWorldStore.getState();
    return mounted.current && token === version.current && world && latest.world && sameWorld(latest.world, world)
      && latest.description?.status === 'ready' && latest.description.incarnation === incarnation && latest.description.revision === revision;
  };
  const readTests = async (references: TestRevision[], selectedTask: TaskRef, token: number): Promise<TestCase[] | null> => {
    if (!world || !current(token)) return null;
    if (!sameWorld(selectedTask.world, world)) throw new Error(t('resolution.mismatch'));
    const values = await Promise.all(references.map(reference => queryWorld(world, { kind: 'exact_test_case', request: reference }, 'exact_test_case')));
    if (!current(token)) return null;
    if (values.some((item, index) => !sameWorld(item.world, world) || item.taskId !== selectedTask.id || item.taskRevision !== selectedTask.revision
      || item.id !== references[index].id || item.revision !== references[index].revision)) throw new Error(t('resolution.mismatch'));
    return values;
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => { setAuthored(null); setAuthorReceipt(null); }, [world?.tenantId, world?.worldId, incarnation, taskKey]);
  const authorTask = { key: taskKey, incarnation, world };
  const latestAuthorTask = useRef(authorTask);
  latestAuthorTask.current = authorTask;
  const submitted = (authoredRef: AbstractionRef, operation: OperationAccepted) => {
    const latest = useWorldStore.getState();
    const selectedTask = latestAuthorTask.current;
    if (!mounted.current || !latest.world || !world || !sameWorld(latest.world, world) || !selectedTask.world || !sameWorld(selectedTask.world, world)
      || latest.description?.incarnation !== incarnation || selectedTask.incarnation !== incarnation
      || selectedTask.key !== taskKey) return;
    setAuthored({ reference: authoredRef, operation }); setAuthorReceipt(null);
  };
  useEffect(() => {
    const token = ++version.current;
    setTask(null); setAbstractions([]); setTests([]); setNextAbstraction(null); setNextTest(null);
    setAbstraction(null); setExactDefinitions([]); setAbstractionKey(''); setQueryKey(''); setTestKey(''); setView(null); setExecution(null); setError(''); setReading(false);
    if (!world || !reference || state.description?.status !== 'ready') return;
    setReading(true);
    void Promise.all([
      queryWorld(world, { kind: 'task_contract', request: reference }, 'task_contract'),
      queryWorld(world, { kind: 'abstractions', request: { task: reference, page: { limit: 100, cursor: null } } }, 'abstractions'),
      queryWorld(world, { kind: 'test_cases', request: { task: reference, page: { limit: 100, cursor: null } } }, 'test_cases'),
    ]).then(async ([contract, page, cases]) => {
      if (!current(token)) return;
      if (!contract || !sameWorld(contract.world, world) || contract.id !== reference.id || contract.revision !== reference.revision
        || page.items.some(item => !sameWorld(item.world, world) || item.taskId !== reference.id || item.taskRevision !== reference.revision)) throw new Error(t('resolution.mismatch'));
      const loaded = await readTests(cases.items, reference, token);
      if (!loaded) return;
      setTask(contract); setAbstractions(page.items); setTests(loaded); setNextAbstraction(page.nextCursor ?? null); setNextTest(cases.nextCursor ?? null);
    }).catch(error => { if (token === version.current) setError(error instanceof Error ? error.message : t('resolution.failed')); })
      .finally(() => { if (token === version.current) setReading(false); });
    return () => { version.current++; };
  }, [world, reference, incarnation, revision, state.description?.status, reload, t]);
  const loadMore = async (kind: 'abstractions' | 'tests') => {
    if (!world || !reference || blocked) return;
    const token = version.current;
    setReading(true); setError('');
    try {
      if (kind === 'abstractions' && nextAbstraction) {
        const page = await queryWorld(world, { kind: 'abstractions', request: { task: reference, page: { limit: 100, cursor: nextAbstraction } } }, 'abstractions');
        if (!current(token)) return;
        if (page.items.some(item => !sameWorld(item.world, world) || item.taskId !== reference.id || item.taskRevision !== reference.revision)) throw new Error(t('resolution.mismatch'));
        setAbstractions(items => [...items, ...page.items]); setNextAbstraction(page.nextCursor ?? null);
      } else if (kind === 'tests' && nextTest) {
        const page = await queryWorld(world, { kind: 'test_cases', request: { task: reference, page: { limit: 100, cursor: nextTest } } }, 'test_cases');
        const loaded = await readTests(page.items, reference, token);
        if (!loaded) return;
        setTests(items => [...items, ...loaded]); setNextTest(page.nextCursor ?? null);
      }
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
    finally { if (token === version.current) setReading(false); }
  };
  const query = (): QueryRequest | null => {
    if (!world || !definition || (definition.body.kind !== 'object_type' && definition.body.kind !== 'relation_type')) return null;
    return { world, query: { root: { kind: definition.body.kind === 'object_type' ? 'objects' : 'relations', typeRef: definition.reference, symbol: 'item' }, parameters: [], limit: 100,
      output: definition.body.body.properties.map(property => ({ name: property.id, expression: { kind: 'field', subject: 'item', property } })) },
    arguments: [], readMode: { kind: 'authoritative' }, page: { limit: 100, cursor: null },
    ...(abstraction ? { releaseId: abstraction.baseRelease, branchId: abstraction.branch?.id ?? null } : {}) };
  };
  const inspect = async (authoredRef?: AbstractionRef, candidateId?: string) => {
    if (!world || !reference || blocked) return;
    const selected = authoredRef ?? abstractions.find(item => JSON.stringify([item.id, item.revision]) === abstractionKey);
    if (!selected) return;
    const token = version.current;
    setReading(true); setError(''); setAbstraction(null); setExactDefinitions([]); setView(null); setQueryKey('');
    try {
      const result = await queryWorld(world, { kind: 'abstraction', request: { world, id: selected.id, revision: selected.revision } }, 'abstraction');
      if (!current(token)) return;
      if (!result || !sameWorld(result.world, world) || result.id !== selected.id || result.revision !== selected.revision
        || result.taskId !== reference.id || result.taskRevision !== reference.revision || (candidateId && result.candidateId !== candidateId)) throw new Error(t('resolution.mismatch'));
      const definitions: Definition[] = [];
      let references = result.originalDefinitions;
      const seen = new Set<string>();
      while (references.length) {
        const batch = references.filter(reference => { const key = JSON.stringify(reference); if (seen.has(key)) return false; seen.add(key); return true; });
        if (!batch.length) break;
        const values = await Promise.all(batch.map(reference => queryWorld(world, { kind: 'definition', request: { reference } }, 'definition')));
        if (!current(token)) return;
        const loaded: Definition[] = [];
        values.forEach((item, index) => {
          if (!item || !sameWorld(item.reference.world, world) || item.reference.id !== batch[index].id || item.reference.revision !== batch[index].revision) throw new Error(t('resolution.mismatch'));
          loaded.push(item);
        });
        definitions.push(...loaded); references = loaded.flatMap(item => item.dependencies);
      }
      setExactDefinitions(definitions);
      setAbstraction(result); setAbstractionKey(JSON.stringify([result.id, result.revision]));
      setAbstractions(items => [...items.filter(item => item.id !== result.id || item.revision !== result.revision), result]);
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
    finally { if (token === version.current) setReading(false); }
  };
  const readAuthorOperation = async () => {
    if (!world || !authored || blocked) return;
    const token = version.current;
    setReading(true); setError(''); setAuthorReceipt(null);
    try {
      const response = await operationWorld({ kind: 'result', request: { world, operationId: authored.operation.operationId } });
      if (!current(token)) return;
      if (response.kind !== 'result' || !sameWorld(response.result.accepted.world, world)
        || response.result.accepted.operationId !== authored.operation.operationId || response.result.accepted.incarnation !== incarnation) throw new Error(t('resolution.mismatch'));
      setAuthorReceipt(response.result);
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
    finally { if (token === version.current) setReading(false); }
  };
  const authorCandidate = authorReceipt?.phase === 'completed' && authorReceipt.result?.kind === 'candidate'
    && world && sameWorld(authorReceipt.result.result.world, world)
    && (authorReceipt.disclosure.kind === 'full' || !authorReceipt.disclosure.withheld.includes('result_details')) ? authorReceipt.result.result : null;
  const readView = async () => {
    const request = query();
    if (!world || !reference || !task || !request || blocked) return;
    const token = version.current;
    setReading(true); setError(''); setView(null);
    try {
      const result = await queryWorld(world, { kind: 'world_view', request: { task: reference, query: request, budget: task.budget } }, 'world_view');
      if (!current(token)) return;
      if (!sameWorld(result.view.world, world) || result.view.taskId !== reference.id || result.view.taskRevision !== reference.revision
        || result.view.scope !== task.scope || !sameWorld(result.receipt.world, world)
        || (abstraction && (result.receipt.releaseId !== abstraction.baseRelease || (result.receipt.branchId ?? null) !== (abstraction.branch?.id ?? null)))) throw new Error(t('resolution.mismatch'));
      setView(result);
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
    finally { if (token === version.current) setReading(false); }
  };
  const resolve = async (form: HTMLFormElement) => {
    const request = query();
    if (!reference || !task || !abstraction || !view || !test || !execution || !request || blocked
      || view.receipt.releaseId !== abstraction.baseRelease || (view.receipt.branchId ?? null) !== (abstraction.branch?.id ?? null)) return;
    const token = version.current;
    try {
      const input = readValue(t, new FormData(form), 'task.input', task.inputType);
      if (input === undefined || !form.isConnected || !current(token)) return;
      const intent: ResolveTaskRequest = { task: reference, abstractionId: abstraction.id, abstractionRevision: abstraction.revision, query: request, input, test: { id: test.id, revision: test.revision }, execution };
      if (!await confirm(t('resolution.confirm'))) return;
      const latestState = useWorldStore.getState();
      if (!current(token) || latestSelection.current !== selection || !form.isConnected || latestState.loading || latestState.busy
        || latestState.operationBusy || latestState.pending || latestState.pendingOperation || latestState.transferBusy) return;
      setError('');
      const result = await latestState.command({ kind: 'resolve_task', request: intent });
      const latest = useWorldStore.getState();
      if (result.kind === 'accepted' && mounted.current && world && latest.world && sameWorld(latest.world, world) && latest.description?.incarnation === incarnation) navigate('/world/settings?tab=operations');
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
  };
  return <details className="min-w-0 border-t border-border pt-4"><summary className="cursor-pointer text-sm font-semibold">{t('resolution.title')}</summary><div className="mt-5 space-y-6">
    <p className="text-xs leading-relaxed text-muted-foreground">{t('resolution.notice')}</p>
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><Field label={t('resolution.task')}><select className={selectClass} value={taskKey} disabled={blocked} onChange={event => setTaskKey(event.target.value)}><option value="">{t('packages.select')}</option>{tasks.map(item => <option key={JSON.stringify(item.reference)} value={JSON.stringify(item.reference)}>{item.goal} · {item.reference.id} / {item.reference.revision}</option>)}</select></Field></div><Button type="button" size="sm" variant="outline" disabled={blocked || !reference} onClick={() => setReload(value => value + 1)}>{t('shell.refresh')}</Button></div>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}{reading && <p className="text-sm text-muted-foreground" role="status">{t('shell.reading')}</p>}
    {authored && <div className="space-y-3 rounded-lg border border-border p-3"><p className="break-all text-sm">{t('abstractionAuthor.submitted', { id: authored.reference.id, revision: authored.reference.revision })}</p><p className="break-all font-mono text-xs text-muted-foreground">{authored.operation.operationId}</p><div className="flex flex-wrap gap-3"><Link className="self-center text-sm underline underline-offset-4" to="/world/settings?tab=operations">{t('shell.records')}</Link><Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { void readAuthorOperation(); }}>{t('abstractionAuthor.readOperation')}</Button><Button type="button" size="sm" variant="outline" disabled={blocked || !reference || !authorCandidate} onClick={() => { if (authorCandidate) void inspect(authored.reference, authorCandidate.id); }}>{t('abstractionAuthor.readExact')}</Button></div>{authorReceipt && <p className="text-sm" role="status">{t(`operations.phase.${authorReceipt.phase}`)}</p>}{authorReceipt?.failure && <p className="text-sm text-destructive" role="alert">{authorReceipt.failure.message}</p>}</div>}
    {task && <>
      <header className="space-y-3 border-b border-border pb-5"><h3 className="break-words text-base font-semibold tracking-tight">{task.goal}</h3><p className="break-all font-mono text-xs text-muted-foreground">{task.id} / {task.revision} · {task.scope}</p><details><summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('resolution.contract')}</summary><div className="mt-3"><FixedRecord value={task} /></div></details></header>
      <section className="space-y-4"><h4 className="text-sm font-semibold">{t('resolution.worldView')}</h4>
      <Field label={t('resolution.queryType')}><select className={selectClass} value={queryKey} disabled={blocked} onChange={event => { setQueryKey(event.target.value); setView(null); }}><option value="">{t('packages.select')}</option>{sourceTypes.map(item => <option key={JSON.stringify(item.reference)} value={JSON.stringify(item.reference)}>{item.body.kind === 'object_type' || item.body.kind === 'relation_type' ? item.body.body.name : item.reference.id} · {item.reference.revision}</option>)}</select></Field>
      <p className="text-xs text-muted-foreground">{t('resolution.queryNotice')}</p>{abstraction && <p className="text-xs text-muted-foreground">{t('abstractionAuthor.exactBasis', { release: abstraction.baseRelease, branch: abstraction.branch?.id ?? t('shared.empty') })}</p>}<Button type="button" size="sm" variant="outline" disabled={blocked || !definition} onClick={() => { void readView(); }}>{t('resolution.readView')}</Button>
      {view && <div className="space-y-3 rounded-lg border border-border p-3"><h4 className="text-sm font-medium">{t('resolution.worldView')}</h4><p className="text-xs text-muted-foreground">{t('resolution.viewNotice')}</p><FixedRecord value={{ scope: view.view.scope, goal: view.view.goal, hardConstraints: view.view.hardConstraints, allowedEffects: view.view.allowedEffects, stopConditions: view.view.stopConditions, labels: view.view.labels, truncation: view.view.truncation }} /><details><summary className="cursor-pointer text-sm">{t('resolution.facts')}</summary><div className="mt-3"><FixedRecord value={{ rows: view.view.rows, objects: view.view.objects, relations: view.view.relations, definitions: view.view.definitions, actions: view.view.actions, abstractions: view.view.abstractions, untrustedMaterial: view.view.untrustedMaterial }} /></div></details><details><summary className="cursor-pointer text-sm">{t('data.readReceipt')}</summary><div className="mt-3"><FixedRecord value={{ receipt: view.receipt, readReceipts: view.view.readReceipts }} /></div></details></div>}
      </section>
      {state.description?.editingContext && <AbstractionAuthoring key={JSON.stringify([world, incarnation, revision, task.id, task.revision, state.description.editingContext])} task={task} context={state.description.editingContext} view={view} disabled={blocked} onSubmitted={submitted} />}
      <section className="space-y-4 border-t border-border pt-5"><h4 className="text-sm font-semibold">{t('resolution.abstraction')}</h4>
      <Field label={t('resolution.abstraction')}><select className={selectClass} value={abstractionKey} disabled={blocked} onChange={event => { setAbstractionKey(event.target.value); setAbstraction(null); setExactDefinitions([]); setView(null); setQueryKey(''); }}><option value="">{t('packages.select')}</option>{abstractions.map(item => <option key={JSON.stringify([item.id, item.revision])} value={JSON.stringify([item.id, item.revision])}>{item.id} · {item.revision} · {item.assurance}</option>)}</select></Field>
      {!abstractions.length && <p className="text-xs text-muted-foreground">{t('resolution.noAbstractions')}</p>}<div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={blocked || !abstractionKey} onClick={() => { void inspect(); }}>{t('resolution.inspect')}</Button>{nextAbstraction && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { void loadMore('abstractions'); }}>{t('packages.loadMore')}</Button>}</div>
      {abstraction && <div className="space-y-4 rounded-lg border border-border p-3"><p className="text-xs leading-relaxed text-muted-foreground">{t('resolution.declaredNotVerdict')}</p><DataTable columns={[t('resolution.scope'), t('resolution.assurance')]} rows={[[abstraction.scope, abstraction.assurance]]} /><details><summary className="cursor-pointer text-sm">{t('resolution.guard')}</summary><div className="mt-3"><FixedRecord value={{ guard: abstraction.guard, assumptions: abstraction.assumptions, preservedInvariants: abstraction.preservedInvariants, readDependencies: abstraction.readDependencies }} /></div></details><details><summary className="cursor-pointer text-sm">{t('resolution.bindingMap')}</summary><div className="mt-3"><FixedRecord value={{ slots: abstraction.slots, parameters: abstraction.parameters, bindingMap: abstraction.bindingMap }} /></div></details><details><summary className="cursor-pointer text-sm">{t('resolution.fallback')}</summary><div className="mt-3"><FixedRecord value={{ fallback: abstraction.fallback, originalDefinitions: abstraction.originalDefinitions, strategy: abstraction.strategy, forwardPlan: abstraction.forwardPlan, evaluationIds: abstraction.evaluationIds }} /></div></details></div>}
      </section>
      <section className="space-y-4 border-t border-border pt-5"><h4 className="text-sm font-semibold">{t('resolution.test')}</h4>
      <Field label={t('resolution.test')}><select className={selectClass} disabled={blocked} value={testKey} onChange={event => setTestKey(event.target.value)}><option value="">{t('packages.select')}</option>{tests.map(item => <option key={JSON.stringify([item.id, item.revision])} value={JSON.stringify([item.id, item.revision])}>{item.id} · {item.revision} · {item.split}</option>)}</select></Field>{nextTest && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { void loadMore('tests'); }}>{t('packages.loadMore')}</Button>}{test && <details><summary className="cursor-pointer text-sm">{t('resolution.testDetails')}</summary><div className="mt-3"><FixedRecord value={test} /></div></details>}
      </section>
      <InvestigationSession key={JSON.stringify([world, incarnation, revision, reference, reload])} disabled={blocked} onChange={setExecution} />
      <form key={JSON.stringify([task.id, task.revision])} className="space-y-4 border-t border-border pt-4" onSubmit={event => { event.preventDefault(); void resolve(event.currentTarget); }}><ValueField name="task.input" label={t('resolution.input')} type={task.inputType} objects={view?.view.objects ?? []} /><p className="text-xs text-muted-foreground">{t('resolution.executionNotice')}</p><Button type="submit" size="sm" disabled={blocked || !view || !abstraction || !test || !execution || !definition}>{t('resolution.submit')}</Button></form>
    </>}
  </div></details>;
}

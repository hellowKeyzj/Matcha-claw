import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '@/stores/world';
import { queryWorld, sameWorld } from '@/stores/world/client';
import type { Budget, Effect, OracleSpec, TaskContract, TaskSummary, ValueType, WorldRef } from '@/types/world';
import { DataTable, Field, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';
import { BudgetFields } from './Materials';
import { TaskResolution } from './TaskResolution';

const effects: Effect[] = ['pure', 'source_read', 'clock_read', 'probabilistic', 'external_write'];
const budgetKeys = ['maxWallTime', 'maxSteps', 'maxSourceReads', 'maxRows', 'maxBytes', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens'] as const;
function validTask(value: unknown, world: WorldRef): value is TaskContract {
  if (!value || typeof value !== 'object') return false;
  const task = value as TaskContract;
  return Boolean(task.world && sameWorld(task.world, world) && typeof task.id === 'string' && task.id.trim()
    && typeof task.goal === 'string' && task.goal.trim() && typeof task.scope === 'string' && task.scope.trim()
    && typeof task.revision === 'string' && /^[1-9]\d*$/.test(task.revision)
    && task.inputType && typeof task.inputType.kind === 'string'
    && Array.isArray(task.hardConstraints) && Array.isArray(task.stopConditions)
    && Array.isArray(task.allowedEffects) && task.allowedEffects.every(effect => effects.includes(effect))
    && new Set(task.allowedEffects).size === task.allowedEffects.length
    && Array.isArray(task.requiredSuites) && task.requiredSuites.length
    && task.requiredSuites.every(id => typeof id === 'string' && id.trim())
    && new Set(task.requiredSuites).size === task.requiredSuites.length
    && task.budget && budgetKeys.every(key => typeof task.budget[key] === 'string' && /^\d+$/.test(task.budget[key]))
    && BigInt(task.budget.maxWallTime) > 0n && BigInt(task.budget.maxSteps) > 0n
    && task.successOracle && ['program', 'source_receipt', 'human'].includes(task.successOracle.kind));
}

export function Tasks() {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const formId = useId();
  const state = useWorldStore();
  const world = state.world;
  const context = state.description?.editingContext;
  const [id, setId] = useState<string>(() => crypto.randomUUID());
  const [revision, setRevision] = useState('1');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('');
  const [input, setInput] = useState<'null' | 'boolean' | 'integer' | 'text' | 'duration'>('text');
  const [maxLength, setMaxLength] = useState('65536');
  const [allowedEffects, setEffects] = useState<Effect[]>([]);
  const [suites, setSuites] = useState('');
  const [oracleKind, setOracleKind] = useState<'program' | 'source_receipt' | ''>('');
  const [program, setProgram] = useState('');
  const [source, setSource] = useState('');
  const [disposition, setDisposition] = useState<'applied' | 'not_applied'>('applied');
  const [budget, setBudget] = useState<Budget>({ maxWallTime: '120000', maxSteps: '100', maxSourceReads: '100', maxRows: '10000', maxBytes: '268435456', maxModelCalls: '10', maxInputTokens: '100000', maxOutputTokens: '20000' });
  const [imported, setImported] = useState<TaskContract | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [read, setRead] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const programs = context?.activationLock.nodes.flatMap(node => node.slot === 'evaluation' && node.trust !== 'ordinary_guest'
    ? node.ports.filter(port => port.direction === 'export').map(port => ({ key: JSON.stringify([node.id, port.name, port.requestSchema, port.resultSchema]), node, port })) : []) ?? [];
  const selectedProgram = programs.find(item => item.key === program);
  const sources = [...new Map(state.connections.map(connection => [connection.sourceId, connection])).values()];
  const selectedSource = sources.find(item => item.sourceId === source);
  const blocked = state.busy || state.operationBusy || Boolean(state.pendingOperation) || state.transferBusy;
  const activeScope = imported?.scope ?? scope;
  useEffect(() => {
    let current = true;
    setTasks([]); setNextCursor(null); setLoading(Boolean(world && activeScope));
    if (world && activeScope) void queryWorld(world, { kind: 'tasks', request: { scope: activeScope, page: { limit: 100, cursor } } }, 'tasks')
      .then(page => {
        if (!current) return;
        if (page.items.some(task => !sameWorld(task.reference.world, world) || task.scope !== activeScope)) throw new Error(t('tasks.loadFailed'));
        setTasks(page.items); setNextCursor(page.nextCursor ?? null);
      }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('tasks.loadFailed')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [world, activeScope, cursor, read, state.description?.revision, t]);
  const submit = async () => {
    if (!world || blocked) return;
    setError(''); setNotice('');
    try {
      let task = imported;
      if (!task) {
        let successOracle: OracleSpec;
        if (oracleKind === 'program' && selectedProgram) successOracle = { kind: 'program', implementation: selectedProgram.node.implementation, fixtureSchema: selectedProgram.port.requestSchema, resultSchema: selectedProgram.port.resultSchema };
        else if (oracleKind === 'source_receipt' && selectedSource) successOracle = { kind: 'source_receipt', sourceId: selectedSource.sourceId, requiredDisposition: disposition };
        else throw new Error(t('tasks.invalid'));
        const inputType: ValueType = input === 'text' ? { kind: input, maxLength: Number(maxLength) } : { kind: input };
        task = { world, id: id.trim(), revision, goal: goal.trim(), scope, inputType, hardConstraints: [], stopConditions: [], allowedEffects, requiredSuites: suites.split('\n').map(item => item.trim()).filter(Boolean), budget, successOracle };
      }
      if (!validTask(task, world)) throw new Error(t('tasks.invalid'));
      const result = await state.command({ kind: 'record_task', request: task });
      setNotice(t(result.kind === 'accepted' ? 'tasks.accepted' : 'tasks.registered'));
      if (result.kind === 'accepted') navigate('/world/settings?tab=operations');
      else setRead(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : t('tasks.invalid')); }
  };
  return <section className="space-y-5 border-t border-border pt-6">
    <header><h2 className="text-base font-semibold tracking-tight">{t('tasks.title')}</h2><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('tasks.hint')}</p></header>
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><Field label={t('tasks.scope')}><select required form={formId} className={selectClass} value={activeScope} disabled={Boolean(imported)} onChange={event => { setScope(event.target.value); setCursor(null); }}><option value="">{t('model.edit.selectScope')}</option>{imported ? <option value={imported.scope}>{imported.scope}</option> : context?.scopes.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field></div><Button type="button" size="sm" variant="outline" disabled={loading || !activeScope} onClick={() => setRead(value => value + 1)}>{t('shell.refresh')}</Button></div>
    {loading && <p className="text-xs text-muted-foreground" role="status">{t('shell.reading')}</p>}
    <DataTable columns={[t('tasks.goal'), t('tasks.revision'), t('tasks.id'), t('tasks.scope')]} rows={tasks.map(task => [task.goal, task.reference.revision, <span className="font-mono text-xs">{task.reference.id}</span>, task.scope])} />
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="ghost" disabled={loading || !cursor} onClick={() => setCursor(null)}>{t('tasks.firstPage')}</Button><Button type="button" size="sm" variant="ghost" disabled={loading || !nextCursor} onClick={() => setCursor(nextCursor)}>{t('tasks.nextPage')}</Button></div>
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('tasks.submit')}</summary>
    <form id={formId} className="mt-5 grid min-w-0 gap-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">{t('tasks.import')}</summary><p className="mt-3 text-xs text-muted-foreground">{t('tasks.importHint')}</p><div className="mt-3"><Field label={t('tasks.contract')}><input className={selectClass} type="file" accept="application/json,.json" disabled={blocked} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file || !world) return;
        setError(''); setNotice('');
        if (file.size > 1_048_576) { setError(t('tasks.invalid')); return; }
        void file.text().then(text => {
          const task: unknown = JSON.parse(text);
          if (!validTask(task, world)) throw new Error(t('tasks.invalid'));
          setImported(task); setCursor(null); setNotice(t('tasks.imported'));
        }).catch(() => setError(t('tasks.invalid')));
      }} /></Field></div></details>
      {imported ? <div className="space-y-3"><details open><summary className="cursor-pointer text-sm">{t('tasks.record')}</summary><div className="mt-3"><FixedRecord value={imported} /></div></details><Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { setImported(null); setNotice(''); setCursor(null); }}>{t('tasks.clearImport')}</Button></div> : <>
        <div className="grid gap-3 sm:grid-cols-2"><TextField label={t('tasks.id')} value={id} onChange={setId} /><TextField label={t('tasks.revision')} value={revision} onChange={setRevision} /><Field label={t('tasks.inputType')}><select className={selectClass} value={input} onChange={event => setInput(event.target.value as typeof input)}>{(['null', 'boolean', 'integer', 'text', 'duration'] as const).map(kind => <option key={kind} value={kind}>{t(`model.valueTypes.${kind}`)}</option>)}</select></Field>{input === 'text' && <TextField label={t('tasks.maxLength')} type="number" value={maxLength} onChange={setMaxLength} />}</div>
        <TextField label={t('tasks.goal')} value={goal} onChange={setGoal} />
        <fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-sm font-medium">{t('tasks.effects')}</legend>{effects.map(effect => <label key={effect} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[hsl(var(--ring))]" checked={allowedEffects.includes(effect)} onChange={event => setEffects(items => event.target.checked ? [...items, effect] : items.filter(item => item !== effect))} />{t(`tasks.effect.${effect}`)}</label>)}</fieldset>
        <Field label={t('tasks.suites')}><textarea required className={`${selectClass} min-h-20 py-2`} value={suites} onChange={event => setSuites(event.target.value)} /></Field>
        <Field label={t('tasks.oracle')}><select required className={selectClass} value={oracleKind} onChange={event => setOracleKind(event.target.value as typeof oracleKind)}><option value="">{t('tasks.chooseOracle')}</option><option value="program">{t('tasks.program')}</option><option value="source_receipt">{t('tasks.sourceReceipt')}</option></select></Field>
        {oracleKind === 'program' && <Field label={t('tasks.program')}><select required className={selectClass} value={program} onChange={event => setProgram(event.target.value)}><option value="">{t('tasks.chooseProgram')}</option>{programs.map(item => <option key={item.key} value={item.key}>{item.node.id} · {item.node.providerId} / {item.port.name}</option>)}</select></Field>}
        {oracleKind === 'source_receipt' && <div className="grid gap-3 sm:grid-cols-2"><Field label={t('tasks.sourceReceipt')}><select required className={selectClass} value={source} onChange={event => setSource(event.target.value)}><option value="">{t('tasks.chooseSource')}</option>{sources.map(item => <option key={item.sourceId} value={item.sourceId}>{item.name} · {item.sourceId}</option>)}</select></Field><Field label={t('tasks.disposition')}><select className={selectClass} value={disposition} onChange={event => setDisposition(event.target.value as typeof disposition)}><option value="applied">{t('tasks.applied')}</option><option value="not_applied">{t('tasks.notApplied')}</option></select></Field></div>}
        <BudgetFields budget={budget} setBudget={setBudget} />
      </>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!world || blocked || (!imported && !context)}>{t('tasks.submit')}</Button><Link className="self-center text-sm underline underline-offset-4" to="/world/settings?tab=operations">{t('shell.records')}</Link></div>
    </form></details>
    {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}{notice && <p className="text-sm" role="status">{notice}</p>}
    <TaskResolution tasks={tasks} />
  </section>;
}

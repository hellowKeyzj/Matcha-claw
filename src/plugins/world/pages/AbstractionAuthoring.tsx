import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { AbstractionDraft, AbstractionRef, AbstractionSlot, Assurance, CompileRequest, CompileSelection, ConcreteBinding, ContextResult, Fallback, OperationAccepted, Parameter, ProposeAbstraction, QueryResult, TaskContract, Value, ValueType } from '@/types/world';
import { ValueField, readValue } from './Actions';
import { CompileSelectionFields } from './CompileSelection';
import { EvaluationReportView } from './Changes';
import { FixedRecord } from './Definitions';
import { definitionName, Field, selectClass, TextField } from './components';
import { useWorldConfirmation } from './WorldConfirmation';

type Binding = { slot: AbstractionSlot; binding: ConcreteBinding };
type Report = Extract<QueryResult, { kind: 'evaluation' }>['result'];

export function AbstractionAuthoring({ task, context, view, disabled, onSubmitted }: {
  task: TaskContract; context: CompileRequest; view: ContextResult | null; disabled: boolean;
  onSubmitted(reference: AbstractionRef, operation: OperationAccepted): void;
}) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const [strategyKey, setStrategyKey] = useState('');
  const [inherited, setInherited] = useState(false);
  const [id, setId] = useState('');
  const [revision, setRevision] = useState('');
  const [originals, setOriginals] = useState<string[]>([]);
  const [bindings, setBindings] = useState<Record<string, Binding | null>>({});
  const [fallbackKind, setFallbackKind] = useState<Fallback['kind'] | ''>('');
  const [concreteKey, setConcreteKey] = useState('');
  const [evidenceKeys, setEvidenceKeys] = useState<string[]>([]);
  const [assurance, setAssurance] = useState<Assurance | ''>('');
  const [reports, setReports] = useState<Report[]>([]);
  const [reportId, setReportId] = useState('');
  const [reading, setReading] = useState(false);
  const [noOp, setNoOp] = useState(false);
  const [reason, setReason] = useState('');
  const [noExtraClaims, setNoExtraClaims] = useState(false);
  const [compile, setCompile] = useState<CompileSelection | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const incarnation = state.description?.incarnation;
  const worldRevision = state.description?.revision;
  const strategies = context.definitions.filter(item => item.body.kind === 'strategy' && sameWorld(item.reference.world, task.world));
  const selected = strategies.find(item => JSON.stringify(item.reference) === strategyKey);
  const strategy = selected?.body.kind === 'strategy' ? selected.body.body : null;
  const concrete = strategies.find(item => JSON.stringify(item.reference) === concreteKey);
  const compatible = strategies.filter(item => item.body.kind === 'strategy' && strategy
    && item.body.body.parameters.length === strategy.parameters.length
    && item.body.body.parameters.every(parameter => strategy.parameters.some(other => JSON.stringify(parameter) === JSON.stringify(other))));
  const selectedDefinitions = context.definitions.filter(item => originals.includes(JSON.stringify(item.reference)) || item === selected);
  const availableEvidence = selectedDefinitions.flatMap(item => item.evidence).filter((item, index, items) => sameWorld(item.world, task.world)
    && items.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === index);
  const evidence = availableEvidence.filter(item => evidenceKeys.includes(JSON.stringify(item)));
  const basis = view && sameWorld(view.view.world, task.world) && view.view.taskId === task.id && view.view.taskRevision === task.revision
    && view.view.scope === task.scope && sameWorld(view.receipt.world, task.world) && view.receipt.releaseId === context.baseRelease && !view.receipt.branchId ? view : null;
  const blocked = disabled || state.loading || state.busy || state.operationBusy || state.transferBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || reading;
  const selection = useMemo(() => ({ task, context, view, disabled, strategyKey, inherited, id, revision, originals, bindings,
    fallbackKind, concreteKey, evidenceKeys, assurance, reports, reportId, reading, noOp, reason, noExtraClaims, compile }),
    [task, context, view, disabled, strategyKey, inherited, id, revision, originals, bindings,
      fallbackKind, concreteKey, evidenceKeys, assurance, reports, reportId, reading, noOp, reason, noExtraClaims, compile]);
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const current = (token: number) => {
    const latest = useWorldStore.getState();
    return mounted.current && token === generation.current && latest.world && sameWorld(latest.world, task.world)
      && latest.description?.status === 'ready' && latest.description.incarnation === incarnation && latest.description.revision === worldRevision
      && latest.description.editingContext === context;
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { setBindings({}); }, [view]);
  const changeStrategy = (key: string) => {
    generation.current++; setReading(false); setStrategyKey(key); setInherited(false); setBindings({}); setOriginals([]);
    setConcreteKey(''); setFallbackKind(''); setEvidenceKeys([]); setReports([]); setReportId(''); setNoExtraClaims(false); setError('');
  };
  const changeBinding = (parameter: Parameter) => setBindings(items => {
    const next = { ...items }; delete next[parameter.id]; return next;
  });
  const checkReferences = (value: Value, type: ValueType): void => {
    if (value.kind === 'object' && (type.kind !== 'object' || !basis?.view.objects.some(item => item.object.id === value.id && item.object.typeId === type.typeId && sameWorld(item.object.world, task.world)))
      || value.kind === 'relation' && (type.kind !== 'relation' || !basis?.view.relations.some(item => item.relation.id === value.id && item.relation.typeId === type.typeId && sameWorld(item.relation.world, task.world)))) throw new Error(t('abstractionAuthor.referenceMissing'));
    if (value.kind === 'list' && type.kind === 'list') value.items.forEach(item => checkReferences(item, type.element));
    if (value.kind === 'record' && type.kind === 'record') type.fields.forEach(field => { if (value.fields[field.name]) checkReferences(value.fields[field.name], field.valueType); });
  };
  const confirmBinding = (parameter: Parameter, form: HTMLFormElement) => {
    if (!basis || blocked) return;
    setError('');
    try {
      const data = new FormData(form);
      const name = `binding.${parameter.id}`;
      if (parameter.optional && !['yes', 'no'].includes(String(data.get(`${name}.omit`)))) throw new Error(t('abstractionAuthor.bindingRequired'));
      if (parameter.optional && data.get(`${name}.omit`) === 'yes') { setBindings(items => ({ ...items, [parameter.id]: null })); return; }
      if (!form.reportValidity()) return;
      const slotId = String(data.get(`${name}.slot`) ?? '').trim();
      if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(slotId) || Object.entries(bindings).some(([id, item]) => id !== parameter.id && item?.slot.id === slotId)) throw new Error(t('abstractionAuthor.slotInvalid'));
      const value = readValue(t, data, `${name}.value`, parameter.valueType, parameter.nullable);
      if (value === undefined) throw new Error(t('abstractionAuthor.bindingRequired'));
      checkReferences(value, parameter.valueType);
      const role = parameter.valueType.kind === 'object' && value.kind === 'object' ? 'object'
        : parameter.valueType.kind === 'relation' && value.kind === 'relation' ? 'relation' : 'input';
      const target: ConcreteBinding['target'] = value.kind === 'object' && role === 'object' ? { kind: 'object', id: value.id }
        : value.kind === 'relation' && role === 'relation' ? { kind: 'relation', id: value.id } : { kind: 'expression', expression: { kind: 'literal', value } };
      const item: Binding = {
        slot: { id: slotId, valueType: parameter.valueType, role, cardinality: { minimum: 1, maximum: 1 } },
        binding: { slotId, parameterId: parameter.id, target, inverseScope: task.scope, dependencies: basis.receipt.actualDependencies, evidence: [] },
      };
      setBindings(items => ({ ...items, [parameter.id]: item }));
    } catch (error) { setError(error instanceof Error ? error.message : t('resolution.failed')); }
  };
  const readReport = async () => {
    if (blocked || !reportId) return;
    const token = ++generation.current;
    setReading(true); setError('');
    try {
      const report = await queryWorld(task.world, { kind: 'evaluation', request: { id: reportId } }, 'evaluation');
      if (!current(token)) return;
      if (report.id !== reportId || !sameWorld(report.world, task.world) || report.execution.kind !== 'completed'
        || report.assurance !== 'tested' || report.verdict !== 'accepted') throw new Error(t('abstractionAuthor.reportInvalid'));
      const suite = await queryWorld(task.world, { kind: 'frozen_suite', request: { world: task.world, id: report.suiteId, revision: report.suiteRevision } }, 'frozen_suite');
      if (!current(token)) return;
      if (!suite || !sameWorld(suite.world, task.world) || suite.taskId !== task.id || suite.taskRevision !== task.revision
        || suite.id !== report.suiteId || suite.revision !== report.suiteRevision) throw new Error(t('abstractionAuthor.reportInvalid'));
      setReports(items => [...items.filter(item => item.id !== report.id), report]);
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
    finally { if (mounted.current && token === generation.current) setReading(false); }
  };
  const submit = async () => {
    if (blocked || !basis || !strategy || !selected || !inherited || !compile || !assurance || !fallbackKind || !noOp || !reason.trim() || !noExtraClaims) return;
    const token = generation.current;
    setError('');
    try {
      if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id.trim()) || !/^[1-9]\d*$/.test(revision) || BigInt(revision) > 18_446_744_073_709_551_615n
        || strategy.parameters.some(parameter => !Object.hasOwn(bindings, parameter.id))) throw new Error(t('abstractionAuthor.bindingRequired'));
      const confirmed = strategy.parameters.flatMap(parameter => { const item = bindings[parameter.id]; return item ? [item] : []; });
      if (strategy.parameters.some(parameter => !parameter.optional && !bindings[parameter.id]) || new Set(confirmed.map(item => item.slot.id)).size !== confirmed.length) throw new Error(t('abstractionAuthor.slotInvalid'));
      let fallback: Fallback;
      if (fallbackKind === 'expand_concrete') {
        if (!concrete || !compatible.includes(concrete)) throw new Error(t('abstractionAuthor.fallbackRequired'));
        fallback = { kind: 'expand_concrete', concreteStrategy: concrete.reference };
      } else if (fallbackKind === 'request_evidence') {
        if (!evidence.length) throw new Error(t('abstractionAuthor.fallbackRequired'));
        fallback = { kind: 'request_evidence', evidence };
      } else fallback = { kind: 'stop' };
      if (assurance === 'tested' && !reports.length) throw new Error(t('abstractionAuthor.reportInvalid'));
      const abstraction: AbstractionDraft = {
        id: id.trim(), revision, strategy: selected.reference, originalDefinitions: selectedDefinitions.map(item => item.reference),
        applicableActions: selectedDefinitions.filter(item => item.body.kind === 'action_contract').map(item => item.reference),
        guard: strategy.guard, forwardPlan: strategy.steps, parameters: strategy.parameters,
        slots: confirmed.map(item => item.slot), bindingMap: { bindings: confirmed.map(item => item.binding) },
        assumptions: [], preservedInvariants: [], assurance, evaluationIds: assurance === 'tested' ? reports.map(item => item.id) : [],
        fallback, readDependencies: basis.receipt.actualDependencies,
      };
      const intent: ProposeAbstraction = { abstraction,
        change: { task: { world: task.world, id: task.id, revision: task.revision }, baseRelease: context.baseRelease, compile,
          operations: [{ kind: 'no_op', reason: reason.trim() }], evidence, cases: strategy.cases } };
      if (!current(token) || !sameWorld(context.world, task.world) || !await confirm(t('abstractionAuthor.confirm'))) return;
      const latestState = useWorldStore.getState();
      if (!current(token) || latestSelection.current !== selection || latestState.loading || latestState.busy || latestState.operationBusy
        || latestState.pending || latestState.pendingOperation || latestState.transferBusy) return;
      const result = await latestState.command({ kind: 'propose_abstraction', request: intent });
      const latest = useWorldStore.getState();
      if (result.kind === 'accepted' && latest.world && sameWorld(latest.world, task.world) && latest.description?.incarnation === incarnation
        && sameWorld(result.result.world, task.world) && result.result.incarnation === incarnation) onSubmitted({ world: task.world, id: abstraction.id, revision: abstraction.revision }, result.result);
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('resolution.failed')); }
  };
  return <details className="min-w-0 border-t border-border pt-4"><summary className="cursor-pointer text-sm font-semibold">{t('abstractionAuthor.title')}</summary><div className="mt-5 space-y-5">
    <p className="text-xs leading-relaxed text-muted-foreground">{t('abstractionAuthor.notice')}</p>
    <fieldset disabled={blocked} className="grid min-w-0 gap-4">
      <div className="grid gap-3 sm:grid-cols-2"><TextField label={t('abstractionAuthor.id')} value={id} onChange={setId} /><TextField label={t('abstractionAuthor.revision')} value={revision} onChange={setRevision} /></div>
      <Field label={t('abstractionAuthor.strategy')}><select className={selectClass} value={strategyKey} onChange={event => changeStrategy(event.target.value)} required><option value="">{t('packages.select')}</option>{strategies.map(item => <option key={JSON.stringify(item.reference)} value={JSON.stringify(item.reference)}>{definitionName(item)} · {item.reference.id} · {item.reference.revision}</option>)}</select></Field>
      {strategy && selected && <>
        <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('abstractionAuthor.inherited')}</summary><div className="mt-3"><FixedRecord value={{ reference: selected.reference, scope: selected.scope, guard: strategy.guard, parameters: strategy.parameters, steps: strategy.steps, budget: strategy.budget, cases: strategy.cases }} /></div></details>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={inherited} onChange={event => setInherited(event.target.checked)} />{t('abstractionAuthor.confirmInheritance')}</label>
        <fieldset className="min-w-0 space-y-3 border-t border-border pt-4"><legend className="pr-2 text-sm font-medium">{t('abstractionAuthor.originals')}</legend><p className="text-xs leading-relaxed text-muted-foreground">{t('abstractionAuthor.originalsNotice')}</p><div className="max-h-64 space-y-3 overflow-y-auto pr-2">{context.definitions.map(item => <label key={JSON.stringify(item.reference)} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 shrink-0" checked={item === selected || originals.includes(JSON.stringify(item.reference))} disabled={item === selected} onChange={event => { const key = JSON.stringify(item.reference); setOriginals(items => event.target.checked ? [...items, key] : items.filter(value => value !== key)); setEvidenceKeys([]); }} /><span className="min-w-0"><span className="block break-words">{definitionName(item)}</span><span className="mt-0.5 block break-all text-xs text-muted-foreground">{item.reference.id} / {item.reference.revision}</span></span></label>)}</div></fieldset>
        <p className="text-xs text-muted-foreground">{t('abstractionAuthor.bindingNotice')}</p>{!basis && <p className="text-sm text-muted-foreground">{t('abstractionAuthor.basisRequired')}</p>}
        {strategy.parameters.map(parameter => {
          const name = `binding.${parameter.id}`;
          return <form key={JSON.stringify([strategyKey, parameter, basis?.receipt.id])} noValidate onSubmit={event => { event.preventDefault(); confirmBinding(parameter, event.currentTarget); }}><fieldset disabled={!basis} className="space-y-3 rounded-lg border border-border p-3" onChange={() => changeBinding(parameter)} onClick={event => { if (event.target instanceof Element && event.target.closest('button[type="button"]')) changeBinding(parameter); }}><legend className="break-all px-1 text-sm font-medium">{parameter.id}</legend><FixedRecord value={parameter} /><Field label={t('abstractionAuthor.slot')}><input className={selectClass} name={`${name}.slot`} /></Field>
            {parameter.optional && <Field label={t('abstractionAuthor.optional')}><select className={selectClass} name={`${name}.omit`} defaultValue=""><option value="">{t('packages.select')}</option><option value="no">{t('abstractionAuthor.bind')}</option><option value="yes">{t('abstractionAuthor.omit')}</option></select></Field>}
            {parameter.valueType.kind === 'relation' ? <Field label={t('abstractionAuthor.target')}><select className={selectClass} name={`${name}.value`} defaultValue=""><option value="">{t('packages.select')}</option>{basis?.view.relations.filter(item => parameter.valueType.kind === 'relation' && item.relation.typeId === parameter.valueType.typeId).map(item => <option key={item.relation.id} value={item.relation.id}>{item.relation.id}</option>)}</select></Field> : <ValueField name={`${name}.value`} label={t('abstractionAuthor.target')} type={parameter.valueType} nullable={parameter.nullable} objects={basis?.view.objects ?? []} />}
            <Button type="submit" size="sm" variant="outline">{t('abstractionAuthor.confirmBinding')}</Button>{Object.hasOwn(bindings, parameter.id) && <div className="space-y-2"><p className="text-xs text-muted-foreground">{t(bindings[parameter.id] ? 'abstractionAuthor.bindingConfirmed' : 'abstractionAuthor.omitConfirmed')}</p>{bindings[parameter.id] && <FixedRecord value={bindings[parameter.id]} />}</div>}
          </fieldset></form>;
        })}
        {!strategy.parameters.length && <p className="text-xs text-muted-foreground">{t('abstractionAuthor.noParameters')}</p>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={noExtraClaims} onChange={event => setNoExtraClaims(event.target.checked)} />{t('abstractionAuthor.noExtraClaims')}</label>
        <section className="space-y-4 border-t border-border pt-5"><h4 className="text-sm font-semibold">{t('resolution.fallback')}</h4>
        <Field label={t('resolution.fallback')}><select required className={selectClass} value={fallbackKind} onChange={event => { setFallbackKind(event.target.value as typeof fallbackKind); setConcreteKey(''); }}><option value="">{t('packages.select')}</option><option value="expand_concrete">{t('abstractionAuthor.expand')}</option><option value="request_evidence">{t('abstractionAuthor.requestEvidence')}</option><option value="stop">{t('abstractionAuthor.stop')}</option></select></Field>
        {fallbackKind === 'expand_concrete' && <Field label={t('abstractionAuthor.concrete')}><select required className={selectClass} value={concreteKey} onChange={event => setConcreteKey(event.target.value)}><option value="">{t('packages.select')}</option>{compatible.map(item => <option key={JSON.stringify(item.reference)} value={JSON.stringify(item.reference)}>{definitionName(item)} · {item.reference.id} · {item.reference.revision}</option>)}</select></Field>}
        {fallbackKind === 'expand_concrete' && concrete && <details><summary className="cursor-pointer text-sm">{t('abstractionAuthor.concrete')}</summary><div className="mt-3"><FixedRecord value={concrete} /></div></details>}
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('abstractionAuthor.evidence')}</legend>{availableEvidence.map(item => <label key={JSON.stringify(item)} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={evidenceKeys.includes(JSON.stringify(item))} onChange={event => { const key = JSON.stringify(item); setEvidenceKeys(items => event.target.checked ? [...items, key] : items.filter(value => value !== key)); }} /><span className="break-all">{item.id} · {item.revision}</span></label>)}{!availableEvidence.length && <p className="text-xs text-muted-foreground">{t('abstractionAuthor.noEvidence')}</p>}</fieldset>
        </section>
        <section className="space-y-4 border-t border-border pt-5"><h4 className="text-sm font-semibold">{t('resolution.assurance')}</h4>
        <Field label={t('resolution.assurance')}><select required className={selectClass} value={assurance} onChange={event => { generation.current++; setReading(false); setAssurance(event.target.value as typeof assurance); setReports([]); }}><option value="">{t('packages.select')}</option>{(['heuristic', 'tested', 'guarded', 'verified'] as const).map(value => <option key={value} value={value}>{t(`abstractionAuthor.assurance.${value}`)}</option>)}</select></Field><p className="text-xs text-muted-foreground">{t('abstractionAuthor.assuranceNotice')}</p>
        {assurance === 'tested' && <div className="space-y-3"><Field label={t('abstractionAuthor.report')}><select className={selectClass} value={reportId} onChange={event => setReportId(event.target.value)}><option value="">{t('packages.select')}</option>{state.evaluations.filter(item => sameWorld(item.world, task.world)).map(item => <option key={item.id} value={item.id}>{item.id} · {t(`changes.execution.${item.execution.kind}`)} · {t(`changes.verdict.${item.verdict}`)}</option>)}</select></Field><Button type="button" size="sm" variant="outline" disabled={!reportId} onClick={() => { void readReport(); }}>{t('abstractionAuthor.readReport')}</Button>{reports.map(report => <div key={report.id} className="space-y-3 rounded-lg border border-border p-3"><EvaluationReportView report={report} /><Button type="button" size="sm" variant="outline" onClick={() => setReports(items => items.filter(item => item.id !== report.id))}>{t('compile.remove')}</Button></div>)}</div>}
        </section>
        <section className="space-y-4 border-t border-border pt-5"><h4 className="text-sm font-semibold">{t('atelier.compile.confirmation')}</h4><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={noOp} onChange={event => setNoOp(event.target.checked)} />{t('abstractionAuthor.noOp')}</label><TextField label={t('abstractionAuthor.reason')} value={reason} onChange={setReason} />
        <CompileSelectionFields context={context} onChange={setCompile} /></section>
      </>}
    </fieldset>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}{reading && <p className="text-sm text-muted-foreground" role="status">{t('shell.reading')}</p>}
    <Button type="button" size="sm" onClick={() => { void submit(); }} disabled={blocked || !basis || !strategy || !inherited || !compile || !id.trim() || !/^[1-9]\d*$/.test(revision) || !fallbackKind || !assurance || !noOp || !reason.trim() || !noExtraClaims || strategy.parameters.some(parameter => !Object.hasOwn(bindings, parameter.id)) || (assurance === 'tested' && !reports.length)}>{t('abstractionAuthor.submit')}</Button>
  </div></details>;
}

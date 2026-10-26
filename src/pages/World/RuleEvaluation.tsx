import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '@/stores/world';
import { queryWorld, sameWorld, WorldRequestError } from '@/stores/world/client';
import type { BranchView, Definition, DefinitionRef, EvaluateRuleRequest, ObjectView, QueryPage, QueryResult, Rule, Value, ValueType, WorldDescription, WorldRef } from '@/types/world';
import { readValue, ValueField } from './Actions';
import { Field, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';

type BranchPage = Extract<QueryResult, { kind: 'branches' }>['result'];
type ObjectRead = { type: DefinitionRef; page: QueryPage };

function objectTypes(type: ValueType, ids: Set<string>, depth = 0): boolean {
  if (depth > 12) return false;
  if (type.kind === 'object') ids.add(type.typeId);
  if (type.kind === 'record') return type.fields.every(field => objectTypes(field.valueType, ids, depth + 1));
  if (type.kind === 'list') return objectTypes(type.element, ids, depth + 1);
  return true;
}

function hasObjects(type: ValueType, value: Value, objects: ObjectView[]): boolean {
  if (value.kind === 'null') return true;
  if (type.kind === 'object' && value.kind === 'object') return objects.some(item => item.object.typeId === type.typeId && item.object.id === value.id);
  if (type.kind === 'list' && value.kind === 'list') return value.items.every(item => hasObjects(type.element, item, objects));
  if (type.kind === 'record' && value.kind === 'record') return type.fields.every(field => {
    const item = value.fields[field.name];
    return item === undefined || hasObjects(field.valueType, item, objects);
  });
  return true;
}

export function RuleEvaluation({ definition }: { definition: Definition }) {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const world = state.world;
  const description = state.description;
  if (!world || !description || description.status !== 'ready' || !sameWorld(world, description.world)
    || !sameWorld(world, definition.reference.world) || definition.body.kind !== 'rule') {
    return <p className="text-sm text-muted-foreground">{t('model.ruleEvaluation.unavailable')}</p>;
  }
  const identity = JSON.stringify([world, description.incarnation, description.revision, description.activeRelease, definition.reference, definition.contentDigest]);
  const blocked = state.loading || state.busy || state.operationBusy || Boolean(state.pending)
    || Boolean(state.pendingOperation) || state.transferBusy;
  return <RuleEvaluationForm key={identity} definition={definition} rule={definition.body.body} world={world} description={description} blocked={blocked} />;
}

function RuleEvaluationForm({ definition, rule, world, description, blocked }: {
  definition: Definition; rule: Rule; world: WorldRef; description: WorldDescription; blocked: boolean;
}) {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const [target, setTarget] = useState('');
  const [branches, setBranches] = useState<BranchPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [branchKey, setBranchKey] = useState('');
  const [scope, setScope] = useState(definition.scope);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unbounded, setUnbounded] = useState(false);
  const [reads, setReads] = useState<ObjectRead[] | null>(null);
  const [fields, setFields] = useState(() => new FormData());
  const [fieldVersion, setFieldVersion] = useState(0);
  const [argumentEpoch, setArgumentEpoch] = useState(0);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<'objects' | 'execute' | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(false);
  const gate = useRef(false);
  const version = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  const current = useCallback(() => {
    const latest = useWorldStore.getState();
    return Boolean(mounted.current && latest.world && sameWorld(latest.world, world)
      && latest.description && sameWorld(latest.description.world, world) && latest.description.status === 'ready'
      && latest.description.incarnation === description.incarnation && latest.description.revision === description.revision
      && latest.description.activeRelease === description.activeRelease);
  }, [world, description]);
  const resetInput = useCallback(() => {
    setScope(definition.scope); setFrom(''); setTo(''); setUnbounded(false);
    setReads(null); setFields(new FormData()); setArgumentEpoch(value => value + 1);
  }, [definition.scope]);
  useEffect(() => {
    if (target !== 'branch') return;
    let active = true;
    version.current++;
    setBranches(null); setBranchKey(''); resetInput(); setError(null); setLoading(true);
    void queryWorld(world, { kind: 'branches', request: { page: { limit: 100, cursor } } }, 'branches')
      .then(page => { if (active && current()) setBranches(page); })
      .catch(cause => { if (active && current()) setError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [target, cursor, refresh, world, current, resetInput]);
  const busy = blocked || loading || Boolean(working) || stale;
  useEffect(() => {
    if (!busy && form.current) setFields(new FormData(form.current));
  }, [fieldVersion, argumentEpoch, busy]);
  const branch = target === 'branch' ? branches?.items.find(item => JSON.stringify([item.id, item.revision]) === branchKey) : undefined;
  const ids = new Set<string>();
  let supported = rule.parameters.every(parameter => objectTypes(parameter.valueType, ids));
  const types: DefinitionRef[] = [];
  for (const id of ids) {
    const references = definition.dependencies.filter(reference => reference.id === id && sameWorld(reference.world, world));
    if (references.length !== 1) supported = false;
    else types.push(references[0]);
  }
  const objects = reads?.flatMap(read => read.page.objects) ?? [];
  const releaseId = target === 'global' ? description.activeRelease : branch?.baseRelease;
  const requestFrom = (data: FormData): EvaluateRuleRequest => {
    if (!supported) throw new Error(t('model.ruleEvaluation.unsupported'));
    if (!releaseId || (target !== 'global' && !branch)) throw new Error(t('model.ruleEvaluation.chooseTarget'));
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || (!unbounded && (!Number.isFinite(end) || end <= start))) throw new Error(t('model.ruleEvaluation.invalidTime'));
    if (!scope.trim()) throw new Error(t('model.ruleEvaluation.scope'));
    const arguments_ = rule.parameters.map((parameter, index) => {
      // Rule evaluation requires Known parameters; top-level omission is not executable.
      const value = readValue(t, data, `argument.${index}`, parameter.valueType, parameter.nullable);
      if (value === undefined) throw new Error(t('model.ruleEvaluation.unsupported'));
      if (!hasObjects(parameter.valueType, value, objects)) throw new Error(t('model.ruleEvaluation.objectsRequired'));
      return { parameterId: parameter.id, value };
    });
    return { releaseId, rule: definition.reference, arguments: arguments_, scope: scope.trim(),
      validTime: { from: new Date(start).toISOString(), to: unbounded ? null : new Date(end).toISOString() },
      ...(branch ? { branch: { world, id: branch.id, revision: branch.revision } } : {}) };
  };
  let preview: EvaluateRuleRequest | null = null;
  let inputError = '';
  try { preview = requestFrom(fields); }
  catch (cause) { inputError = cause instanceof Error ? cause.message : t('model.ruleEvaluation.failed'); }
  const freshBranch = async (selected: BranchView) => {
    const page = await queryWorld(world, { kind: 'branches', request: { page: { limit: 100, cursor } } }, 'branches');
    return page.items.some(item => item.id === selected.id && item.revision === selected.revision
      && item.baseRelease === selected.baseRelease && item.basis.releaseId === selected.basis.releaseId);
  };
  const expireBranch = () => {
    version.current++; setBranches(null); setBranchKey(''); resetInput();
    setError(new Error(t('model.ruleEvaluation.branchChanged')));
  };
  const readObjects = async () => {
    if (busy || gate.current || !releaseId || (target === 'branch' && !branch) || !supported || !types.length || !current()) return;
    gate.current = true;
    const read = ++version.current;
    setWorking('objects'); setReads(null); setFields(new FormData()); setArgumentEpoch(value => value + 1); setError(null);
    try {
      if (branch) {
        const fresh = await freshBranch(branch);
        if (read !== version.current || !current()) return;
        if (!fresh) { expireBranch(); return; }
      }
      const pages = await Promise.all(types.map(async type => ({ type, page: await queryWorld(world, {
        kind: 'objects', request: { world, releaseId, ...(branch ? { branchId: branch.id } : {}),
          // Identity comes from QueryPage.objects; a marker column satisfies the existing nonempty-output contract without reading properties.
          query: { root: { kind: 'objects', typeRef: type, symbol: 'item' }, parameters: [],
            output: [{ name: 'listed', expression: { kind: 'literal', value: { kind: 'boolean', value: true } } }], limit: 100 },
          arguments: [], readMode: { kind: 'authoritative' }, page: { limit: 100, cursor: null } },
      }, 'objects') })));
      if (read !== version.current || !current()) return;
      if (pages.some(({ type, page }) => !sameWorld(page.receipt.world, world) || page.receipt.releaseId !== releaseId
        || (page.receipt.branchId ?? null) !== (branch?.id ?? null)
        || page.objects.some(item => !sameWorld(item.object.world, world) || item.object.typeId !== type.id || item.receiptId !== page.receipt.id))) {
        throw new Error(t('model.ruleEvaluation.mismatch'));
      }
      if (branch) {
        const fresh = await freshBranch(branch);
        if (read !== version.current || !current()) return;
        if (!fresh) { expireBranch(); return; }
      }
      setReads(pages); setArgumentEpoch(value => value + 1);
    } catch (cause) { if (read === version.current && current()) setError(cause); }
    finally { gate.current = false; if (mounted.current) setWorking(null); }
  };
  const execute = async (element: HTMLFormElement) => {
    if (busy || gate.current || !current()) return;
    let request: EvaluateRuleRequest;
    try { request = requestFrom(new FormData(element)); }
    catch (cause) { setError(cause); return; }
    gate.current = true;
    const read = ++version.current;
    setWorking('execute'); setError(null);
    try {
      const fresh = await queryWorld(world, { kind: 'discover', request: { includeCapabilities: true } }, 'discover');
      if (read !== version.current || !current()) return;
      if (!sameWorld(fresh.world, world) || fresh.incarnation !== description.incarnation || fresh.revision !== description.revision
        || fresh.status !== 'ready' || fresh.activeRelease !== description.activeRelease) {
        setStale(true); resetInput(); setBranchKey(''); setBranches(null);
        setError(new Error(t('model.ruleEvaluation.unavailable'))); return;
      }
      if (branch) {
        const unchanged = await freshBranch(branch);
        if (read !== version.current || !current()) return;
        if (!unchanged) { expireBranch(); return; }
      }
      const latest = useWorldStore.getState();
      if (latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
      const result = await latest.command({ kind: 'evaluate_rule', request });
      // Store acceptance refreshes World revision and may unmount this form. The operation still owns the result.
      const after = useWorldStore.getState();
      if (!after.world || !sameWorld(after.world, world) || (after.description && after.description.incarnation !== description.incarnation)) return;
      if (result.kind !== 'accepted' || !sameWorld(result.result.world, world) || result.result.incarnation !== description.incarnation) {
        throw new Error(t('operations.errors.receiptMismatch'));
      }
      navigate('/world/settings?tab=operations');
    } catch (cause) { if (mounted.current && current()) setError(cause); }
    finally { gate.current = false; if (mounted.current) setWorking(null); }
  };
  return <section className="min-w-0 max-w-3xl space-y-5 border-t border-border pt-5" aria-label={t('model.ruleEvaluation.title')}>
    <header className="space-y-2"><h4 className="text-base font-semibold tracking-tight">{t('model.ruleEvaluation.title')}</h4><p className="break-all font-mono text-xs text-muted-foreground">{definition.reference.id} / {definition.reference.revision}</p></header>
    <Field label={t('model.ruleEvaluation.target')}><select className={selectClass} value={target} disabled={busy} onChange={event => {
      version.current++; setTarget(event.target.value); setBranches(null); setBranchKey(''); setCursor(null); resetInput(); setError(null);
    }}><option value="">{t('model.ruleEvaluation.chooseTarget')}</option><option value="global" disabled={!description.activeRelease}>{t('model.ruleEvaluation.global')}</option><option value="branch">{t('model.ruleEvaluation.branch')}</option></select></Field>
    {target === 'branch' && <div className="space-y-3 border-l-2 border-border pl-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('model.ruleEvaluation.branchHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('model.ruleEvaluation.refreshBranches')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !cursor} onClick={() => setCursor(null)}>{t('changes.manage.firstBranches')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !branches?.nextCursor} onClick={() => setCursor(branches?.nextCursor ?? null)}>{t('changes.manage.nextBranches')}</Button>
      </div>
      <Field label={t('changes.manage.branch')}><select className={selectClass} value={branchKey} disabled={busy} onChange={event => {
        version.current++; setBranchKey(event.target.value); resetInput(); setError(null);
      }}><option value="">{t('changes.manage.chooseBranch')}</option>{branches?.items.map(item => <option key={JSON.stringify([item.id, item.revision])} value={JSON.stringify([item.id, item.revision])}>{item.id} · {item.revision}</option>)}</select></Field>
      {branch && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('changes.manage.branchBasis')}</summary><div className="mt-3"><FixedRecord value={branch} /></div></details>}
    </div>}
    {!supported && <p className="text-sm text-destructive" role="alert">{t('model.ruleEvaluation.unsupported')}</p>}
    {types.length > 0 && <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('model.ruleEvaluation.objectsHint')}</p>
      <Button type="button" size="sm" variant="outline" disabled={busy || !supported || !releaseId || (target === 'branch' && !branch)} onClick={() => { void readObjects(); }}>{t('model.ruleEvaluation.loadObjects')}</Button>
      {reads?.map(read => <div key={JSON.stringify(read.type)} className="space-y-2">
        {!read.page.objects.length && <p className="break-words text-xs text-muted-foreground">{read.type.id} · {t('model.ruleEvaluation.noObjects')}</p>}
        <details><summary className="cursor-pointer break-words text-xs text-muted-foreground">{t('model.ruleEvaluation.queryEvidence')} · {read.type.id}</summary><div className="mt-3"><FixedRecord value={read.page.receipt} /></div></details>
      </div>)}
      {branch && reads && <p className="text-xs leading-relaxed text-muted-foreground">{t('model.ruleEvaluation.queryLimit')}</p>}
      {!reads && <p className="text-xs text-muted-foreground">{t('model.ruleEvaluation.objectsRequired')}</p>}
    </div>}
    <form ref={form} className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void execute(event.currentTarget); }}>
      <fieldset disabled={busy || !supported || !releaseId} className="min-w-0 space-y-4 border-t border-border pt-5">
        <TextField label={t('model.ruleEvaluation.scope')} value={scope} onChange={setScope} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t('model.ruleEvaluation.from')} type="datetime-local" value={from} onChange={setFrom} />
          {!unbounded && <TextField label={t('model.ruleEvaluation.to')} type="datetime-local" value={to} onChange={setTo} />}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unbounded} onChange={event => setUnbounded(event.target.checked)} />{t('model.ruleEvaluation.unbounded')}</label>
        <fieldset key={argumentEpoch} className="grid min-w-0 gap-3" onChange={() => setFieldVersion(value => value + 1)} onClick={event => {
          if (event.target instanceof Element && event.target.closest('button')) setFieldVersion(value => value + 1);
        }}>
          <legend className="mb-3 text-sm font-medium">{t('model.content.parameters')}</legend>
          {rule.parameters.map((parameter, index) => <div key={parameter.id} className="min-w-0 border-b border-border pb-4">
            <ValueField name={`argument.${index}`} label={parameter.id} type={parameter.valueType} nullable={parameter.nullable} objects={objects} />
          </div>)}
        </fieldset>
      </fieldset>
      <details><summary className="cursor-pointer text-sm font-medium">{t('model.ruleEvaluation.input')}</summary><div className="mt-3">{preview ? <FixedRecord value={preview} /> : <p className="text-xs text-muted-foreground">{inputError}</p>}</div></details>
      <p className="border-l-2 border-[hsl(var(--ring))] pl-3 text-xs leading-relaxed text-muted-foreground">{t('model.ruleEvaluation.description')}</p>
      <div className="flex flex-wrap items-center gap-3"><Button size="sm" disabled={busy || !preview || !supported}>{t('model.ruleEvaluation.execute')}</Button><Button type="button" size="sm" variant="ghost" onClick={() => navigate('/world/settings?tab=operations')}>{t('shell.records')}</Button></div>
    </form>
    {(loading || working) && <p className="text-xs text-muted-foreground" role="status">{t('shell.reading')}</p>}
    {error != null && <div className="space-y-2" role="alert"><p className="break-words text-sm text-destructive">{error instanceof Error ? error.message : t('model.ruleEvaluation.failed')}</p>{error instanceof WorldRequestError && <details><summary className="cursor-pointer text-xs">{t('shell.diagnostic')}</summary><div className="mt-3"><FixedRecord value={error.failure} /></div></details>}</div>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t('model.ruleEvaluation.accepted')}</p>
  </section>;
}

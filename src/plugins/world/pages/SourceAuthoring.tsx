import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { BranchRef, BranchSourceContext, ConnectionView, DefinitionRef, MappedField, QueryResult, SchemaMapping, WorldCommand } from '@/types/world';
import { DataTable, Field, selectClass } from './components';
import { FixedRecord } from './Definitions';
import { useWorldConfirmation } from './WorldConfirmation';

type SourceEntry = BranchSourceContext['bindings'][number];
type AuthoringCommand = Extract<WorldCommand, { kind: 'set_branch_mapping' | 'approve_branch_source_authority' }>;
const missingOptions: MappedField['missing'][] = ['unknown', 'skip', 'reject'];
const nullOptions: MappedField['null'][] = ['known_null', 'reject'];
const formulaOptions: MappedField['formula'][] = ['require_current_cache', 'preserve_only', 'reject'];
const deleteOptions: SchemaMapping['delete'][] = ['withdraw_source_claims', 'mark_unavailable', 'require_reconcile'];

function sameReference(left: DefinitionRef, right: DefinitionRef) {
  return sameWorld(left.world, right.world) && left.id === right.id && left.revision === right.revision;
}

function initialMapping(entry: SourceEntry): SchemaMapping | null {
  if (entry.mapping) return entry.mapping;
  const binding = entry.binding.body;
  const targets = entry.targets.filter(target => target.reference.id === binding.identityMapping.typeId
    && (target.body.kind === 'object_type' || target.body.kind === 'relation_type'));
  if (targets.length !== 1) return null;
  const target = targets[0];
  const fieldByName = (name: string) => {
    const fields = entry.schema.fields.filter(field => field.name === name
      && field.readable && binding.selectedFields.includes(field.id));
    return fields.length === 1 ? fields[0] : null;
  };
  const keyFields: SchemaMapping['keyFields'] = [];
  for (const name of binding.identityMapping.keyFields) {
    const field = fieldByName(name);
    if (!field || keyFields.includes(field.id)) return null;
    keyFields.push(field.id);
  }
  if (!keyFields.length) return null;
  const fields: MappedField[] = [];
  for (const mapped of binding.fieldMapping) {
    const source = fieldByName(mapped.sourceField);
    const property = entry.targets.find(item => sameReference(item.reference, mapped.property)
      && item.body.kind === 'property');
    if (!source || !property) return null;
    fields.push({ sourceField: source.id, property: property.reference,
      transform: mapped.transform ?? { kind: 'identity' }, missing: 'reject', null: 'reject', formula: 'reject' });
  }
  const roles: SchemaMapping['relations'][number]['roles'] = [];
  for (const mapped of binding.roleMapping) {
    const field = fieldByName(mapped.sourceField);
    if (!field || target.body.kind !== 'relation_type'
      || !target.body.body.roles.some(role => role.id === mapped.role)) return null;
    roles.push({ role: mapped.role, sourceField: field.id,
      targetSource: mapped.targetSourceId, targetNamespace: mapped.targetNamespace });
  }
  return { reference: binding.mapping, schema: entry.schema.reference, identityRule: binding.identityRule,
    typeRef: target.reference, keyFields, fields,
    relations: roles.length ? [{ relationType: target.reference, roles }] : [], delete: 'require_reconcile' };
}

function BindingEditor({ branch, entry, blocked, submit }: {
  branch: BranchRef; entry: SourceEntry; blocked: boolean;
  submit(command: AuthoringCommand, message: string, current: () => boolean): Promise<void>;
}) {
  const { t } = useTranslation('world');
  const [mapping, setMapping] = useState(() => initialMapping(entry));
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const latest = useRef({ branch, entry, mapping, blocked });
  latest.current = { branch, entry, mapping, blocked };
  const submitConfirmed = (command: AuthoringCommand, message: string) => {
    const token = version.current;
    return submit(command, message, () => token === version.current && !latest.current.blocked
      && latest.current.branch === branch && latest.current.entry === entry && latest.current.mapping === mapping);
  };
  const saved = Boolean(entry.mapping);
  const authority = entry.authority.authority;
  const approved = entry.authority.kind === 'approved';
  const updateField = (index: number, change: Partial<Pick<MappedField, 'missing' | 'null' | 'formula'>>) => {
    setMapping(value => value && ({ ...value, fields: value.fields.map((field, at) => at === index ? { ...field, ...change } : field) }));
  };
  return <div className="space-y-5">
    <details><summary className="cursor-pointer text-sm">{t('connections.authoring.model')}</summary><div className="mt-3 space-y-4"><FixedRecord value={entry.binding} /><FixedRecord value={entry.targets} /></div></details>
    <div className="space-y-3">
      <h5 className="text-sm font-semibold">{t('connections.discovery.title')}</h5>
      <FixedRecord value={{ reference: entry.schema.reference, sourceId: entry.schema.sourceId, incarnation: entry.schema.incarnation, namespace: entry.schema.namespace, observedAt: entry.schema.observedAt }} />
      <p className={`text-xs ${entry.schema.complete ? 'text-muted-foreground' : 'text-destructive'}`}>{t(entry.schema.complete ? 'connections.discovery.complete' : 'connections.discovery.incomplete')}</p>
      <DataTable columns={[t('connections.discovery.fields'), t('connections.resource.fieldType'), t('connections.discovery.flags')]} rows={entry.schema.fields.map(field => [<span className="break-all">{field.name}<span className="block font-mono text-xs text-muted-foreground">{field.id}</span></span>, <FixedRecord value={field.valueType} />, <FixedRecord value={{ nullable: field.nullable, optional: field.optional, readable: field.readable, writable: field.writable }} />])} empty={t('connections.discovery.noFields')} />
      <DataTable columns={[t('connections.discovery.keys'), t('connections.details')]} rows={entry.schema.keys.map(key => [key.fields.join(' / '), key.basis])} empty={t('connections.discovery.noKeys')} />
    </div>
    <form className="space-y-4 border-t border-border pt-4" onSubmit={event => {
      event.preventDefault();
      if (blocked || saved || !mapping) return;
      const command: AuthoringCommand = { kind: 'set_branch_mapping', request: { branch, binding: entry.binding.reference, mapping } };
      void submitConfirmed(command, t('connections.authoring.confirmMapping', { branch: branch.id, revision: branch.revision, binding: entry.binding.reference.id }));
    }}>
      <h5 className="text-sm font-semibold">{t('connections.authoring.mapping')}</h5>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(saved ? 'connections.authoring.savedMapping' : 'connections.authoring.mappingHint')}</p>
      {mapping ? <fieldset disabled={blocked || saved} className="min-w-0 space-y-4">
        <FixedRecord value={{ reference: mapping.reference, schema: mapping.schema, identityRule: mapping.identityRule, typeRef: mapping.typeRef }} />
        <div><h6 className="mb-2 text-xs font-medium">{t('connections.discovery.keys')}</h6><FixedRecord value={mapping.keyFields} /></div>
        {mapping.fields.map((field, index) => <div key={JSON.stringify([field.sourceField, field.property])} className="space-y-3 rounded-lg border border-border p-3">
          <FixedRecord value={{ sourceField: field.sourceField, property: field.property, transform: field.transform }} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('connections.authoring.missing')}><select className={selectClass} value={field.missing} onChange={event => { const value = missingOptions.find(option => option === event.target.value); if (value) updateField(index, { missing: value }); }}>{missingOptions.map(value => <option key={value} value={value}>{t(`connections.authoring.policy.${value}`)}</option>)}</select></Field>
            <Field label={t('connections.authoring.null')}><select className={selectClass} value={field.null} onChange={event => { const value = nullOptions.find(option => option === event.target.value); if (value) updateField(index, { null: value }); }}>{nullOptions.map(value => <option key={value} value={value}>{t(`connections.authoring.policy.${value}`)}</option>)}</select></Field>
            <Field label={t('connections.authoring.formula')}><select className={selectClass} value={field.formula} onChange={event => { const value = formulaOptions.find(option => option === event.target.value); if (value) updateField(index, { formula: value }); }}>{formulaOptions.map(value => <option key={value} value={value}>{t(`connections.authoring.policy.${value}`)}</option>)}</select></Field>
          </div>
        </div>)}
        {mapping.relations.length > 0 && <div className="space-y-2"><h6 className="text-xs font-medium">{t('connections.authoring.roles')}</h6><FixedRecord value={mapping.relations} /></div>}
        <Field label={t('connections.authoring.delete')}><select className={selectClass} value={mapping.delete} onChange={event => { const value = deleteOptions.find(option => option === event.target.value); if (value) setMapping(current => current && ({ ...current, delete: value })); }}>{deleteOptions.map(value => <option key={value} value={value}>{t(`connections.authoring.policy.${value}`)}</option>)}</select></Field>
      </fieldset> : <p className="text-sm text-destructive" role="alert">{t('connections.authoring.invalidMapping')}</p>}
      {!saved && <Button size="sm" disabled={blocked || !mapping}>{t('connections.authoring.saveMapping')}</Button>}
    </form>
    <section className="space-y-3 border-t border-border pt-4">
      <h5 className="text-sm font-semibold">{t('connections.authoring.authority')}</h5>
      <p className={`text-sm ${approved ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}>{t(approved ? 'connections.authoring.approved' : 'connections.authoring.draft')}</p>
      <FixedRecord value={authority} />
      {!approved && <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => {
        if (blocked) return;
        const command: AuthoringCommand = { kind: 'approve_branch_source_authority', request: { branch, authority } };
        void submitConfirmed(command, t('connections.authoring.confirmAuthority', { branch: branch.id, revision: branch.revision, binding: entry.binding.reference.id }));
      }}>{t('connections.authoring.approve')}</Button>}
    </section>
  </div>;
}

export function SourceAuthoring({ connection }: { connection: ConnectionView }) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const navigate = useNavigate();
  const state = useWorldStore();
  const world = state.world;
  const description = state.description;
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Extract<QueryResult, { kind: 'branches' }>['result'] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [branchKey, setBranchKey] = useState('');
  const [bindingKey, setBindingKey] = useState('');
  const [context, setContext] = useState<BranchSourceContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const ready = Boolean(world && description && sameWorld(world, description.world)
    && description.status === 'ready' && connection.configured);
  const blocked = loading || reading || writing || state.loading || state.busy || state.operationBusy
    || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const branch = branches?.items.find(item => JSON.stringify([item.id, item.revision]) === branchKey);
  const entries = context?.bindings.filter(entry => entry.binding.body.sourceId === connection.sourceId
    && entry.binding.body.connectionId === connection.id) ?? [];
  const entry = entries.find(item => JSON.stringify(item.binding.reference) === bindingKey);
  const current = () => {
    const latest = useWorldStore.getState();
    return Boolean(world && description && latest.world && sameWorld(latest.world, world)
      && latest.description && sameWorld(latest.description.world, world)
      && latest.description.incarnation === description.incarnation && latest.description.status === 'ready'
      && latest.connections.some(item => item.id === connection.id && item.sourceId === connection.sourceId
        && item.revision === connection.revision && item.connector === connection.connector && item.configured));
  };
  useEffect(() => {
    let active = true;
    version.current++;
    setBranches(null); setBranchKey(''); setContext(null); setBindingKey(''); setError('');
    setReading(false); setWriting(false);
    setLoading(Boolean(open && ready && world));
    if (open && ready && world) void queryWorld(world, { kind: 'branches', request: { page: { limit: 100, cursor } } }, 'branches')
      .then(page => { if (active && current()) setBranches(page); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : t('connections.authoring.failed')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, ready, world, description?.incarnation, connection.id, connection.revision, connection.sourceId, cursor, refresh, t]);
  const readContext = async () => {
    if (!world || !branch || blocked || !current()) return;
    const reference: BranchRef = { world, id: branch.id, revision: branch.revision };
    const read = ++version.current;
    setReading(true); setContext(null); setBindingKey(''); setError('');
    try {
      const value = await queryWorld(world, { kind: 'branch_source_context', request: { branch: reference } }, 'branch_source_context');
      if (read !== version.current) return;
      if (!current() || !sameReference(value.branch, reference) || value.status !== 'proposed'
        || value.bindings.some(item => !sameWorld(item.binding.reference.world, world)
          || !sameWorld(item.schema.reference.world, world)
          || item.schema.sourceId !== item.binding.body.sourceId
          || !sameReference(item.schema.reference, item.binding.body.schema)
          || item.targets.some(target => !sameWorld(target.reference.world, world))
          || (item.mapping && (!sameReference(item.mapping.reference, item.binding.body.mapping)
            || !sameReference(item.mapping.schema, item.schema.reference)))
          || !sameWorld(item.authority.authority.world, world)
          || !sameReference(item.authority.authority.binding, item.binding.reference)
          || item.authority.authority.sourceId !== item.binding.body.sourceId)) {
        throw new Error(t('connections.authoring.mismatch'));
      }
      setContext(value);
    } catch (error) {
      if (read === version.current) setError(error instanceof Error ? error.message : t('connections.authoring.failed'));
    } finally { if (read === version.current) setReading(false); }
  };
  const submit = async (command: AuthoringCommand, message: string, editorCurrent: () => boolean) => {
    const before = useWorldStore.getState();
    if (!world || !description || !context || !branch || !entry || blocked || !current()
      || before.loading || before.busy || before.operationBusy || before.pending || before.pendingOperation || before.transferBusy
      || before.description?.revision !== description.revision
      || !sameReference(context.branch, { world, id: branch.id, revision: branch.revision })
      || !sameReference(command.request.branch, context.branch)) return;
    const token = version.current;
    if (!await confirm(message) || token !== version.current || !editorCurrent() || !current()) return;
    const latest = useWorldStore.getState();
    if (latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy
      || latest.description?.revision !== description.revision) return;
    const read = ++version.current;
    setWriting(true); setError('');
    try {
      const result = await latest.command(command);
      if (read !== version.current) return;
      if (!current()) return;
      if (result.kind !== 'accepted' || !sameWorld(result.result.world, world)
        || result.result.incarnation !== description.incarnation) {
        throw new Error(t('operations.errors.receiptMismatch'));
      }
      setContext(null); setBindingKey('');
      navigate('/world/settings?tab=operations');
    } catch (error) {
      if (read === version.current && current()) {
        setContext(null); setBindingKey('');
        setError(error instanceof Error ? error.message : t('connections.authoring.failed'));
      }
    } finally { if (read === version.current) setWriting(false); }
  };
  return <details className="space-y-4 border-t border-border pt-4" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-semibold">{t('connections.authoring.title')}</summary>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('connections.authoring.hint')}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={!ready || blocked} onClick={() => setRefresh(value => value + 1)}>{t('shell.refresh')}</Button>
      <Button type="button" size="sm" variant="outline" disabled={!ready || blocked || !cursor} onClick={() => setCursor(null)}>{t('changes.manage.firstBranches')}</Button>
      <Button type="button" size="sm" variant="outline" disabled={!ready || blocked || !branches?.nextCursor} onClick={() => setCursor(branches?.nextCursor ?? null)}>{t('changes.manage.nextBranches')}</Button>
    </div>
    <Field label={t('changes.manage.branch')}><select className={selectClass} value={branchKey} disabled={!ready || blocked} onChange={event => { version.current++; setBranchKey(event.target.value); setContext(null); setBindingKey(''); setError(''); }}><option value="">{t('changes.manage.chooseBranch')}</option>{branches?.items.map(item => <option key={JSON.stringify([item.id, item.revision])} value={JSON.stringify([item.id, item.revision])}>{item.id} · {item.revision}</option>)}</select></Field>
    {branch && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('changes.manage.branchBasis')}</summary><div className="mt-3"><FixedRecord value={branch} /></div></details>}
    <Button type="button" size="sm" variant="outline" disabled={!ready || blocked || !branch} onClick={() => { void readContext(); }}>{t('connections.authoring.read')}</Button>
    {(loading || reading) && <p className="text-xs text-muted-foreground" role="status">{t('shell.reading')}</p>}
    {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
    {context && <div className="space-y-4">
      <FixedRecord value={{ branch: context.branch, status: context.status }} />
      {entries.length ? <Field label={t('model.kinds.source_binding')}><select className={selectClass} value={bindingKey} disabled={blocked} onChange={event => { version.current++; setBindingKey(event.target.value); }}><option value="">{t('connections.authoring.chooseBinding')}</option>{entries.map(item => <option key={JSON.stringify(item.binding.reference)} value={JSON.stringify(item.binding.reference)}>{item.binding.reference.id} · {item.binding.reference.revision} · {item.binding.body.resource}</option>)}</select></Field> : <p className="text-sm text-muted-foreground">{t('connections.authoring.noBindings')}</p>}
      {entry && <BindingEditor key={JSON.stringify([refresh, context.branch, entry])} branch={context.branch} entry={entry} blocked={blocked} submit={submit} />}
    </div>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t('connections.authoring.conflict')}</p>
  </details>;
}

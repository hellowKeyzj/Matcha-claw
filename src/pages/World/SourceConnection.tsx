import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Database, Globe2, Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '@/stores/world';
import { queryWorld, sameWorld, WorldRequestError } from '@/stores/world/client';
import { WORLD_SOURCE_CONNECTORS, type ConnectionRevision, type ConnectionView, type InstalledRecord, type PostgresSnapshotSlot, type QueryResult, type SchemaDiscovery, type SourceCapabilities, type SourceConnectionConfig, type ValueType } from '@/types/world';
import { DataTable, Field, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';
import { SourceAuthoring } from './SourceAuthoring';
import { SourceSync } from './SourceSync';

export function SourceDiscovery({ connection }: { connection: ConnectionView }) {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const state = useWorldStore();
  const [resource, setResource] = useState('');
  const [schema, setSchema] = useState<SchemaDiscovery | null | undefined>(undefined);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const world = state.world;
  const description = state.description;
  const blocked = reading || state.loading || state.busy || state.operationBusy
    || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const ready = world && description && sameWorld(description.world, world)
    && description.status === 'ready' && connection.configured;
  const current = () => {
    const latest = useWorldStore.getState();
    return Boolean(world && description && latest.world && sameWorld(latest.world, world)
      && latest.description && sameWorld(latest.description.world, world)
      && latest.description.status === 'ready'
      && latest.description.incarnation === description.incarnation
      && latest.connections.some(item => item.id === connection.id
        && item.revision === connection.revision && item.sourceId === connection.sourceId
        && item.connector === connection.connector && item.configured));
  };
  const load = async () => {
    if (!world) throw new Error(t('connections.discovery.mismatch'));
    const value = await queryWorld(world, {
      kind: 'source_schema', request: { sourceId: connection.sourceId },
    }, 'source_schema');
    if (value && (!sameWorld(value.reference.world, world) || value.sourceId !== connection.sourceId)) {
      throw new Error(t('connections.discovery.mismatch'));
    }
    return value;
  };
  const run = async (discover: boolean) => {
    if (!ready || blocked || !world || !current()
      || (discover && (!resource.trim() || resource.trim().length > 256))) return;
    const read = ++version.current;
    setReading(true); setSchema(undefined); setError('');
    try {
      const value = await load();
      if (read !== version.current) return;
      if (!current()) throw new Error(t('connections.discovery.conflict'));
      setSchema(value);
      if (!discover) return;
      const revision = value ? BigInt(value.reference.revision) + 1n : 1n;
      if (revision > 9_223_372_036_854_775_807n) throw new Error(t('connections.discovery.conflict'));
      const latest = useWorldStore.getState();
      if (latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
      const result = await latest.command({ kind: 'discover_schema', request: {
        connection: connection.id, connectionRevision: connection.revision, resource: resource.trim(),
        targetSchema: { world, id: value?.reference.id ?? crypto.randomUUID(), revision: String(revision) },
        expectedSchema: value?.reference ?? null, branch: null,
      } });
      if (read !== version.current) return;
      if (result.kind !== 'accepted' || !sameWorld(result.result.world, world)) {
        throw new Error(t('operations.errors.receiptMismatch'));
      }
      setPending(true);
      navigate('/world/settings?tab=operations');
    } catch (error) {
      if (read !== version.current) return;
      setSchema(undefined);
      const details = error instanceof WorldRequestError ? error.failure.details : null;
      const operation = details?.kind === 'operation' ? details.failure : null;
      const source = operation?.kind === 'source' ? operation.failure : null;
      const conflict = details?.kind === 'revision_conflict' || operation?.kind === 'revision_conflict'
        || (operation?.kind === 'mapping' && operation.failure.kind === 'revision_mismatch')
        || source?.kind === 'revision_conflict'
        || (source?.kind === 'mapping' && source.failure.kind === 'revision_mismatch');
      setError(conflict ? t('connections.discovery.conflict')
        : error instanceof Error ? error.message : t('connections.discovery.failed'));
    } finally {
      if (read === version.current) setReading(false);
    }
  };
  return <div className="space-y-4">
    <details className="space-y-4 border-t border-[hsl(var(--shell-border))] pt-4">
      <summary className="cursor-pointer text-sm font-semibold">{t('connections.discovery.title')}</summary>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('connections.discovery.hint')}</p>
    <div className="space-y-3">
      <Button type="button" variant="outline" size="sm" disabled={!ready || blocked} onClick={() => { void run(false); }}>{t('connections.discovery.read')}</Button>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(true); }}>
        <TextField label={t('connections.discovery.resource')} value={resource} onChange={setResource} />
        <Button type="submit" size="sm" disabled={!ready || blocked || !resource.trim() || resource.trim().length > 256}>{t('connections.discovery.discover')}</Button>
      </form>
    </div>
    {reading && <p className="text-sm text-muted-foreground" role="status">{t('shell.reading')}</p>}
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {schema === null ? <p className="text-sm text-muted-foreground">{t('connections.discovery.noSchema')}</p> : schema && <div className="space-y-4">
      <FixedRecord value={{ reference: schema.reference, sourceId: schema.sourceId, namespace: schema.namespace, incarnation: schema.incarnation, observedAt: schema.observedAt }} />
      <p className={`text-sm ${schema.complete ? 'text-muted-foreground' : 'text-destructive'}`}>{t(schema.complete ? 'connections.discovery.complete' : 'connections.discovery.incomplete')}</p>
      <DataTable columns={[t('connections.discovery.fields'), t('connections.resource.fieldType'), t('connections.discovery.flags')]} rows={schema.fields.map(field => [<span className="break-all">{field.name}<span className="mt-1 block font-mono text-xs text-muted-foreground">{field.id}</span></span>, <FixedRecord value={field.valueType} />, <FixedRecord value={{ nullable: field.nullable, optional: field.optional, readable: field.readable, writable: field.writable }} />])} empty={t('connections.discovery.noFields')} />
      <DataTable columns={[t('connections.discovery.keys'), t('connections.details')]} rows={schema.keys.map(key => [<span className="break-all">{key.fields.join(' / ')}</span>, key.basis])} empty={t('connections.discovery.noKeys')} />
    </div>}
    {pending && <p className="text-sm text-muted-foreground" role="status">{t('connections.discovery.pending')}</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">{t('connections.discovery.conflict')}</p>
    <Link className="inline-block text-xs underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to="/world/settings?tab=operations">{t('shell.openRecords')}</Link>
    </details>
    <SourceAuthoring connection={connection} />
    <SourceSync connection={connection} />
  </div>;
}

export function ConnectionForm() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const [kind, setKind] = useState<SourceConnectionConfig['kind']>('postgres');
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('');
  const [schema, setSchema] = useState('public');
  const [resource, setResource] = useState('');
  const [field, setField] = useState('');
  const [column, setColumn] = useState('');
  const [type, setType] = useState<'text' | 'integer' | 'boolean'>('text');
  const [origin, setOrigin] = useState('');
  const [path, setPath] = useState('');
  const [schemaPath, setSchemaPath] = useState('');
  const [rowsPointer, setRowsPointer] = useState('');
  const [user, setUser] = useState('');
  const [secret, setSecret] = useState('');
  const [scope, setScope] = useState('');
  const [provider, setProvider] = useState('');
  const [packages, setPackages] = useState<InstalledRecord[]>([]);
  const [loading, setLoading] = useState(Boolean(state.world));
  const [snapshot, setSnapshot] = useState<SourceCapabilities['snapshot']>('none');
  const [logical, setLogical] = useState(false);
  const [slot, setSlot] = useState('');
  const [snapshotSlot, setSnapshotSlot] = useState<PostgresSnapshotSlot | ''>('');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const world = state.world;
    if (!world) return;
    void (async () => {
      const records: InstalledRecord[] = [];
      let cursor: string | null = null;
      do {
        const page: Extract<QueryResult, { kind: 'packages' }>['result'] = await queryWorld(world, { kind: 'packages', request: { page: { limit: 100, cursor } } }, 'packages');
        if (!current) return;
        if (page.items.some(item => !sameWorld(item.world, world))) throw new Error(t('connections.catalogWorldMismatch'));
        records.push(...page.items); cursor = page.nextCursor ?? null;
      } while (cursor);
      setPackages(records);
    })().catch(error => { if (current) setError(error instanceof Error ? error.message : t('connections.catalogFailed')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [state.world, t]);
  const catalog = WORLD_SOURCE_CONNECTORS.find(item => item.driver === kind);
  const readContract = catalog?.readContract ?? WORLD_SOURCE_CONNECTORS[0].readContract;
  const providers = packages.flatMap(record => record.manifest.provides.flatMap(item => {
    const artifact = record.manifest.artifacts.find(artifact => artifact.id === item.artifactId);
    const contract = item.contracts.find(contract => contract.id === readContract.id
      && contract.version === readContract.version && contract.schemaDigest === readContract.schemaDigest);
    if (item.slot !== 'connector' || !artifact || !contract) return [];
    const matches = kind === 'plugin'
      ? (artifact.runtime === 'wasm_component' && artifact.entrypoint.kind === 'wasm')
        || (artifact.runtime === 'trusted_process' && artifact.entrypoint.kind === 'process')
      : artifact.runtime === 'native' && artifact.entrypoint.kind === 'native'
        && artifact.entrypoint.registration === catalog?.registration;
    return matches ? [{ key: JSON.stringify([record.installId, item.providerId, item.artifactId, item.slot]), id: item.providerId, contract, label: record.manifest.identity.id, details: { installId: record.installId, providerId: item.providerId, artifactId: item.artifactId, slot: item.slot, contract } }] : [];
  }));
  const selectedProvider = providers.find(item => item.key === provider);
  const ambiguous = selectedProvider && providers.filter(item => item.id === selectedProvider.id).length > 1;
  const scopes = state.description?.editingContext?.scopes ?? [];
  const ready = state.world && state.description?.status === 'ready' && sameWorld(state.world, state.description.world);
  const blocked = state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const canSave = ready && !blocked && !loading && selectedProvider && scopes.some(item => item.id === scope)
    && !(kind === 'postgres' && logical && (!snapshotSlot || !/^[a-z0-9_]{1,63}$/.test(slot)));
  const SourceIcon = kind === 'postgres' ? Database : kind === 'http_json' ? Globe2 : Package;
  return <form className="min-w-0" onSubmit={event => {
    event.preventDefault(); if (!canSave || !state.world || !selectedProvider) return; setError('');
    const valueType: ValueType = type === 'text' ? { kind: 'text', maxLength: 65536 } : { kind: type };
    const capabilities: SourceCapabilities = {
      contract: selectedProvider.contract, snapshot: kind === 'postgres' && logical ? 'transactional' : snapshot,
      historicalRead: false, changeStream: kind === 'postgres' && logical ? 'resumable_transactions' : 'none', conditionalWrite: false, idempotencyKey: false,
      inspectEffect: false, predicatePushdown: false, orderingPushdown: false, aggregatePushdown: false,
    };
    const common = { id: field, valueType, nullable: false, optional: false, readable: true, writable: false };
    const config: SourceConnectionConfig = kind === 'postgres' ? { kind, config: {
      host, port: Number(port), database, schema, tls: 'required',
      ...(logical && snapshotSlot ? { logical: { slot, plugin: 'wal2_json_v2' as const, snapshotSlot } } : {}),
      resources: [{ id: resource, table: resource, key: [field], fields: [{ ...common, column }] }], declaredCapabilities: capabilities,
    } } : kind === 'http_json' ? { kind, config: {
      origin, readPath: path, ...(schemaPath.trim() ? { schemaPath: schemaPath.trim() } : {}), resources: [{ id: resource, key: [field], rowsPointer, fields: [{ ...common, pointer: column }] }], declaredCapabilities: capabilities,
    } } : { kind, config: { resources: [{ id: resource, key: [field], fields: [{ ...common, name: column }] }], declaredCapabilities: capabilities } };
    const connection: ConnectionRevision = { world: state.world, id: crypto.randomUUID(), sourceId: crypto.randomUUID(), revision: '1', name, connector: selectedProvider.id, scope, config };
    const credential = kind === 'postgres' ? { kind: 'postgres' as const, user, password: secret } : kind === 'http_json' && secret ? { kind: 'http_bearer' as const, token: secret } : { kind: 'none' as const };
    setSecret('');
    const command = { kind: 'configure_connection' as const, request: { expectedRevision: null, connection } };
    void (kind === 'plugin' ? state.command(command) : state.configure(command, credential))
      .catch(error => setError(error instanceof Error ? error.message : t('connections.saveUnconfirmed')));
  }}>
    <section className="world-panel min-w-0">
      <header className="world-panel-header"><div className="flex min-w-0 items-center gap-3"><span className="rounded-lg border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-muted))] p-2 text-muted-foreground"><SourceIcon className="h-5 w-5" aria-hidden="true" /></span><div><h2 className="text-base font-semibold">{t('atelier.materials.connectionSetup')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('atelier.materials.sourceReadOnly')}</p></div></div></header>
      <div className="world-panel-body space-y-5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
          <TextField label={t('connections.connectionName')} value={name} onChange={setName} />
          <Field label={t('connections.sourceType')}><select className={selectClass} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setProvider(''); setSecret(''); }}><option value="postgres">{t('connections.types.postgres')}</option><option value="http_json">{t('connections.types.http_json')}</option><option value="plugin">{t('connections.types.plugin')}</option></select></Field>
        </div>
        {kind === 'postgres' ? <fieldset className="space-y-4 border-t border-[hsl(var(--shell-border))] pt-4">
          <legend className="px-1 text-sm font-medium">{t('atelier.materials.connectionAddress')}</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4"><TextField label={t('connections.host')} value={host} onChange={setHost} /><TextField label={t('connections.port')} type="number" value={port} onChange={setPort} /><TextField label={t('connections.database')} value={database} onChange={setDatabase} /><TextField label={t('connections.schema')} value={schema} onChange={setSchema} /><TextField label={t('connections.user')} value={user} onChange={setUser} /><TextField label={t('connections.password')} type="password" value={secret} onChange={setSecret} /></div>
        </fieldset> : kind === 'http_json' ? <fieldset className="space-y-4 border-t border-[hsl(var(--shell-border))] pt-4">
          <legend className="px-1 text-sm font-medium">{t('atelier.materials.connectionAddress')}</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4"><TextField label={t('connections.origin')} value={origin} onChange={setOrigin} placeholder={t('connections.originPlaceholder')} /><TextField label={t('connections.readPath')} value={path} onChange={setPath} placeholder={t('connections.readPathPlaceholder')} /><TextField label={t('connections.schemaPath')} value={schemaPath} onChange={setSchemaPath} placeholder={t('connections.schemaPathPlaceholder')} required={false} /><TextField label={t('connections.rowsPointer')} value={rowsPointer} onChange={setRowsPointer} placeholder={t('connections.rowsPointerPlaceholder')} required={false} /><TextField label={t('connections.token')} type="password" value={secret} onChange={setSecret} required={false} /></div>
        </fieldset> : <p className="text-sm text-muted-foreground">{t('connections.pluginHint')}</p>}
        {kind === 'postgres' && <details className="space-y-3 border-t border-[hsl(var(--shell-border))] pt-4">
          <summary className="cursor-pointer text-sm font-medium">{t('connections.replication.title')}</summary>
          <label className="flex items-start gap-2 text-sm"><input className="mt-1 accent-[hsl(var(--ring))]" type="checkbox" checked={logical} onChange={event => { setLogical(event.target.checked); setSnapshotSlot(''); }} />{t('connections.replication.enable')}</label>
          {logical && <><div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3"><TextField label={t('connections.replication.slot')} value={slot} onChange={setSlot} /><Field label={t('connections.replication.intent')}><select required className={selectClass} value={snapshotSlot} onChange={event => setSnapshotSlot(event.target.value as typeof snapshotSlot)}><option value="">{t('connections.replication.selectIntent')}</option><option value="existing">{t('connections.replication.existing')}</option><option value="create_fresh">{t('connections.replication.createFresh')}</option></select></Field></div><details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('connections.replication.details')}</summary><p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t('connections.replication.guarantees')}</p></details>{!snapshotSlot && <p className="text-xs text-muted-foreground">{t('connections.replication.intentRequired')}</p>}{slot && !/^[a-z0-9_]{1,63}$/.test(slot) && <p className="text-xs text-destructive">{t('connections.replication.invalidSlot')}</p>}</>}
        </details>}
        <fieldset className="grid gap-3 border-t border-[hsl(var(--shell-border))] pt-4">
          <legend className="px-1 text-sm font-medium">{t('connections.resource.title')}</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3"><TextField label={kind === 'postgres' ? t('connections.resource.table') : t('connections.resource.id')} value={resource} onChange={setResource} /><TextField label={t('connections.resource.keyId')} value={field} onChange={setField} /><TextField label={kind === 'postgres' ? t('connections.resource.keyColumn') : kind === 'http_json' ? t('connections.resource.keyPointer') : t('connections.resource.fieldName')} value={column} onChange={setColumn} /><Field label={t('connections.resource.fieldType')}><select className={selectClass} value={type} onChange={event => setType(event.target.value as typeof type)}><option value="text">{t('connections.resource.text')}</option><option value="integer">{t('connections.resource.integer')}</option><option value="boolean">{t('connections.resource.boolean')}</option></select></Field></div>
        </fieldset>
        <fieldset className="grid gap-3 border-t border-[hsl(var(--shell-border))] pt-4">
          <legend className="px-1 text-sm font-medium">{t('connections.authorization')}</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3"><Field label={t('connections.implementation')}><select required className={selectClass} value={provider} onChange={event => setProvider(event.target.value)} disabled={loading}><option value="">{loading ? t('connections.loadingImplementations') : t('connections.selectImplementation')}</option>{providers.map((item, index) => <option key={item.key} value={item.key}>{t('connections.implementationOption', { name: item.label, number: index + 1 })}</option>)}</select></Field><Field label={t('connections.scope')}><select required className={selectClass} value={scope} onChange={event => setScope(event.target.value)}><option value="">{t('connections.selectScope')}</option>{scopes.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field></div>
          {!loading && !providers.length && <p className="text-sm text-muted-foreground">{t('connections.noImplementations')}</p>}
          <details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('connections.readDetails')}</summary><div className="mt-3 space-y-3"><p className="text-xs leading-relaxed text-muted-foreground">{t('connections.bindingHint')}</p><FixedRecord value={selectedProvider?.details ?? readContract} /><Field label={t('connections.snapshot.title')}><select className={selectClass} disabled={kind === 'postgres' && logical} value={kind === 'postgres' && logical ? 'transactional' : snapshot} onChange={event => setSnapshot(event.target.value as typeof snapshot)}><option value="none">{t('connections.snapshot.none')}</option><option value="transactional">{t('connections.snapshot.transactional')}</option><option value="stable_key_enumeration">{t('connections.snapshot.stable_key_enumeration')}</option><option value="weak_pagination">{t('connections.snapshot.weak_pagination')}</option></select></Field>{ambiguous && <p className="text-xs text-muted-foreground">{t('connections.ambiguous')}</p>}</div></details>
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[hsl(var(--shell-border))] pt-4"><p className="max-w-lg text-xs leading-relaxed text-muted-foreground">{t('connections.credentialsHint')}</p><Button type="submit" size="sm" disabled={!canSave}>{t('connections.save')}</Button></div>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </div>
    </section>
  </form>;
}

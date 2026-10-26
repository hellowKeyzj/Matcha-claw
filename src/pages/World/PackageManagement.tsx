import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '@/stores/world';
import { queryWorld, sameWorld } from '@/stores/world/client';
import type { ConfigValue, InstalledRecord, PackageConfigView, TrustPolicy } from '@/types/world';
import { ValueField, readValue } from './Actions';
import { Field, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';
import { useWorldConfirmation } from './WorldConfirmation';

export function PackageTrustPolicy() {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const state = useWorldStore();
  const confirm = useWorldConfirmation();
  const fields = ['trustedNativeDigests', 'trustedProcessDigests'] as const;
  const [policy, setPolicy] = useState<TrustPolicy | null>(null);
  const [draft, setDraft] = useState<Pick<TrustPolicy, typeof fields[number] | 'trustedPublishers'> | null>(null);
  const [field, setField] = useState<typeof fields[number] | ''>('');
  const [digest, setDigest] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const currentPolicy = useRef({ policy, draft, reading });
  currentPolicy.current = { policy, draft, reading };
  const version = useRef(0);
  const mounted = useRef(false);
  const world = state.world;
  const incarnation = state.description?.incarnation;
  const revision = state.description?.revision;
  const blocked = reading || state.loading || state.busy || state.operationBusy || Boolean(state.pending)
    || Boolean(state.pendingOperation) || state.transferBusy || state.description?.status !== 'ready';
  const ownsWorld = () => {
    const latest = useWorldStore.getState();
    return mounted.current && world && latest.world && sameWorld(latest.world, world)
      && latest.description?.status === 'ready' && latest.description.incarnation === incarnation;
  };
  const current = (token: number) => token === version.current && ownsWorld() && useWorldStore.getState().description?.revision === revision;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => {
    version.current++; setPolicy(null); setDraft(null); setField(''); setDigest(''); setError(''); setReading(false);
  }, [world, incarnation, revision]);
  const changes = policy && draft ? fields.map(field => {
    const before = new Set(policy[field]);
    const after = new Set(draft[field]);
    return { field, added: draft[field].filter(value => !before.has(value)), removed: policy[field].filter(value => !after.has(value)) };
  }) : [];
  const publisherChanges = {
    added: draft?.trustedPublishers.filter(value => !policy?.trustedPublishers.includes(value)) ?? [],
    removed: policy?.trustedPublishers.filter(value => !draft?.trustedPublishers.includes(value)) ?? [],
  };
  const changed = changes.some(item => item.added.length || item.removed.length) || publisherChanges.added.length > 0 || publisherChanges.removed.length > 0;
  const nextRevision = policy && BigInt(policy.revision) < 9_223_372_036_854_775_807n ? String(BigInt(policy.revision) + 1n) : null;
  const replacement = policy && draft && nextRevision ? { ...policy, ...draft, revision: nextRevision } : null;
  const read = async () => {
    if (!world || blocked || !ownsWorld()) return;
    const token = ++version.current;
    setReading(true); setError(''); setPolicy(null); setDraft(null); setField(''); setDigest('');
    try {
      const result = await queryWorld(world, { kind: 'package_trust_policy', request: {} }, 'package_trust_policy');
      if (!current(token)) return;
      setPolicy(result); setDraft({ trustedNativeDigests: result.trustedNativeDigests, trustedProcessDigests: result.trustedProcessDigests, trustedPublishers: result.trustedPublishers });
    } catch (error) { if (current(token)) setError(error instanceof Error ? error.message : t('packages.management.readFailed')); }
    finally { if (token === version.current) setReading(false); }
  };
  const add = () => {
    if (!draft || !field || blocked || !current(version.current)) return;
    const value = digest.trim();
    setError('');
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) { setError(t('packages.management.digestInvalid')); return; }
    if (draft[field].includes(value)) { setError(t('packages.management.digestDuplicate')); return; }
    if (draft[field].length >= 4096) { setError(t('packages.management.digestLimit')); return; }
    setDraft({ ...draft, [field]: [...draft[field], value] }); setDigest('');
  };
  const addPublisher = (form: HTMLFormElement) => {
    if (!draft || blocked || !current(version.current)) return;
    const data = new FormData(form);
    const publisher = String(data.get('publisher'));
    const keyId = String(data.get('keyId'));
    const publicKey = String(data.get('publicKey')).trim();
    setError('');
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(publisher)) { setError(t('packages.management.publisherInvalid')); return; }
    if (!keyId || new TextEncoder().encode(keyId).length > 256 || /\p{Cc}/u.test(keyId)) { setError(t('packages.management.keyIdInvalid')); return; }
    if (!/^[0-9a-f]{64}$/.test(publicKey)) { setError(t('packages.management.publicKeyInvalid')); return; }
    if (draft.trustedPublishers.some(value => value.publisher === publisher && value.keyId === keyId)) { setError(t('packages.management.publisherDuplicate')); return; }
    if (draft.trustedPublishers.length >= 4096) { setError(t('packages.management.publisherLimit')); return; }
    setDraft({ ...draft, trustedPublishers: [...draft.trustedPublishers, {
      publisher, keyId, publicKey: Array.from({ length: 32 }, (_, index) => parseInt(publicKey.slice(index * 2, index * 2 + 2), 16)),
      allowProcess: data.get('allowProcess') === 'on', allowNative: data.get('allowNative') === 'on',
    }] });
    form.reset();
  };
  const replace = async () => {
    if (!world || !policy || !draft || !changed || !replacement || blocked || !current(version.current)) return;
    const token = version.current;
    const request = { expectedRevision: policy.revision, policy: replacement };
    if (!await confirm(t('packages.management.policyConfirm', { world: world.worldId, revision: policy.revision, nextRevision,
      added: changes.reduce((count, item) => count + item.added.length, publisherChanges.added.length), removed: changes.reduce((count, item) => count + item.removed.length, publisherChanges.removed.length) }))) return;
    const latest = useWorldStore.getState();
    if (!current(token) || currentPolicy.current.policy !== policy || currentPolicy.current.draft !== draft || currentPolicy.current.reading
      || latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
    setError('');
    try {
      const result = await state.command({ kind: 'replace_package_trust_policy', request });
      if (!ownsWorld()) return;
      setPolicy(null); setDraft(null);
      if (result.kind !== 'accepted' || !sameWorld(result.result.world, world) || result.result.incarnation !== incarnation) throw new Error(t('packages.management.requestFailed'));
      navigate('/world/settings?tab=operations');
    } catch (error) {
      if (current(token)) { setError(error instanceof Error ? error.message : t('packages.management.requestFailed')); setPolicy(null); setDraft(null); }
    }
  };
  return <section className="world-panel min-w-0" aria-label={t('packages.management.trustPolicy')}>
    <header className="world-panel-header"><h3 className="text-sm font-semibold">{t('packages.management.trustPolicy')}</h3><Button type="button" size="sm" variant="outline" disabled={blocked || !world} onClick={() => { void read(); }}>{t('packages.management.readPolicy')}</Button></header>
    <div className="world-panel-body space-y-4">
    <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.trustNotice')}</p>
    <details><summary className="cursor-pointer text-xs font-medium">{t('packages.management.trustGuidance')}</summary><div className="mt-3 space-y-3"><p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.trustEditNotice')}</p><p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.policyProgressNotice')}</p></div></details>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {policy && draft && <fieldset disabled={blocked} className="min-w-0 space-y-4">
      <details><summary className="cursor-pointer text-sm">{t('packages.management.policyDetails')}</summary><div className="mt-3"><FixedRecord value={policy} /></div></details>
      {fields.map(field => <section key={field} className="min-w-0 space-y-3"><h4 className="text-sm font-medium">{t(`packages.management.${field}`)}</h4>{draft[field].length ? <ul className="max-h-64 space-y-2 overflow-y-auto">{draft[field].map(value => <li key={value} className="flex min-w-0 items-start gap-3 rounded-lg border border-border p-3"><code className="min-w-0 flex-1 break-all text-xs">{value}</code><Button type="button" size="sm" variant="outline" aria-label={t('packages.management.removeDigest', { kind: t(`packages.management.${field}`), digest: value })} onClick={() => { if (!current(version.current) || blocked) return; setDraft({ ...draft, [field]: draft[field].filter(item => item !== value) }); setError(''); }}>{t('packages.remove')}</Button></li>)}</ul> : <p className="text-xs text-muted-foreground">{t('packages.management.noDigests')}</p>}</section>)}
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); add(); }}>
        <Field label={t('packages.management.trustClass')}><select className={selectClass} required value={field} onChange={event => { const value = event.target.value; if (value === '' || value === 'trustedNativeDigests' || value === 'trustedProcessDigests') setField(value); setError(''); }}><option value="">{t('packages.select')}</option>{fields.map(field => <option key={field} value={field}>{t(`packages.management.${field}`)}</option>)}</select></Field>
        <TextField label={t('packages.management.packageDigest')} value={digest} onChange={value => { setDigest(value); setError(''); }} placeholder="sha256:…" />
        <Button type="submit" size="sm" variant="outline" disabled={!field || !digest.trim()}>{t('packages.management.addDigest')}</Button>
      </form>
      <section className="min-w-0 space-y-3">
        <h4 className="text-sm font-medium">{t('packages.management.trustedPublishers')}</h4>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.publisherNotice')}</p>
        {draft.trustedPublishers.length ? <ul className="max-h-96 space-y-3 overflow-y-auto">{draft.trustedPublishers.map(value => <li key={JSON.stringify([value.publisher, value.keyId])} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
          <FixedRecord value={{ ...value, publicKey: value.publicKey.map(byte => byte.toString(16).padStart(2, '0')).join('') }} />
          <Button type="button" size="sm" variant="outline" aria-label={t('packages.management.removePublisher', { publisher: value.publisher, keyId: value.keyId })} onClick={() => { if (!current(version.current) || blocked) return; setDraft({ ...draft, trustedPublishers: draft.trustedPublishers.filter(item => item !== value) }); setError(''); }}>{t('packages.remove')}</Button>
        </li>)}</ul> : <p className="text-xs text-muted-foreground">{t('packages.management.noPublishers')}</p>}
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); addPublisher(event.currentTarget); }}>
          <Field label={t('packages.management.publisher')}><input name="publisher" type="text" required className={selectClass} autoComplete="off" spellCheck={false} /></Field>
          <Field label={t('packages.management.keyId')}><input name="keyId" type="text" required className={selectClass} autoComplete="off" spellCheck={false} /></Field>
          <Field label={t('packages.management.publicKey')}><input name="publicKey" type="text" required className={`${selectClass} font-mono`} autoComplete="off" spellCheck={false} /></Field>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.publicKeyNotice')}</p>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="allowProcess" className="mt-1" defaultChecked={false} /><span>{t('packages.management.allowProcess')}</span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="allowNative" className="mt-1" defaultChecked={false} /><span>{t('packages.management.allowNative')}</span></label>
          <Button type="submit" size="sm" variant="outline">{t('packages.management.addPublisher')}</Button>
        </form>
      </section>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.policyPreserved')}</p>
      {changed && <section className="space-y-3 rounded-lg border border-border p-3"><h4 className="text-sm font-medium">{t('packages.management.trustPreview')}</h4>{nextRevision && <p className="text-xs text-muted-foreground">{t('packages.management.policyRevisionChange', { revision: policy.revision, nextRevision })}</p>}{changes.filter(item => item.added.length || item.removed.length).map(item => <div key={item.field} className="space-y-2"><p className="text-sm font-medium">{t(`packages.management.${item.field}`)}</p>{(['added', 'removed'] as const).map(kind => item[kind].length > 0 && <div key={kind}><p className="text-xs font-medium">{t(`packages.management.${kind}Digests`)}</p><ul className="max-h-64 space-y-1 overflow-y-auto">{item[kind].map(value => <li key={value} className="break-all font-mono text-xs">{value}</li>)}</ul></div>)}</div>)}
        {(['added', 'removed'] as const).map(kind => publisherChanges[kind].length > 0 && <div key={kind} className="space-y-2"><p className="text-sm font-medium">{t(`packages.management.${kind}Publishers`)}</p><ul className="max-h-96 space-y-3 overflow-y-auto">{publisherChanges[kind].map(value => <li key={JSON.stringify([value.publisher, value.keyId])}><FixedRecord value={{ ...value, publicKey: value.publicKey.map(byte => byte.toString(16).padStart(2, '0')).join('') }} /></li>)}</ul></div>)}
        {([['policyBefore', policy], ['policyAfter', replacement]] as const).map(([label, value]) => value && <div key={label} className="min-w-0 space-y-2"><h5 className="text-sm font-medium">{t(`packages.management.${label}`)}</h5><pre aria-label={t(`packages.management.${label}`)} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border p-3 text-xs">{JSON.stringify(value, (key, item) => key === 'publicKey' ? item.map((byte: number) => byte.toString(16).padStart(2, '0')).join('') : item, 2)}</pre></div>)}
      </section>}
      {!nextRevision && <p className="text-sm text-destructive" role="alert">{t('packages.management.policyRevisionLimit')}</p>}
      <Button type="button" size="sm" disabled={!changed || !nextRevision} onClick={() => { void replace(); }}>{t('packages.management.submitPolicy')}</Button>
    </fieldset>}
  </div></section>;
}

export function PackageManagement({ record }: { record: InstalledRecord }) {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const state = useWorldStore();
  const confirm = useWorldConfirmation();
  const [config, setConfig] = useState<PackageConfigView | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [grantSelection, setGrantSelection] = useState<number[]>([]);
  const blocked = state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy || state.loading;
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const currentInput = useRef({ record, grantSelection, reading });
  currentInput.current = { record, grantSelection, reading };
  const version = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => { version.current++; setConfig(null); setChoices({}); setGrantSelection([]); setError(''); setReading(false); }, [record, state.description?.incarnation, state.description?.revision]);
  const ownsWorld = () => {
    const latest = useWorldStore.getState();
    return mounted.current && latest.world && sameWorld(latest.world, record.world)
      && latest.description?.incarnation === state.description?.incarnation;
  };
  const current = () => ownsWorld() && useWorldStore.getState().description?.revision === state.description?.revision;
  const read = async () => {
    if (reading || !current()) return;
    const token = ++version.current;
    setReading(true); setError(''); setConfig(null); setChoices({});
    try {
      const result = await queryWorld(record.world, { kind: 'package_config', request: { installId: record.installId } }, 'package_config');
      if (token !== version.current || !current()) return;
      if (result.installId !== record.installId) throw new Error(t('packages.management.configMismatch'));
      setConfig(result);
    } catch (error) { if (token === version.current && current()) setError(error instanceof Error ? error.message : t('packages.management.readFailed')); }
    finally { if (token === version.current) setReading(false); }
  };
  const save = async (form: HTMLFormElement) => {
    if (!config || blocked || !current()) return;
    setError('');
    try {
      const data = new FormData(form);
      const fields: ConfigValue[] = record.manifest.config.fields.flatMap((field, index) => {
        const choice = choices[field.name] ?? 'keep';
        if (choice === 'default') return [];
        if (choice === 'keep') return config.fields.filter(value => value.name === field.name);
        const value = readValue(t, data, `config.${index}`, field.valueType);
        return value === undefined ? [] : [{ name: field.name, value }];
      });
      const result = await state.command({ kind: 'configure_package', request: { installId: record.installId, expectedRevision: config.revision, fields } });
      if (result.kind === 'accepted' && ownsWorld()) navigate('/world/settings?tab=operations');
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : t('packages.management.requestFailed')); }
  };
  const grant = async () => {
    const world = state.world; const token = version.current;
    if (blocked || reading || !world || !current()) return;
    const request = { installId: record.installId, expectedRevision: record.revision, grants: grantSelection.map(index => record.manifest.requestedAccess[index]) };
    if (!await confirm(t('packages.management.grantConfirm', { name: record.manifest.identity.id, count: grantSelection.length }))) return;
    const latest = useWorldStore.getState();
    if (token !== version.current || !current() || currentInput.current.record !== record || currentInput.current.grantSelection !== grantSelection || currentInput.current.reading
      || !latest.world || !sameWorld(latest.world, world) || latest.description?.status !== 'ready'
      || latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
    setError('');
    try {
      const result = await state.command({ kind: 'grant_package', request });
      if (result.kind === 'accepted' && ownsWorld()) navigate('/world/settings?tab=operations');
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : t('packages.management.requestFailed')); }
  };
  const lifecycle = async (kind: 'enable_package' | 'disable_package' | 'uninstall_package') => {
    const world = state.world; const token = version.current;
    if (blocked || reading || !world || !current()) return;
    const request = { installId: record.installId, expectedRevision: record.revision };
    if (!await confirm(t(`packages.management.confirm.${kind}`, { name: record.manifest.identity.id }))) return;
    const latest = useWorldStore.getState();
    if (token !== version.current || !current() || currentInput.current.record !== record || currentInput.current.reading
      || !latest.world || !sameWorld(latest.world, world) || latest.description?.status !== 'ready'
      || latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
    setError('');
    try {
      const result = await state.command({ kind, request });
      if (result.kind === 'accepted' && ownsWorld()) navigate('/world/settings?tab=operations');
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : t('packages.management.requestFailed')); }
  };
  return <section className="space-y-4 border-t border-border pt-4">
    <h4 className="text-sm font-medium">{t('packages.management.title')}</h4>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    <details><summary className="cursor-pointer text-sm font-medium">{t('packages.management.lifecycle')}</summary><div className="mt-4 space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.lifecycleNotice')}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.removalNotice')}</p>
      <div className="flex flex-wrap gap-2">{(['enable_package', 'disable_package', 'uninstall_package'] as const).map(kind => <Button key={kind} type="button" size="sm" variant="outline" disabled={blocked || reading} onClick={() => { void lifecycle(kind); }}>{t(`packages.management.actions.${kind}`)}</Button>)}</div>
    </div></details>
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('packages.management.configuration')}</summary><div className="mt-4 space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.configNotice')}</p>
      <Button type="button" size="sm" variant="outline" disabled={reading || blocked} onClick={() => { void read(); }}>{t('packages.management.readConfig')}</Button>
      {reading && <p className="text-xs text-muted-foreground" role="status">{t('shell.reading')}</p>}
      {config && <form key={config.digest} className="space-y-4" onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
        <p className="break-all text-xs text-muted-foreground">{t('packages.management.configRevision', { revision: config.revision })}</p>
        {record.manifest.config.fields.map((field, index) => <div key={field.name} className="space-y-3 rounded-lg border border-border p-3">
          <div><p className="break-words text-sm font-medium">{field.name}</p><p className="mt-1 text-xs text-muted-foreground">{t(`packages.management.mutableAt.${field.mutableAt}`)}</p></div>
          <FixedRecord value={config.fields.find(value => value.name === field.name)?.value ?? null} />
          <Field label={t('packages.management.fieldChange')}><select className={selectClass} value={choices[field.name] ?? 'keep'} onChange={event => setChoices(values => ({ ...values, [field.name]: event.target.value }))}><option value="keep">{t('packages.management.keep')}</option><option value="set">{t('packages.management.replace')}</option>{(field.default != null || !field.required) && <option value="default">{t(field.default != null ? 'packages.management.useDefault' : 'packages.management.omit')}</option>}</select></Field>
          {choices[field.name] === 'set' && <ValueField name={`config.${index}`} label={field.name} type={field.valueType} objects={state.objects?.objects ?? []} />}
          {choices[field.name] === 'default' && field.default != null && <FixedRecord value={field.default} />}
        </div>)}
        <Button type="submit" size="sm" disabled={blocked || !record.manifest.config.fields.some(field => choices[field.name] && choices[field.name] !== 'keep')}>{t('packages.management.saveConfig')}</Button>
      </form>}
    </div></details>
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('packages.management.grants')}</summary><div className="mt-4 space-y-3"><p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.grantNotice')}</p>{record.manifest.requestedAccess.map((access, index) => <label key={index} className="flex min-w-0 items-start gap-2 rounded-lg border border-border p-3"><input type="checkbox" className="mt-1" disabled={blocked} checked={grantSelection.includes(index)} onChange={event => setGrantSelection(values => event.target.checked ? [...values, index] : values.filter(value => value !== index))} /><span className="min-w-0 space-y-2"><span className="block text-sm">{t(`atelier.packages.permissions.${access.kind}`)}</span><FixedRecord value={access} /></span></label>)}<Button type="button" size="sm" variant="outline" disabled={blocked || reading} onClick={() => { void grant(); }}>{t('packages.management.replaceGrants')}</Button></div></details>
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('packages.management.installTrust')}</summary><div className="mt-3"><FixedRecord value={record.trust} /></div></details>
  </section>;
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { CapabilityCallReceipt, RemoteCapability } from '@/types/desktop/interconnect';
import { accessError, AccessRequestError, failureCode, invokeCapability, readCapabilityResult, type AccessUiError } from './client';
import { RequestError } from './ui';
import { capabilityName } from './model';

type Field = { name: string; type: 'string' | 'boolean' | 'number' | 'integer'; title: string; description?: string; required: boolean; values?: (string | number | boolean)[]; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number };
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fieldsFor(schema: Record<string, unknown>): Field[] | null {
  if (schema.type !== 'object' || !record(schema.properties) || Object.keys(schema).some((key) => !['type', 'properties', 'required', 'title', 'description', 'additionalProperties'].includes(key))) return null;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return null;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string' || !Object.hasOwn(schema.properties as object, name))) return null;
  const fields: Field[] = [];
  for (const [name, definition] of Object.entries(schema.properties)) {
    if (!record(definition) || Object.keys(definition).some((key) => !['type', 'title', 'description', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum'].includes(key))) return null;
    if (!['string', 'boolean', 'number', 'integer'].includes(definition.type as string)) return null;
    const type = definition.type as Field['type'];
    for (const key of ['minLength', 'maxLength'] as const) if (definition[key] !== undefined && (type !== 'string' || typeof definition[key] !== 'number' || !Number.isInteger(definition[key]) || definition[key] < 0)) return null;
    for (const key of ['minimum', 'maximum'] as const) if (definition[key] !== undefined && (!['number', 'integer'].includes(type) || typeof definition[key] !== 'number' || !Number.isFinite(definition[key]))) return null;
    if (definition.pattern !== undefined && (type !== 'string' || typeof definition.pattern !== 'string')) return null;
    if (definition.enum !== undefined && (!Array.isArray(definition.enum) || !definition.enum.length || definition.enum.some((value) => type === 'integer' ? typeof value !== 'number' || !Number.isInteger(value) : typeof value !== type))) return null;
    fields.push({ name, type, title: typeof definition.title === 'string' ? definition.title : name, description: typeof definition.description === 'string' ? definition.description : undefined, required: required.includes(name), values: definition.enum as Field['values'], minLength: definition.minLength as number | undefined, maxLength: definition.maxLength as number | undefined, pattern: definition.pattern as string | undefined, minimum: definition.minimum as number | undefined, maximum: definition.maximum as number | undefined });
  }
  return fields;
}
function checkReceipt(value: CapabilityCallReceipt, callId?: string): CapabilityCallReceipt {
  if (!record(value) || typeof value.callId !== 'string' || !value.callId || (callId !== undefined && value.callId !== callId)
    || !['accepted', 'running', 'completed', 'failed', 'unknown'].includes(value.phase)
    || (value.phase === 'completed' && !Object.hasOwn(value, 'result')) || (value.phase === 'failed' && typeof value.error !== 'string')) throw new AccessRequestError('outcome-unknown');
  return value;
}

export function CapabilityDetail({ clientId, clientName, capability, disabled, onClose }: {
  clientId: string; clientName: string; capability: RemoteCapability; disabled: boolean; onClose: () => void;
}) {
  const { t } = useTranslation('access');
  const fields = fieldsFor(capability.inputSchema);
  const presentation = capability.presentation;
  const isAgent = presentation?.kind === 'agent' && presentation.operation === 'agent.ask';
  const builtinFields = isAgent ? ['message'] : presentation?.kind === 'wiki' ? presentation.operation === 'wiki.read' ? ['relativePath'] : presentation.operation === 'wiki.search' ? ['query', 'limit'] : [] : presentation?.kind === 'folder' ? presentation.operation === 'folder.list' ? ['relativePath', 'limit', 'cursor'] : presentation.operation === 'folder.read' ? ['relativePath'] : presentation.operation === 'folder.write' ? ['relativePath', 'text'] : [] : [];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [json, setJson] = useState('{}');
  const [receipt, setReceipt] = useState<CapabilityCallReceipt | null>(null);
  const [error, setError] = useState<AccessUiError | null>(null);
  const [inputError, setInputError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const requestBusy = useRef(false);
  const alive = useRef(true);
  const resultRegion = useRef<HTMLDivElement>(null);
  const pending = receipt?.phase === 'accepted' || receipt?.phase === 'running';
  const result = receipt?.phase === 'completed' && record(receipt.result) ? receipt.result : null;
  const nativeUnknown = result?.outcome === 'unknown' || result?.outcome === 'outcome-unknown';
  const locked = busy || pending || uncertain || receipt?.phase === 'unknown' || nativeUnknown;
  const messages = isAgent && Array.isArray(result?.messages) ? result.messages.filter(record) : [];
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (receipt && !pending) resultRegion.current?.focus(); }, [receipt, pending]);
  const readResult = async (callId: string) => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true); setError(null);
    try {
      const next = checkReceipt(await readCapabilityResult(clientId, callId), callId);
      if (alive.current) { setReceipt(next); setUncertain(false); }
    } catch (cause) { if (alive.current) setError(accessError(cause)); }
    finally { requestBusy.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    if (!pending || busy || error || !receipt) return;
    const timer = window.setTimeout(() => { void readResult(receipt.callId); }, 1000);
    return () => window.clearTimeout(timer);
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (locked || disabled || requestBusy.current) return;
    let args: Record<string, unknown>;
    try {
      if (fields) {
        args = Object.fromEntries(fields.flatMap((field) => {
          const value = draft[field.name] ?? '';
          if (!value && !field.required) return [];
          if (!value && field.type !== 'string') throw new Error();
          const parsed = field.values ? field.values[Number(value)] : field.type === 'boolean' ? value === 'true' : field.type === 'string' ? value : Number(value);
          if (typeof parsed === 'string' && field.pattern && !new RegExp(field.pattern, 'u').test(parsed)) throw new Error();
          if (parsed === undefined || ((field.type === 'number' || field.type === 'integer') && (typeof parsed !== 'number' || !Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))))) throw new Error();
          return [[field.name, parsed]];
        }));
      } else {
        const parsed: unknown = JSON.parse(json);
        if (!record(parsed)) throw new Error();
        args = parsed;
      }
    } catch { setInputError(true); return; }
    requestBusy.current = true;
    setInputError(false); setBusy(true); setError(null); setReceipt(null);
    try {
      const next = checkReceipt(await invokeCapability({ clientId, resourceId: capability.resourceId, sourceId: capability.sourceId, arguments: args }));
      if (alive.current) setReceipt(next);
    } catch (cause) {
      const code = accessError(cause, true);
      if (alive.current) { setError(code); if (code === 'outcome-unknown') setUncertain(true); }
    } finally { requestBusy.current = false; if (alive.current) setBusy(false); }
  };
  return <aside className="access-detail" aria-label={t('interop.capabilityDetails')}>
    <div className="access-detail-top"><span>{t('interop.capabilityDetails')}</span><Button type="button" variant="ghost" size="icon" disabled={busy} onClick={onClose} aria-label={t('close')}><X aria-hidden="true" className="h-4 w-4" /></Button></div>
    <div className="access-detail-identity"><h2>{capabilityName(capability, t)}</h2><span className="access-badge">{clientName}</span></div>
    <p className="access-note">{capability.description}</p>
    {isAgent && <p className="access-note">{t('interop.agentNote')}</p>}
    <form className="access-capability-form" onSubmit={(event) => { void submit(event); }}>
      <fieldset disabled={locked || disabled} className="access-network-fields">
        {fields ? fields.map((field, index) => <label key={field.name} className="access-field"><span>{builtinFields.includes(field.name) ? t(`interop.fields.${field.name}`) : field.title}{field.required ? ' *' : ''}</span>{field.values || field.type === 'boolean'
          ? <Select required={field.required} value={draft[field.name] ?? ''} onChange={(event) => setDraft((values) => ({ ...values, [field.name]: event.target.value }))}><option value="">{t('interop.selectValue')}</option>{field.values ? field.values.map((value, option) => <option key={option} value={String(option)}>{typeof value === 'boolean' ? t(value ? 'interop.yes' : 'interop.no') : String(value)}</option>) : <><option value="true">{t('interop.yes')}</option><option value="false">{t('interop.no')}</option></>}</Select>
          : field.type === 'string' && ['message', 'content', 'text'].includes(field.name) ? <Textarea id={`access-capability-${index}`} required={field.required} rows={5} minLength={field.minLength} maxLength={field.maxLength} value={draft[field.name] ?? ''} onChange={(event) => setDraft((values) => ({ ...values, [field.name]: event.target.value }))} />
          : <Input id={`access-capability-${index}`} required={field.required} type={field.type === 'string' ? 'text' : 'number'} step={field.type === 'integer' ? 1 : 'any'} minLength={field.minLength} maxLength={field.maxLength} min={field.minimum} max={field.maximum} value={draft[field.name] ?? ''} onChange={(event) => setDraft((values) => ({ ...values, [field.name]: event.target.value }))} />}{field.description && <small>{field.description}</small>}</label>)
          : <><p className="access-note">{t('interop.jsonNote')}</p><label className="access-field"><span>{t('interop.arguments')}</span><Textarea required spellCheck={false} rows={9} value={json} onChange={(event) => setJson(event.target.value)} /></label></>}
        <details className="access-advanced"><summary>{t('interop.schema')}</summary><pre className="access-http-body">{JSON.stringify(capability.inputSchema, null, 2)}</pre></details>
      </fieldset>
      {inputError && <p className="access-error" role="alert">{t('interop.argumentsInvalid')}</p>}
      <RequestError code={error} />
      <Button type="submit" disabled={locked || disabled}>{t(busy ? 'interop.executing' : 'interop.execute')}</Button>
    </form>
    {(receipt || uncertain) && <div ref={resultRegion} tabIndex={-1} className="access-http-result" aria-label={t('interop.result')}>
      <h3>{t('interop.result')}</h3><p className="access-note" role="status">{t(receipt?.phase === 'completed' && presentation ? 'interop.returned' : `interop.phases.${uncertain ? 'unknown' : receipt!.phase}`)}</p>
      {(uncertain || receipt?.phase === 'unknown' || nativeUnknown) && <p className="access-note">{t('interop.unknownNote')}</p>}
      {receipt && <>
        <dl className="access-facts"><div><dt>{t('interop.callId')}</dt><dd>{receipt.callId}</dd></div>{result && ['outcome', 'runId', 'terminal', 'messagesStatus', 'complete'].map((key) => (typeof result[key] === 'string' || typeof result[key] === 'boolean') && <div key={key}><dt>{t(`interop.resultFields.${key}`)}</dt><dd>{typeof result[key] === 'boolean' ? t(result[key] ? 'interop.yes' : 'interop.no') : String(result[key])}</dd></div>)}</dl>
        {messages.map((message, index) => <div className="access-agent-message" key={typeof message.itemId === 'string' ? message.itemId : index}>{typeof message.status === 'string' && <span className="access-badge">{message.status}</span>}{typeof message.text === 'string' && <pre className="access-http-body">{message.text}</pre>}</div>)}
        {receipt.phase === 'completed' && (isAgent ? <details className="access-advanced"><summary>{t('interop.rawResult')}</summary><pre className="access-http-body">{JSON.stringify(receipt.result, null, 2)}</pre></details> : <pre className="access-http-body">{typeof receipt.result === 'string' ? receipt.result : JSON.stringify(receipt.result, null, 2)}</pre>)}
        {receipt.phase === 'failed' && <RequestError code={failureCode(receipt.error)} />}{receipt.phase !== 'completed' && receipt.phase !== 'failed' && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void readResult(receipt.callId); }}>{t('interop.readResult')}</Button>}
      </>}
    </div>}
  </aside>;
}

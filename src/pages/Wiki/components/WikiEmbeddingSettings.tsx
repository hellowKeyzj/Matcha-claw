import { useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  hostWikiSearchConfig,
  hostWikiUpdateSearchConfig,
  type HostWikiEmbeddingConfig,
} from '@/lib/host-api';
import { SettingGroup, SettingRow, SelectSettingRow } from './WikiSettings';

export function WikiEmbeddingSettings(props: Readonly<{ projectId: string; busy: boolean }>): JSX.Element {
  const { t } = useTranslation('wiki', { keyPrefix: 'embeddingSettings' });
  return (
    <SettingGroup title={t('title')} description={t('description')}>
      <ProjectEmbeddingEditor key={props.projectId} {...props} />
    </SettingGroup>
  );
}

function ProjectEmbeddingEditor({ projectId, busy }: Readonly<{ projectId: string; busy: boolean }>): JSX.Element {
  const { t } = useTranslation('wiki', { keyPrefix: 'embeddingSettings' });
  const [draft, setDraft] = useState<HostWikiEmbeddingConfig | null>(null);
  const [apiKey, setApiKey] = useState<string | undefined>();
  const [headers, setHeaders] = useState('');
  const [phase, setPhase] = useState<'loading' | 'load-error' | 'ready' | 'saving'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const baseline = useRef('');
  const dirty = JSON.stringify([draft, headers, apiKey]) !== baseline.current;
  const disabled = busy || phase === 'saving';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void hostWikiSearchConfig({ projectId }).then((receipt) => {
      if (!active) return;
      if (receipt.projectId !== projectId) {
        setError('projectMismatch');
        setPhase('load-error');
        return;
      }
      const embedding = receipt.config.embedding;
      const loadedHeaders = JSON.stringify(embedding.extraHeaders, null, 2);
      baseline.current = JSON.stringify([embedding, loadedHeaders, undefined]);
      setDraft(embedding);
      setHeaders(loadedHeaders);
      setPhase('ready');
    }).catch(() => {
      if (!active) return;
      setError('loadFailed');
      setPhase('load-error');
    });
    return () => { active = false; };
  }, [projectId, retry]);

  function updateDraft(patch: Partial<HostWikiEmbeddingConfig>): void {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setSaved(false);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (phase !== 'ready' || busy || !draft || !dirty) return;
    setError('');
    setSaved(false);
    let extraHeaders: unknown;
    if (draft.source === 'remote') {
      try {
        extraHeaders = JSON.parse(headers);
      } catch {
        setError('invalidHeaders');
        return;
      }
      if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders) || Object.values(extraHeaders).some((value) => typeof value !== 'string')) {
        setError('invalidHeaders');
        return;
      }
    }
    setPhase('saving');
    const { apiKeyConfigured: _configured, ...embedding } = draft;
    try {
      const receipt = await hostWikiUpdateSearchConfig({
        projectId,
        embedding: draft.source === 'local-minilm' ? {
          enabled: draft.enabled,
          source: draft.source,
          maxChunkChars: draft.maxChunkChars,
          overlapChunkChars: draft.overlapChunkChars,
          batchSize: draft.batchSize,
          concurrency: draft.concurrency,
        } : { ...embedding, extraHeaders: extraHeaders as Record<string, string>, ...(apiKey === undefined ? {} : { apiKey }) },
      });
      if (!mounted.current) return;
      if (receipt.projectId !== projectId) {
        setError('projectMismatch');
        return;
      }
      const next = receipt.config.embedding;
      const nextHeaders = JSON.stringify(next.extraHeaders, null, 2);
      baseline.current = JSON.stringify([next, nextHeaders, undefined]);
      setDraft(next);
      setHeaders(nextHeaders);
      setApiKey(undefined);
      setSaved(true);
    } catch {
      if (mounted.current) setError('saveFailed');
    } finally {
      if (mounted.current) setPhase('ready');
    }
  }

  if (phase === 'loading') return <p role="status" className="p-4 text-sm text-muted-foreground">{t('loading')}</p>;
  if (phase === 'load-error') return <div className="space-y-2 p-4"><p role="alert" className="text-sm text-destructive">{t(error)}</p><Button variant="outline" size="sm" onClick={() => { setError(''); setPhase('loading'); setRetry((value) => value + 1); }}>{t('retry')}</Button></div>;
  if (!draft) return <></>;

  return (
    <form onSubmit={(event) => { void save(event); }} onChange={() => setSaved(false)}>
      <fieldset disabled={disabled} className="min-w-0 disabled:opacity-70">
        <SettingRow title={t('enabled')} description={t('enabledHint')} checked={draft.enabled} disabled={disabled} onChange={(enabled) => updateDraft({ enabled })} />
        <SelectSettingRow title={t('source')} description={t('sourceHint')} value={draft.source} disabled={disabled} options={[
          ['local-minilm', t('localMinilm')],
          ['remote', t('remote')],
        ]} onChange={(source) => updateDraft({ source: source as HostWikiEmbeddingConfig['source'] })} />
        {draft.source === 'local-minilm' ? <p className="border-b border-border/60 px-4 py-4 text-sm text-muted-foreground">{t('localHint')}</p> : (
          <div className="space-y-4 border-b border-border/60 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {(['endpoint', 'model'] as const).map((key) => <Field key={key} label={t(key)}><Input value={draft[key]} onChange={(event) => updateDraft({ [key]: event.target.value })} /></Field>)}
              <div className="space-y-2">
                <Field label={t('apiKey')}><Input type="password" autoComplete="new-password" value={apiKey ?? ''} disabled={apiKey === ''} onChange={(event) => setApiKey(event.target.value || undefined)} placeholder={apiKey === '' ? t('keyWillClear') : draft.apiKeyConfigured ? t('keepKey') : t('enterKey')} /></Field>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{t(draft.apiKeyConfigured ? 'keyConfigured' : 'keyNotConfigured')}</p>
                  {draft.apiKeyConfigured || apiKey === '' ? <Button type="button" size="sm" variant="ghost" onClick={() => { setApiKey(apiKey === '' ? undefined : ''); setSaved(false); }}>{t(apiKey === '' ? 'undoClearKey' : 'clearKey')}</Button> : null}
                </div>
              </div>
              <div className="space-y-2">
                <Field label={t('outputDimensionality')}><Input type="number" min={1} step={1} value={draft.outputDimensionality ?? ''} onChange={(event) => updateDraft({ outputDimensionality: event.target.value ? Number(event.target.value) : null })} /></Field>
                <p className="text-xs text-muted-foreground">{t('dimensionsHint')}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('keysPrivate')}</p>
            <Field label={t('extraHeaders')}><Textarea value={headers} onChange={(event) => setHeaders(event.target.value)} spellCheck={false} className="font-mono text-xs" /></Field>
          </div>
        )}
        <details className="group/advanced border-b border-border/60">
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {t('advanced')}
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none group-open/advanced:rotate-180" />
          </summary>
          <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
            {(['maxChunkChars', 'overlapChunkChars', 'batchSize', 'concurrency'] as const).map((key) => <Field key={key} label={t(key)}><Input type="number" min={key === 'overlapChunkChars' ? 0 : 1} max={key === 'overlapChunkChars' ? draft.maxChunkChars - 1 : key === 'batchSize' ? 64 : key === 'concurrency' ? 32 : undefined} step={1} required value={draft[key]} onChange={(event) => updateDraft({ [key]: Number(event.target.value) })} /></Field>)}
          </div>
        </details>
      </fieldset>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">{t('reindexHint')}</p>
        {error ? <p role="alert" className="text-sm text-destructive">{t(error)}</p> : null}
        <div className="flex items-center justify-between gap-4">
          <p role="status" className="text-sm text-muted-foreground">{dirty ? t('unsaved') : saved ? t('saved') : ''}</p>
          <Button type="submit" size="sm" variant="outline" className="shrink-0 rounded-full bg-card" disabled={disabled || !dirty}>{t(phase === 'saving' ? 'saving' : 'save')}</Button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>): JSX.Element {
  return <label className="block min-w-0 space-y-2 text-sm font-medium"><span>{label}</span>{children}</label>;
}

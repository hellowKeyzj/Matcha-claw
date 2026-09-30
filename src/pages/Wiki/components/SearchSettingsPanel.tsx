import { useEffect, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Search, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { HostWikiSearchConfig, HostWikiSearchConfigUpdate, HostWikiSearchProvider, HostWikiSearchProviderConfigUpdate, HostWikiSearchProviderTestResult } from '@/lib/host-api';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader, WikiPrimaryButton, WikiSurface } from './WikiChrome';

export type SearchSettingsPanelProps = Readonly<{
  config: HostWikiSearchConfig | null;
  busy: string | null;
  onSave(patch: HostWikiSearchConfigUpdate): Promise<void>;
  onTest(patch: HostWikiSearchConfigUpdate): Promise<HostWikiSearchProviderTestResult>;
  onRefresh(): void;
}>;

type Provider = Exclude<HostWikiSearchProvider, 'none'>;
const PROVIDERS: readonly { id: Provider; label: string }[] = [
  { id: 'ollama', label: 'Ollama' }, { id: 'tavily', label: 'Tavily' }, { id: 'serpapi', label: 'SerpApi' },
  { id: 'searxng', label: 'SearXNG' }, { id: 'firecrawl', label: 'Firecrawl' }, { id: 'brave', label: 'Brave Search' }, { id: 'bocha', label: 'Bocha Search' },
];

export function SearchSettingsPanel(props: SearchSettingsPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  return (
    <WikiPanel>
      <WikiPanelHeader title={t('searchSettings.title', { defaultValue: '搜索与向量配置' })} icon={Settings2} actions={<WikiIconButton onClick={props.onRefresh} disabled={props.busy !== null} title={t('common.refresh')}><RefreshCw className="h-4 w-4" /></WikiIconButton>} />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {props.config ? <SettingsForm {...props} config={props.config} /> : <WikiEmpty title={t('searchSettings.loading', { defaultValue: '正在读取搜索配置' })} icon={Settings2} />}
      </div>
    </WikiPanel>
  );
}

function SettingsForm({ config, busy, onSave, onTest }: SearchSettingsPanelProps & { config: HostWikiSearchConfig }): JSX.Element {
  const { t } = useTranslation('wiki');
  const [draft, setDraft] = useState(config);
  const [providerKeys, setProviderKeys] = useState<Partial<Record<Provider, string>>>({});
  const [embeddingKey, setEmbeddingKey] = useState<string | undefined>();
  const [headers, setHeaders] = useState(JSON.stringify(config.embedding.extraHeaders, null, 2));
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const disabled = busy !== null || pending !== null;
  const text = (key: string, defaultValue: string) => t(`searchSettings.${key}`, { defaultValue });

  useEffect(() => {
    setDraft(config);
    setProviderKeys({});
    setEmbeddingKey(undefined);
    setHeaders(JSON.stringify(config.embedding.extraHeaders, null, 2));
  }, [config]);

  function updateProvider(provider: Provider, patch: HostWikiSearchProviderConfigUpdate): void {
    setDraft((current) => ({ ...current, providerConfigs: { ...current.providerConfigs, [provider]: { apiKeyConfigured: false, baseUrl: null, serpApiEngine: null, searXngUrl: null, searXngCategories: null, ollamaUrl: null, ...current.providerConfigs[provider], ...patch } } }));
  }

  function searchPatch(provider = draft.provider): HostWikiSearchConfigUpdate {
    const providerConfigs: HostWikiSearchConfigUpdate['providerConfigs'] = {};
    for (const { id } of PROVIDERS) {
      const value = draft.providerConfigs[id];
      if (!value && providerKeys[id] === undefined) continue;
      providerConfigs[id] = {
        ...(value?.baseUrl == null ? {} : { baseUrl: value.baseUrl }),
        ...(value?.serpApiEngine == null ? {} : { serpApiEngine: value.serpApiEngine }),
        ...(value?.searXngUrl == null ? {} : { searXngUrl: value.searXngUrl }),
        ...(value?.searXngCategories == null ? {} : { searXngCategories: value.searXngCategories }),
        ...(value?.ollamaUrl == null ? {} : { ollamaUrl: value.ollamaUrl }),
        ...(providerKeys[id] === undefined ? {} : { apiKey: providerKeys[id] }),
      };
    }
    return { provider, providerConfigs, deepResearchSource: draft.deepResearchSource, anyTxt: draft.anyTxt };
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled) return;
    setPending('save');
    setError('');
    setNotice('');
    try {
      const extraHeaders: unknown = JSON.parse(headers);
      if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders) || Object.values(extraHeaders).some((value) => typeof value !== 'string')) {
        throw new Error(text('invalidHeaders', '额外请求头必须是字符串键值对 JSON'));
      }
      const { apiKeyConfigured: _configured, ...embedding } = draft.embedding;
      await onSave({ ...searchPatch(), embedding: { ...embedding, extraHeaders: extraHeaders as Record<string, string>, ...(embeddingKey === undefined ? {} : { apiKey: embeddingKey }) } });
      setProviderKeys({});
      setEmbeddingKey(undefined);
      setNotice(text('saved', '配置已保存'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : text('saveFailed', '配置保存失败，请重试'));
    } finally {
      setPending(null);
    }
  }

  async function test(provider: Provider): Promise<void> {
    if (disabled) return;
    setPending(provider);
    setError('');
    setNotice('');
    try {
      const result = await onTest(searchPatch(provider));
      setNotice(result.results.length > 0 ? text('testSuccess', '连接成功，已取得真实搜索结果') : text('testEmpty', '请求成功，但未取得搜索结果'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : text('testFailed', '搜索测试失败，请检查配置'));
    } finally {
      setPending(null);
    }
  }

  return (
    <form onSubmit={(event) => { void save(event); }} className="space-y-4">
      <fieldset disabled={disabled} className="space-y-4 disabled:opacity-70">
        <WikiSurface className="space-y-3 p-4">
          <h3 className="text-sm font-semibold">{text('researchSources', '深度研究来源')}</h3>
          <Field label={text('source', '来源')}><select value={draft.deepResearchSource} onChange={(event) => setDraft({ ...draft, deepResearchSource: event.target.value as HostWikiSearchConfig['deepResearchSource'] })} className="h-9 w-full rounded-md border bg-background px-3 text-sm"><option value="web">{text('web', '网页搜索')}</option><option value="anytxt">AnyTXT</option><option value="both">{text('both', '网页与 AnyTXT')}</option></select></Field>
          <Field label={text('provider', '网页搜索服务')}><select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as HostWikiSearchProvider })} className="h-9 w-full rounded-md border bg-background px-3 text-sm"><option value="none">{text('none', '未启用')}</option>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></Field>
          <p className="text-xs text-muted-foreground">{text('keysPrivate', '密钥仅单向提交，不会从服务端回显；留空保留已配置密钥。')}</p>
        </WikiSurface>
        {PROVIDERS.map(({ id, label }) => {
          const value = draft.providerConfigs[id];
          return (
            <details key={id} className="rounded-2xl border bg-[hsl(var(--shell-surface-muted))] p-4" open={draft.provider === id}>
              <summary className="cursor-pointer text-sm font-semibold">{label}{value?.apiKeyConfigured ? ` · ${text('keyConfigured', '密钥已配置')}` : ''}</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <Field label="API Key"><Input type="password" autoComplete="new-password" value={providerKeys[id] ?? ''} onChange={(event) => setProviderKeys({ ...providerKeys, [id]: event.target.value || undefined })} placeholder={providerKeys[id] === '' ? text('keyWillClear', '保存后清除密钥') : value?.apiKeyConfigured ? text('keepKey', '留空保留现有密钥') : text('enterKey', '输入密钥')} />{value?.apiKeyConfigured ? <Button type="button" size="sm" variant="ghost" onClick={() => setProviderKeys({ ...providerKeys, [id]: providerKeys[id] === '' ? undefined : '' })}>{providerKeys[id] === '' ? text('undoClearKey', '撤销清除') : text('clearKey', '清除密钥')}</Button> : null}</Field>
                <Field label={text('baseUrl', 'API 地址')}><Input value={value?.baseUrl ?? ''} onChange={(event) => updateProvider(id, { baseUrl: event.target.value })} /></Field>
                {id === 'serpapi' ? <Field label={text('serpApiEngine', 'SerpApi 搜索引擎')}><Input value={value?.serpApiEngine ?? ''} onChange={(event) => updateProvider(id, { serpApiEngine: event.target.value })} placeholder="google" /></Field> : null}
                {id === 'searxng' ? <><Field label="SearXNG URL"><Input value={value?.searXngUrl ?? ''} onChange={(event) => updateProvider(id, { searXngUrl: event.target.value })} /></Field><Field label={text('categories', '搜索分类（逗号分隔）')}><Input value={value?.searXngCategories?.join(', ') ?? ''} onChange={(event) => updateProvider(id, { searXngCategories: event.target.value.split(',').map((category) => category.trim()).filter(Boolean) })} /></Field></> : null}
                {id === 'ollama' ? <Field label="Ollama URL"><Input value={value?.ollamaUrl ?? ''} onChange={(event) => updateProvider(id, { ollamaUrl: event.target.value })} /></Field> : null}
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => { void test(id); }} className="mt-3"><Search className="h-4 w-4" />{pending === id ? text('testing', '测试中…') : text('test', '测试连接')}</Button>
            </details>
          );
        })}
        <WikiSurface className="space-y-3 p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">AnyTXT</h3><Switch checked={draft.anyTxt.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, anyTxt: { ...draft.anyTxt, enabled } })} aria-label={text('anyTxtEnabled', '启用 AnyTXT')} /></div>
          <div className="grid gap-3 md:grid-cols-2">
            {(['endpoint', 'filterDir', 'filterExt'] as const).map((key) => <Field key={key} label={text(`anyTxt.${key}`, { endpoint: '服务地址', filterDir: '搜索目录', filterExt: '文件扩展名过滤' }[key])}><Input value={draft.anyTxt[key]} onChange={(event) => setDraft({ ...draft, anyTxt: { ...draft.anyTxt, [key]: event.target.value } })} /></Field>)}
            <Field label={text('anyTxt.limit', '结果数量上限')}><Input type="number" min={1} max={100} required value={draft.anyTxt.limit} onChange={(event) => setDraft({ ...draft, anyTxt: { ...draft.anyTxt, limit: Number(event.target.value) } })} /></Field>
          </div>
          {!draft.anyTxt.filterDir.trim() ? <p className="text-xs text-amber-600">{text('anyTxt.broadWarning', '未限定目录，AnyTXT 将搜索全部已索引文件。')}</p> : null}
        </WikiSurface>
        <WikiSurface className="space-y-3 p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{text('embedding.title', '远程向量模型')}</h3><Switch checked={draft.embedding.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, embedding: { ...draft.embedding, enabled } })} aria-label={text('embedding.enabled', '启用远程向量模型')} /></div>
          <div className="grid gap-3 md:grid-cols-2">
            {(['endpoint', 'model'] as const).map((key) => <Field key={key} label={text(`embedding.${key}`, key === 'endpoint' ? '服务地址' : '模型')}><Input value={draft.embedding[key]} onChange={(event) => setDraft({ ...draft, embedding: { ...draft.embedding, [key]: event.target.value } })} /></Field>)}
            <Field label="API Key"><Input type="password" autoComplete="new-password" value={embeddingKey ?? ''} onChange={(event) => setEmbeddingKey(event.target.value || undefined)} placeholder={embeddingKey === '' ? text('keyWillClear', '保存后清除密钥') : draft.embedding.apiKeyConfigured ? text('keepKey', '留空保留现有密钥') : text('enterKey', '输入密钥')} />{draft.embedding.apiKeyConfigured ? <Button type="button" size="sm" variant="ghost" onClick={() => setEmbeddingKey(embeddingKey === '' ? undefined : '')}>{embeddingKey === '' ? text('undoClearKey', '撤销清除') : text('clearKey', '清除密钥')}</Button> : null}</Field>
            <Field label={text('embedding.dim', '输出维度（留空使用模型默认值）')}><Input type="number" min={1} value={draft.embedding.outputDimensionality ?? ''} onChange={(event) => setDraft({ ...draft, embedding: { ...draft.embedding, outputDimensionality: event.target.value ? Number(event.target.value) : null } })} /></Field>
            {(['maxChunkChars', 'overlapChunkChars', 'batchSize', 'concurrency'] as const).map((key) => <Field key={key} label={text(`embedding.${key}`, { maxChunkChars: '分块字符数', overlapChunkChars: '分块重叠字符数', batchSize: '批次大小', concurrency: '并发数量' }[key])}><Input type="number" min={key === 'overlapChunkChars' ? 0 : 1} required value={draft.embedding[key]} onChange={(event) => setDraft({ ...draft, embedding: { ...draft.embedding, [key]: Number(event.target.value) } })} /></Field>)}
          </div>
          <Field label={text('embedding.extraHeaders', '额外请求头（JSON）')}><Textarea value={headers} onChange={(event) => setHeaders(event.target.value)} className="font-mono text-xs" /></Field>
        </WikiSurface>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      <div className="flex justify-end"><WikiPrimaryButton type="submit" disabled={disabled}>{pending === 'save' ? text('saving', '保存中…') : text('save', '保存配置')}</WikiPrimaryButton></div>
    </form>
  );
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>): JSX.Element {
  return <label className="block space-y-1.5 text-xs font-medium"><span>{label}</span>{children}</label>;
}

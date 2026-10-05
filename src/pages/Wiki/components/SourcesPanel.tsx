import { useEffect, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOpen, ListChecks, Loader2, Search, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchSelectableProviderModels } from '@/lib/provider-models';
import type { WikiFileItem, WikiReceiptSummary, WikiSourceTask, WikiSourceView, WikiSourceWatchConfig, WikiSourceWatchConfigUpdate } from '../wiki-model';
import { formatDateTime, isActiveSourceTask } from '../wiki-model';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader, WikiPrimaryButton, WikiSurface } from './WikiChrome';
import { WikiEmbeddingSettings } from './WikiEmbeddingSettings';
import { SourceTaskProgress } from './SourceTaskProgress';
import { SettingGroup, SettingRow, SelectSettingRow } from './WikiSettings';

export type SourcesPanelProps = Readonly<{
  projectId: string;
  files: readonly WikiFileItem[];
  sourceTasks: readonly WikiSourceTask[];
  sourceTasksError: string | null;
  cancellingSourcePaths: ReadonlySet<string>;
  sourceWatchConfig: WikiSourceWatchConfig;
  lastReceipt: WikiReceiptSummary | null;
  busy: string | null;
  view: WikiSourceView;
  onPickSourceFile(): void;
  onPickSourceFolder(): void;
  onOpenSource(path: string): void;
  onDeleteSourcePath(path: string): void;
  onRescanSources(): void;
  onLoadSourceTasks(): void;
  onSourceWatchEnabledChange(enabled: boolean): void;
  onAutoIngestChange(autoIngest: boolean): void;
  onOutputLanguageChange(outputLanguage: string): void;
  onCaptionEnabledChange(enabled: boolean): void;
  onMineruEnabledChange(enabled: boolean): void;
  onSourceWatchConfigChange(payload: WikiSourceWatchConfigUpdate): Promise<void>;
  onCancelSourceTask(sourcePath: string): void;
}>;

function taskStatusVariant(status: string): 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' {
  const normalized = status.toLowerCase();
  if (['done', 'completed', 'success', 'succeeded'].includes(normalized)) return 'success';
  if (['queued', 'pending', 'running', 'processing', 'retrying'].includes(normalized)) return 'warning';
  if (['failed', 'error'].includes(normalized)) return 'destructive';
  return 'secondary';
}

const OUTPUT_LANGUAGE_OPTIONS = [
  ['auto', 'Auto'],
  ['English', 'English'],
  ['Chinese', '简体中文'],
  ['Traditional Chinese', '繁體中文'],
  ['Japanese', '日本語'],
  ['Korean', '한국어'],
  ['Vietnamese', 'Tiếng Việt'],
  ['French', 'Français'],
  ['German', 'Deutsch'],
  ['Spanish', 'Español'],
  ['Portuguese', 'Português'],
  ['Italian', 'Italiano'],
  ['Russian', 'Русский'],
  ['Arabic', 'العربية'],
  ['Persian', 'فارسی'],
  ['Hindi', 'हिन्दी'],
  ['Turkish', 'Türkçe'],
  ['Dutch', 'Nederlands'],
  ['Polish', 'Polski'],
  ['Czech', 'Čeština'],
  ['Swedish', 'Svenska'],
  ['Indonesian', 'Bahasa Indonesia'],
  ['Thai', 'ไทย'],
  ['Ukrainian', 'Українська'],
] as const;

const MINERU_BACKEND_OPTIONS = [
  ['cloud', 'Cloud'],
  ['local', 'Local'],
] as const;

const MINERU_MODEL_VERSION_OPTIONS = [
  ['vlm', 'VLM'],
  ['pipeline', 'Pipeline'],
] as const;

const MINERU_LOCAL_BACKEND_OPTIONS = [
  ['pipeline', 'Pipeline'],
  ['vlm-engine', 'VLM engine'],
  ['hybrid-engine', 'Hybrid engine'],
  ['vlm-http-client', 'VLM HTTP client'],
  ['hybrid-http-client', 'Hybrid HTTP client'],
] as const;

const MINERU_LOCAL_EFFORT_OPTIONS = [
  ['medium', 'Medium'],
  ['high', 'High'],
] as const;

const MINERU_LOCAL_PARSE_METHOD_OPTIONS = [
  ['auto', 'Auto'],
  ['txt', 'Text'],
  ['ocr', 'OCR'],
] as const;

type SourceModelStatus = 'loading' | 'unavailable' | 'unconfigured' | 'invalid' | 'ready';

type SourceModelOption = Readonly<{
  reference: string;
  references: readonly string[];
  label: string;
}>;

type ModelCatalogLoadState = Readonly<{
  generationModels: readonly SourceModelOption[];
  captionModels: readonly SourceModelOption[];
  generationLoading: boolean;
  captionLoading: boolean;
  generationError: string | null;
  captionError: string | null;
}>;

const EMPTY_MODEL_CATALOG_LOAD_STATE: ModelCatalogLoadState = {
  generationModels: [],
  captionModels: [],
  generationLoading: true,
  captionLoading: true,
  generationError: null,
  captionError: null,
};

function hasModelReference(models: readonly SourceModelOption[], reference: string): boolean {
  const normalized = reference.trim();
  return Boolean(normalized) && models.some((model) => model.references.includes(normalized));
}

function modelSelectOptions(
  models: readonly SourceModelOption[],
  emptyLabel: string,
  selectedRef: string,
  invalidLabel: string,
): readonly (readonly [string, string])[] {
  const options: [string, string][] = [['', emptyLabel]];
  const seen = new Set(['']);
  const selected = selectedRef.trim();
  for (const model of models) {
    const value = selected && model.references.includes(selected) ? selected : model.reference;
    if (seen.has(value)) continue;
    seen.add(value);
    options.push([value, model.label]);
  }
  if (selected && !seen.has(selected)) options.push([selected, invalidLabel]);
  return options;
}

function sourceModelStatus(config: WikiSourceWatchConfig, catalog: ModelCatalogLoadState): SourceModelStatus {
  const generationModelRef = config.generationModelRef.trim();
  const captionModelRef = config.captionModelRef.trim();
  if (catalog.generationLoading || (config.captionEnabled && catalog.captionLoading)) return 'loading';
  if (catalog.generationError || catalog.generationModels.length === 0 || (config.captionEnabled && (catalog.captionError || catalog.captionModels.length === 0))) return 'unavailable';
  if (!generationModelRef || (config.captionEnabled && !captionModelRef)) return 'unconfigured';
  if (!hasModelReference(catalog.generationModels, generationModelRef) || (config.captionEnabled && !hasModelReference(catalog.captionModels, captionModelRef))) return 'invalid';
  return 'ready';
}

function sourceModelStatusVariant(status: SourceModelStatus): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (status === 'ready') return 'success';
  if (status === 'unavailable' || status === 'invalid') return 'destructive';
  if (status === 'unconfigured') return 'warning';
  return 'secondary';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSourceModelOptions(capability: 'chat' | 'imageUnderstand'): Promise<SourceModelOption[]> {
  const models = await fetchSelectableProviderModels(capability);
  return models.map((model) => {
    const references = (model.modelReferences ?? []).map((reference) => reference.trim()).filter(Boolean);
    return { reference: references[0] ?? '', references, label: model.displayLabel };
  }).filter((model) => model.reference);
}

function TextSettingRow(props: Readonly<{ title: string; description: string; value: string; disabled: boolean; saveLabel: string; onChange(value: string): void; onSubmit(): Promise<void> }>): JSX.Element {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void props.onSubmit();
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-4 border-b border-border/60 px-4 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 max-w-xl text-sm text-muted-foreground">{props.description}</div>
      </div>
      <Input value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} className="h-9 w-72 text-sm" />
      <Button type="submit" size="sm" variant="outline" disabled={props.disabled} className="h-9 rounded-full bg-card">{props.saveLabel}</Button>
    </form>
  );
}

function SecretSettingRow(props: Readonly<{ title: string; description: string; value: string; configured: boolean; disabled: boolean; configuredLabel: string; notConfiguredLabel: string; placeholder: string; saveLabel: string; onChange(value: string): void; onSubmit(): Promise<void> }>): JSX.Element {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!props.value.trim()) return;
    void props.onSubmit();
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-4 border-b border-border/60 px-4 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 max-w-xl text-sm text-muted-foreground">{props.description}</div>
        <div className="mt-1 text-xs text-muted-foreground">{props.configured ? props.configuredLabel : props.notConfiguredLabel}</div>
      </div>
      <Input type="password" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} placeholder={props.placeholder} className="h-9 w-72 text-sm" />
      <Button type="submit" size="sm" variant="outline" disabled={props.disabled || !props.value.trim()} className="h-9 rounded-full bg-card">{props.saveLabel}</Button>
    </form>
  );
}

function SettingSubgroup(props: Readonly<{ title: string; description: string; children: ReactNode }>): JSX.Element {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="bg-secondary/40 px-4 py-3">
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 max-w-xl text-sm text-muted-foreground">{props.description}</div>
      </div>
      <div className="border-t border-border/60">{props.children}</div>
    </div>
  );
}

export function SourcesPanel(props: SourcesPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const {
    files,
    sourceTasks,
    sourceTasksError,
    cancellingSourcePaths,
    sourceWatchConfig,
    lastReceipt,
    busy,
    view,
    onPickSourceFile,
    onPickSourceFolder,
    onOpenSource,
    onDeleteSourcePath,
    onRescanSources,
    onLoadSourceTasks,
    onSourceWatchEnabledChange,
    onAutoIngestChange,
    onOutputLanguageChange,
    onCaptionEnabledChange,
    onMineruEnabledChange,
    onSourceWatchConfigChange,
    onCancelSourceTask,
  } = props;

  const [mineruToken, setMineruToken] = useState('');
  const [mineruLocalToken, setMineruLocalToken] = useState('');
  const [mineruLocalEndpoint, setMineruLocalEndpoint] = useState(sourceWatchConfig.mineruLocalEndpoint);
  const [mineruLocalLanguage, setMineruLocalLanguage] = useState(sourceWatchConfig.mineruLocalLanguage);
  const [mineruLocalServerUrl, setMineruLocalServerUrl] = useState(sourceWatchConfig.mineruLocalServerUrl);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogLoadState>(EMPTY_MODEL_CATALOG_LOAD_STATE);
  const sourceFiles = files;
  const visibleSourceTasks = sourceTasks.slice(0, 8);
  const isBusy = busy !== null;
  const latestReceiptText = lastReceipt === null ? null : t('sources.receipt', lastReceipt);
  const inSettings = view === 'settings';
  const modelStatus = sourceModelStatus(sourceWatchConfig, modelCatalog);
  const modelActionDisabled = isBusy || modelStatus !== 'ready';
  const generationModelOptions = modelSelectOptions(
    modelCatalog.generationModels,
    t('sources.modelNone'),
    sourceWatchConfig.generationModelRef,
    t('sources.modelInvalidOption'),
  );
  const captionModelOptions = modelSelectOptions(
    modelCatalog.captionModels,
    t('sources.modelNone'),
    sourceWatchConfig.captionModelRef,
    t('sources.modelInvalidOption'),
  );

  useEffect(() => {
    setMineruLocalEndpoint(sourceWatchConfig.mineruLocalEndpoint);
    setMineruLocalLanguage(sourceWatchConfig.mineruLocalLanguage);
    setMineruLocalServerUrl(sourceWatchConfig.mineruLocalServerUrl);
  }, [sourceWatchConfig.mineruLocalEndpoint, sourceWatchConfig.mineruLocalLanguage, sourceWatchConfig.mineruLocalServerUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [generationResult, captionResult] = await Promise.allSettled([
        loadSourceModelOptions('chat'),
        loadSourceModelOptions('imageUnderstand'),
      ]);
      if (cancelled) return;
      setModelCatalog({
        generationModels: generationResult.status === 'fulfilled' ? generationResult.value : [],
        captionModels: captionResult.status === 'fulfilled' ? captionResult.value : [],
        generationLoading: false,
        captionLoading: false,
        generationError: generationResult.status === 'rejected' ? errorMessage(generationResult.reason) : null,
        captionError: captionResult.status === 'rejected' ? errorMessage(captionResult.reason) : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submitMineruToken = async () => {
    const value = mineruToken.trim();
    if (!value) return;
    await onSourceWatchConfigChange({ mineruToken: value });
    setMineruToken('');
  };

  const submitMineruLocalToken = async () => {
    const value = mineruLocalToken.trim();
    if (!value) return;
    await onSourceWatchConfigChange({ mineruLocalToken: value });
    setMineruLocalToken('');
  };

  const panelActions = inSettings ? undefined : (
    <>
      <WikiPrimaryButton size="sm" onClick={onPickSourceFile} disabled={modelActionDisabled}>
        {busy === 'import-source' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <FileText className="h-4 w-4" />}
        {t(busy === 'import-source' ? 'sourceProgress.importingFile' : 'sources.importFile')}
      </WikiPrimaryButton>
      <Button size="sm" variant="outline" onClick={onPickSourceFolder} disabled={modelActionDisabled} className="h-8 rounded-full bg-card">
        {busy === 'import-folder' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <FolderOpen className="h-4 w-4" />}
        {t(busy === 'import-folder' ? 'sourceProgress.importingFolder' : 'sources.folder')}
      </Button>
      <Button size="sm" variant="outline" onClick={onRescanSources} disabled={modelActionDisabled} className="h-8 rounded-full bg-card">
        <Search className="h-4 w-4" />
        {t('sources.scanSources')}
      </Button>
    </>
  );

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={inSettings ? t('sources.settingsTitle') : t('sources.title')}
        subtitle={inSettings ? t('sources.settingsSubtitle') : t('sources.subtitle', { sources: sourceFiles.length, records: sourceTasks.length })}
        icon={inSettings ? Settings2 : FileText}
        meta={<Badge variant={sourceModelStatusVariant(modelStatus)}>{t(`sources.modelStatus.${modelStatus}`)}</Badge>}
        actions={panelActions}
      />

      {latestReceiptText ? <div className="shrink-0 border-b border-border/70 px-5 py-2 text-xs text-muted-foreground">{latestReceiptText}</div> : null}

      {inSettings ? (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <section className="mx-auto max-w-3xl">
            <div className="space-y-3">
              <WikiSurface>
                <SettingRow
                  title={t('sources.watchTitle')}
                  description={t('sources.watchDescription')}
                  checked={sourceWatchConfig.enabled}
                  disabled={isBusy}
                  onChange={onSourceWatchEnabledChange}
                />
                <SettingRow
                  title={t('sources.autoImportTitle')}
                  description={t('sources.autoImportDescription')}
                  checked={sourceWatchConfig.autoIngest}
                  disabled={isBusy}
                  onChange={onAutoIngestChange}
                />
                <SettingRow
                  title={t('sources.captionTitle')}
                  description={t('sources.captionDescription', { concurrency: sourceWatchConfig.captionConcurrency })}
                  checked={sourceWatchConfig.captionEnabled}
                  disabled={isBusy}
                  onChange={onCaptionEnabledChange}
                />
                <SelectSettingRow
                  title={t('sources.generationModelTitle')}
                  description={t('sources.generationModelDescription')}
                  value={sourceWatchConfig.generationModelRef}
                  disabled={isBusy || modelCatalog.generationLoading || modelCatalog.generationModels.length === 0}
                  options={generationModelOptions}
                  onChange={(generationModelRef) => { void onSourceWatchConfigChange({ generationModelRef }); }}
                />
                <SelectSettingRow
                  title={t('sources.captionModelTitle')}
                  description={t('sources.captionModelDescription')}
                  value={sourceWatchConfig.captionModelRef}
                  disabled={isBusy || modelCatalog.captionLoading || modelCatalog.captionModels.length === 0}
                  options={captionModelOptions}
                  onChange={(captionModelRef) => { void onSourceWatchConfigChange({ captionModelRef }); }}
                />
                <SelectSettingRow
                  title={t('sources.outputLanguageTitle')}
                  description={t('sources.outputLanguageDescription')}
                  value={sourceWatchConfig.outputLanguage}
                  disabled={isBusy}
                  options={OUTPUT_LANGUAGE_OPTIONS}
                  onChange={onOutputLanguageChange}
                />
              </WikiSurface>
              <WikiEmbeddingSettings projectId={props.projectId} busy={isBusy} />
              <SettingGroup title={t('sources.mineruTitle')} description={t('sources.mineruDescription')}>
                <SettingSubgroup title={t('sources.mineruBasicTitle')} description={t('sources.mineruBasicDescription')}>
                  <SettingRow
                    title={t('sources.mineruEnabledTitle')}
                    description={t('sources.mineruEnabledDescription')}
                    checked={sourceWatchConfig.mineruEnabled}
                    disabled={isBusy}
                    onChange={onMineruEnabledChange}
                  />
                  <SelectSettingRow
                    title={t('sources.mineruBackendTitle')}
                    description={t('sources.mineruBackendDescription')}
                    value={sourceWatchConfig.mineruBackend}
                    disabled={isBusy}
                    options={MINERU_BACKEND_OPTIONS}
                    onChange={(mineruBackend) => { void onSourceWatchConfigChange({ mineruBackend }); }}
                  />
                </SettingSubgroup>
                <SettingSubgroup title={t('sources.mineruCloudTitle')} description={t('sources.mineruCloudDescription')}>
                  <SecretSettingRow
                    title={t('sources.mineruTokenTitle')}
                    description={t('sources.mineruTokenDescription')}
                    value={mineruToken}
                    configured={sourceWatchConfig.mineruTokenConfigured}
                    disabled={isBusy}
                    configuredLabel={t('sources.tokenConfigured')}
                    notConfiguredLabel={t('sources.tokenNotConfigured')}
                    placeholder={t('sources.tokenPlaceholder')}
                    saveLabel={t('content.save')}
                    onChange={setMineruToken}
                    onSubmit={submitMineruToken}
                  />
                  <SelectSettingRow
                    title={t('sources.mineruModelVersionTitle')}
                    description={t('sources.mineruModelVersionDescription')}
                    value={sourceWatchConfig.mineruModelVersion}
                    disabled={isBusy}
                    options={MINERU_MODEL_VERSION_OPTIONS}
                    onChange={(mineruModelVersion) => { void onSourceWatchConfigChange({ mineruModelVersion }); }}
                  />
                </SettingSubgroup>
                <SettingSubgroup title={t('sources.mineruLocalTitle')} description={t('sources.mineruLocalDescription')}>
                  <TextSettingRow
                    title={t('sources.mineruLocalEndpointTitle')}
                    description={t('sources.mineruLocalEndpointDescription')}
                    value={mineruLocalEndpoint}
                    disabled={isBusy}
                    saveLabel={t('content.save')}
                    onChange={setMineruLocalEndpoint}
                    onSubmit={() => onSourceWatchConfigChange({ mineruLocalEndpoint: mineruLocalEndpoint.trim() })}
                  />
                  <SecretSettingRow
                    title={t('sources.mineruLocalTokenTitle')}
                    description={t('sources.mineruLocalTokenDescription')}
                    value={mineruLocalToken}
                    configured={sourceWatchConfig.mineruLocalTokenConfigured}
                    disabled={isBusy}
                    configuredLabel={t('sources.tokenConfigured')}
                    notConfiguredLabel={t('sources.tokenNotConfigured')}
                    placeholder={t('sources.tokenPlaceholder')}
                    saveLabel={t('content.save')}
                    onChange={setMineruLocalToken}
                    onSubmit={submitMineruLocalToken}
                  />
                  <SelectSettingRow
                    title={t('sources.mineruLocalBackendTitle')}
                    description={t('sources.mineruLocalBackendDescription')}
                    value={sourceWatchConfig.mineruLocalBackend}
                    disabled={isBusy}
                    options={MINERU_LOCAL_BACKEND_OPTIONS}
                    onChange={(mineruLocalBackend) => { void onSourceWatchConfigChange({ mineruLocalBackend }); }}
                  />
                  <SelectSettingRow
                    title={t('sources.mineruLocalEffortTitle')}
                    description={t('sources.mineruLocalEffortDescription')}
                    value={sourceWatchConfig.mineruLocalEffort}
                    disabled={isBusy}
                    options={MINERU_LOCAL_EFFORT_OPTIONS}
                    onChange={(mineruLocalEffort) => { void onSourceWatchConfigChange({ mineruLocalEffort }); }}
                  />
                  <SelectSettingRow
                    title={t('sources.mineruLocalParseMethodTitle')}
                    description={t('sources.mineruLocalParseMethodDescription')}
                    value={sourceWatchConfig.mineruLocalParseMethod}
                    disabled={isBusy}
                    options={MINERU_LOCAL_PARSE_METHOD_OPTIONS}
                    onChange={(mineruLocalParseMethod) => { void onSourceWatchConfigChange({ mineruLocalParseMethod }); }}
                  />
                  <TextSettingRow
                    title={t('sources.mineruLocalLanguageTitle')}
                    description={t('sources.mineruLocalLanguageDescription')}
                    value={mineruLocalLanguage}
                    disabled={isBusy}
                    saveLabel={t('content.save')}
                    onChange={setMineruLocalLanguage}
                    onSubmit={() => onSourceWatchConfigChange({ mineruLocalLanguage: mineruLocalLanguage.trim() })}
                  />
                  <SettingRow
                    title={t('sources.mineruLocalFormulaTitle')}
                    description={t('sources.mineruLocalFormulaDescription')}
                    checked={sourceWatchConfig.mineruLocalFormulaEnabled}
                    disabled={isBusy}
                    onChange={(mineruLocalFormulaEnabled) => { void onSourceWatchConfigChange({ mineruLocalFormulaEnabled }); }}
                  />
                  <SettingRow
                    title={t('sources.mineruLocalTableTitle')}
                    description={t('sources.mineruLocalTableDescription')}
                    checked={sourceWatchConfig.mineruLocalTableEnabled}
                    disabled={isBusy}
                    onChange={(mineruLocalTableEnabled) => { void onSourceWatchConfigChange({ mineruLocalTableEnabled }); }}
                  />
                  <SettingRow
                    title={t('sources.mineruLocalImageAnalysisTitle')}
                    description={t('sources.mineruLocalImageAnalysisDescription')}
                    checked={sourceWatchConfig.mineruLocalImageAnalysis}
                    disabled={isBusy}
                    onChange={(mineruLocalImageAnalysis) => { void onSourceWatchConfigChange({ mineruLocalImageAnalysis }); }}
                  />
                  <TextSettingRow
                    title={t('sources.mineruLocalServerUrlTitle')}
                    description={t('sources.mineruLocalServerUrlDescription')}
                    value={mineruLocalServerUrl}
                    disabled={isBusy}
                    saveLabel={t('content.save')}
                    onChange={setMineruLocalServerUrl}
                    onSubmit={() => onSourceWatchConfigChange({ mineruLocalServerUrl: mineruLocalServerUrl.trim() })}
                  />
                </SettingSubgroup>
              </SettingGroup>
            </div>
          </section>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0 overflow-auto p-5">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm">
              <h3 className="font-medium">{t('sources.documents')}</h3>
              <span className="text-xs text-muted-foreground">{sourceFiles.length}</span>
            </div>
            {sourceFiles.length > 0 ? (
              <WikiSurface>
                {sourceFiles.map((file) => (
                  <div key={file.path} className="flex min-w-0 items-center gap-3 border-b border-border/60 px-3 py-2.5 text-sm last:border-b-0">
                    <button type="button" onClick={() => onOpenSource(file.path)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{file.label}</div>
                        <div className="truncate text-xs text-muted-foreground">{file.path}</div>
                      </div>
                    </button>
                    <div className="shrink-0 text-xs text-muted-foreground">{formatDateTime(file.modifiedAtMs, t('time.unrecorded'))}</div>
                    <Button size="sm" variant="ghost" onClick={() => onDeleteSourcePath(file.path)} disabled={isBusy}>{t('common.delete')}</Button>
                  </div>
                ))}
              </WikiSurface>
            ) : (
              <WikiEmpty title={t('sources.emptyDocuments')} />
            )}
          </section>

          <aside className="min-w-0 overflow-auto border-l border-border/70 p-5">
            <div className="mb-3 flex items-center justify-between gap-3 text-sm">
              <h3 className="font-medium">{t('sources.activityLog')}</h3>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">{sourceTasks.length}</span>
                <WikiIconButton onClick={onLoadSourceTasks} title={t('sources.refreshRecords')} className="h-7 w-7">
                  <ListChecks className="h-4 w-4" />
                </WikiIconButton>
              </div>
            </div>
            {sourceTasksError ? <div role="status" className="mb-3 text-xs text-destructive">{sourceTasksError}</div> : null}
            {visibleSourceTasks.length > 0 ? (
              <div className="space-y-2">
                {visibleSourceTasks.map((task) => (
                  <div key={task.id} className="rounded-2xl border border-border/70 bg-card px-3 py-2.5 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant={taskStatusVariant(task.status)}>{t(`sourceProgress.status.${task.status}`, { defaultValue: task.status })}</Badge>
                      <Badge variant="outline">{t(`sourceProgress.kind.${task.kind}`, { defaultValue: task.kind })}</Badge>
                      <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(task.updatedAtMs, t('time.unrecorded'))}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{task.sourcePath}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <SourceTaskProgress task={task} />
                      {isActiveSourceTask(task) && task.cancelRequestedAtMs === null ? <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" disabled={cancellingSourcePaths.has(task.sourcePath)} onClick={() => onCancelSourceTask(task.sourcePath)}>{t(cancellingSourcePaths.has(task.sourcePath) ? 'sourceProgress.cancelling' : 'common.cancel')}</Button> : null}
                    </div>
                    {task.error ? <div className="mt-2 rounded-lg bg-destructive/10 px-2 py-1 text-xs text-destructive">{task.error}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <WikiEmpty title={t('sources.emptyRecords')} />
            )}
          </aside>
        </div>
      )}
    </WikiPanel>
  );
}

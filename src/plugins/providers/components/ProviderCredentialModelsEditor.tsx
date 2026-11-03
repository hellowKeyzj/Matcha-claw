import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StableScrollArea } from '@/components/scroll';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProviderCredential } from '@/plugins/providers/stores/providers';
import type { ProviderVendorInfo } from '@/plugins/providers/domain/providers';
import {
  type ModelCapability,
  type ProviderModelDraft,
  ProviderDiscoveryError,
} from '@/plugins/providers/services/provider-model-catalog';
import {
  filterAllowedModelCapabilities,
  MODEL_CAPABILITIES,
  resolveProviderModelCapabilities,
} from '@/plugins/providers/domain/provider-model-capabilities';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import { providerModelSources, type ProviderModelSourceContribution, type ProviderSecretInput } from '../extensions';
import styles from '@/plugins/providers/components/ProviderCredentialModelsEditor.module.css';

import { modelToDraftRow, type ModelDraftRow } from '../forms/provider-model-draft';

const EMPTY_MODEL_DRAFT: ModelDraftRow = {
  modelId: '',
  capabilities: [],
  contextWindow: '',
  maxTokens: '',
  timeoutMs: '',
  aspectRatio: '',
  resolution: '',
  quality: '',
};

const OPENCLAW_DEFAULT_CONTEXT_WINDOW = '128000';
const OPENCLAW_DEFAULT_MAX_TOKENS = '8192';
const TEXT_TUNING_CAPABILITIES = ['chat', 'imageUnderstand'] as const satisfies readonly ModelCapability[];

function hasTextTuningFields(credential: ProviderCredential, row: Pick<ModelDraftRow, 'capabilities'>): boolean {
  if (credential.providerKind === 'media') return false;
  return row.capabilities.some((capability) => TEXT_TUNING_CAPABILITIES.includes(capability as typeof TEXT_TUNING_CAPABILITIES[number]));
}

function hasImageGenerationFields(row: Pick<ModelDraftRow, 'capabilities'>): boolean {
  return row.capabilities.includes('imageGenerate') || row.capabilities.includes('videoGenerate');
}

export function ProviderCredentialModelsEditor({ credential, vendor, secret, rows, onChange, disabled, discoveryDisabled }: {
  credential: ProviderCredential;
  vendor?: ProviderVendorInfo;
  secret: ProviderSecretInput;
  rows: ModelDraftRow[];
  onChange: (rows: ModelDraftRow[]) => void;
  disabled: boolean;
  discoveryDisabled: boolean;
}) {
  const { t } = useTranslation('settings');
  const allowedCapabilities = resolveProviderModelCapabilities(credential, vendor);
  const modelSources = useContributions(providerModelSources);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set());
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModelDraft[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryCollapsed, setDiscoveryCollapsed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setDiscoveredModels([]);
    setSelectedIds([]);
    setDiscoveryAttempted(false);
    setDiscoveryError(null);
    setDiscovering(false);
    return () => { generation.current += 1; };
  }, [credential.id, credential.baseUrl, credential.apiProtocol, credential.mediaApiProtocol, credential.providerKind, credential.authMode, secret.apiKey, secret.token]);
  const currentModelIds = new Set(rows.map((row) => row.modelId.trim()).filter(Boolean));
  const selected = new Set(selectedIds);
  const importable = discoveredModels.filter((model) => selected.has(model.modelId) && !currentModelIds.has(model.modelId));

  const discover = async (source: Extract<ProviderModelSourceContribution, { kind: 'discovery' }>) => {
    if (discovering) return;
    const request = ++generation.current;
    setDiscovering(true);
    setDiscoveryCollapsed(false);
    setDiscoveryError(null);
    try {
      const models = await source.discover(credential, secret);
      if (request !== generation.current) return;
      setDiscoveredModels(models);
      setSelectedIds(models.map((model) => model.modelId));
      setDiscoveryAttempted(true);
    } catch (error) {
      if (request !== generation.current) return;
      setDiscoveredModels([]);
      setSelectedIds([]);
      setDiscoveryError(error instanceof ProviderDiscoveryError ? error.reason : 'unavailable');
      setDiscoveryAttempted(true);
    } finally {
      if (request === generation.current) setDiscovering(false);
    }
  };
  const add = (model?: ProviderModelDraft) => {
    if (model && currentModelIds.has(model.modelId)) return;
    setExpandedRows((current) => new Set([...current, rows.length]));
    onChange([...rows, model ? modelToDraftRow(model) : { ...EMPTY_MODEL_DRAFT, capabilities: [] }]);
  };
  const change = (index: number, patch: Partial<ModelDraftRow>) => onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));

  return (
    <section className="space-y-3 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('providerModels.title')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {modelSources.map((source) => {
            if (source.kind === 'discovery') return (
              <Button key={source.id} type="button" variant="outline" size="sm" disabled={disabled || discoveryDisabled || discovering} onClick={() => void discover(source)}>
                {discovering ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
                {t(source.label)}
              </Button>
            );
            const model = credential.providerKind === 'media' ? undefined : source.model(vendor);
            if (!model) return null;
            return <Button key={source.id} type="button" variant="outline" size="sm" disabled={disabled || currentModelIds.has(model.modelId)} onClick={() => add(model)}>{t(currentModelIds.has(model.modelId) ? source.addedLabel : source.label, { model: model.modelId })}</Button>;
          })}
          <Button type="button" variant="outline" size="sm" onClick={() => add()} disabled={disabled}>
            <Plus className="mr-2 h-3.5 w-3.5" />{t('providerModels.actions.add')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('providerModels.draftHelp')}</p>
      <ProviderDiscoveredModelsPanel
        credential={credential} vendor={vendor} models={discoveredModels} selectedModelIds={selected} existingModelIds={currentModelIds}
        discoveryAttempted={discoveryAttempted} discovering={discovering} collapsed={discoveryCollapsed} error={discoveryError}
        importableCount={importable.length} disabled={disabled}
        onToggle={(id, checked) => setSelectedIds((current) => checked ? [...current, id] : current.filter((item) => item !== id))}
        onImport={() => { onChange([...rows, ...importable.map((model) => ({ ...modelToDraftRow(model), capabilities: filterAllowedModelCapabilities(credential, model.capabilities, vendor) }))]); setSelectedIds([]); setDiscoveryCollapsed(true); }}
        onCollapsedChange={setDiscoveryCollapsed} t={t}
      />
      {rows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t('providerModels.group.empty')}</p> : (
        <div className={cn(styles.list, 'rounded-lg border')}>
          {rows.map((row, index) => (
            <ProviderModelDraftRow key={index} credential={credential} row={row} allowedCapabilities={allowedCapabilities} disabled={disabled}
              advancedOpen={expandedRows.has(index)} onAdvancedToggle={() => setExpandedRows((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}
              onChange={(patch) => change(index, patch)}
              onToggleCapability={(capability) => change(index, { capabilities: row.capabilities.includes(capability) ? row.capabilities.filter((item) => item !== capability) : [...row.capabilities, capability] })}
              onRemove={() => { onChange(rows.filter((_, i) => i !== index)); setExpandedRows((current) => new Set([...current].filter((i) => i !== index).map((i) => i > index ? i - 1 : i))); }} t={t}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProviderDiscoveredModelsPanel(props: {
  credential: ProviderCredential;
  vendor?: ProviderVendorInfo;
  models: ProviderModelDraft[];
  selectedModelIds: ReadonlySet<string>;
  existingModelIds: ReadonlySet<string>;
  discoveryAttempted: boolean;
  discovering: boolean;
  collapsed: boolean;
  error: string | null;
  importableCount: number;
  disabled: boolean;
  onToggle: (modelId: string, checked: boolean) => void;
  onImport: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
  t: ReturnType<typeof useTranslation>[0];
}) {
  const {
    credential,
    vendor,
    models,
    selectedModelIds,
    existingModelIds,
    discoveryAttempted,
    discovering,
    collapsed,
    error,
    importableCount,
    disabled,
    onToggle,
    onImport,
    onCollapsedChange,
    t,
  } = props;
  if (!discoveryAttempted && !discovering && !error) return null;
  return (
    <div className="border-b border-border/70 px-3 py-2.5">
      <div className={cn('flex items-center justify-between gap-2', !collapsed && 'mb-2')}>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-muted-foreground"
          onClick={() => onCollapsedChange(!collapsed)}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{t('providerModels.discovery.title')}</span>
          {!discovering && models.length > 0 ? (
            <span className="shrink-0 font-normal">{t('providerModels.discovery.count', { count: models.length })}</span>
          ) : null}
        </button>
        {!collapsed && !discovering && !error && models.length > 0 ? (
          <Button variant="outline" size="sm" onClick={onImport} disabled={disabled || importableCount === 0} className="h-7">
            {t('providerModels.discovery.importSelected')}
          </Button>
        ) : null}
      </div>
      {collapsed ? null : discovering ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t('providerModels.discovery.loading')}</span>
        </div>
      ) : error ? (
        <p className="text-xs text-destructive">
          {t(`providerModels.discovery.reasons.${error}`)}
        </p>
      ) : models.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('providerModels.discovery.empty')}</p>
      ) : (
        <StableScrollArea className="max-h-[240px] space-y-1 overflow-y-auto overscroll-contain bg-background pr-1 [scrollbar-gutter:stable]">
          {models.map((model) => {
            const capabilities = filterAllowedModelCapabilities(credential, model.capabilities, vendor);
            const duplicate = existingModelIds.has(model.modelId);
            const selectable = !duplicate;
            return (
              <label
                key={model.modelId}
                className={cn(
                  'flex items-start gap-2 rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs',
                  !selectable && 'opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selectable && selectedModelIds.has(model.modelId)}
                  disabled={disabled || !selectable}
                  onChange={(event) => onToggle(model.modelId, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-foreground">{model.modelId}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {capabilities.length === 0 ? <span>{t('providerModels.discovery.chooseCapabilities')}</span> : null}
                    {capabilities.map((capability) => (
                      <span key={capability} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t(`providerModels.capabilities.${capability}`, capability)}
                      </span>
                    ))}
                    {duplicate ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t('providerModels.discovery.duplicate')}
                      </span>
                    ) : null}
                  </span>
                </span>
              </label>
            );
          })}
        </StableScrollArea>
      )}
    </div>
  );
}

function ProviderModelDraftRow(props: {
  credential: ProviderCredential;
  row: ModelDraftRow;
  allowedCapabilities: readonly ModelCapability[];
  disabled: boolean;
  advancedOpen: boolean;
  onAdvancedToggle: () => void;
  onChange: (patch: Partial<ModelDraftRow>) => void;
  onToggleCapability: (capability: ModelCapability) => void;
  onRemove: () => void;
  t: ReturnType<typeof useTranslation>[0];
}) {
  const { credential, row, allowedCapabilities, disabled, advancedOpen, onAdvancedToggle, onChange, onToggleCapability, onRemove, t } = props;
  const showTextTuning = hasTextTuningFields(credential, row);
  const showImageGeneration = hasImageGenerationFields(row);
  const hasTuningFields = row.capabilities.length > 0;
  return (
    <div className={cn(styles.row, 'gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0')}>
      <div className={cn(styles.model, 'min-w-0')}>
        <label className={cn(styles.label, 'mb-1 text-[11px] font-medium text-muted-foreground')}>
          {t('providerModels.row.modelIdLabel')}
        </label>
        <Input
          aria-label={t('providerModels.row.modelIdLabel')}
          value={row.modelId}
          onChange={(event) => onChange({ modelId: event.target.value })}
          disabled={disabled}
          spellCheck={false}
          placeholder={t('providerModels.row.modelIdPlaceholder')}
          className="h-9 rounded-md bg-background px-3 text-sm"
        />
      </div>
      <div className="min-w-0">
        <label className={cn(styles.label, 'mb-1 text-[11px] font-medium text-muted-foreground')}>
          {t('providerModels.row.capabilitiesLabel')}
        </label>
        <div className="flex flex-wrap gap-1">
          {MODEL_CAPABILITIES.filter((capability) => allowedCapabilities.includes(capability) || row.capabilities.includes(capability)).map((capability) => (
            <button
              key={capability}
              type="button"
              disabled={disabled}
              onClick={() => onToggleCapability(capability)}
              aria-pressed={row.capabilities.includes(capability)}
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-xs transition-colors',
                row.capabilities.includes(capability)
                  ? 'border-foreground/20 bg-foreground text-background'
                  : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted',
              )}
            >
              {t(`providerModels.capabilities.${capability}`, capability)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1 justify-self-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
          onClick={onAdvancedToggle}
          disabled={disabled || !hasTuningFields}
          aria-expanded={advancedOpen}
        >
          {t('providerModels.row.advanced')}
          {advancedOpen ? <ChevronDown className="ml-1 h-3.5 w-3.5" /> : <ChevronRight className="ml-1 h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t('providerModels.row.remove')}
          title={t('providerModels.row.remove')}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {hasTuningFields && advancedOpen ? (
        <div className="col-span-full grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2 rounded-md bg-muted/30 p-2">
          {showTextTuning ? (
            <>
              <LabeledModelField label={t('providerModels.row.contextWindowLabel')}>
                <Input
                  aria-label={t('providerModels.row.contextWindowLabel')}
                  value={row.contextWindow}
                  onChange={(event) => onChange({ contextWindow: event.target.value })}
                  disabled={disabled}
                  spellCheck={false}
                  placeholder={OPENCLAW_DEFAULT_CONTEXT_WINDOW}
                  className="h-9 rounded-md bg-background px-2 text-sm"
                />
              </LabeledModelField>
              <LabeledModelField label={t('providerModels.row.maxTokensLabel')}>
                <Input
                  aria-label={t('providerModels.row.maxTokensLabel')}
                  value={row.maxTokens}
                  onChange={(event) => onChange({ maxTokens: event.target.value })}
                  disabled={disabled}
                  spellCheck={false}
                  placeholder={OPENCLAW_DEFAULT_MAX_TOKENS}
                  className="h-9 rounded-md bg-background px-2 text-sm"
                />
              </LabeledModelField>
            </>
          ) : null}
              <LabeledModelField label={t('providerModels.row.timeoutMsLabel')}>
                <Input
                  aria-label={t('providerModels.row.timeoutMsLabel')}
                  value={row.timeoutMs}
                  onChange={(event) => onChange({ timeoutMs: event.target.value })}
                  disabled={disabled}
                  spellCheck={false}
                  placeholder="60000"
                  className="h-9 rounded-md bg-background px-2 text-sm"
                />
              </LabeledModelField>
          {showImageGeneration ? (
            <>
              {(['aspectRatio', 'resolution', 'quality'] as const).map((field) => (
                <LabeledModelField key={field} label={t(`providerModels.row.${field}Label`)}>
                  <Input aria-label={t(`providerModels.row.${field}Label`)} value={row[field]}
                    onChange={(event) => onChange({ [field]: event.target.value })} disabled={disabled}
                    spellCheck={false} placeholder={t('providerModels.row.defaultOption')} className="h-9 rounded-md bg-background px-2 text-sm" />
                </LabeledModelField>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LabeledModelField(props: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

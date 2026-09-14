import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ProviderCredential } from '@/stores/providers';
import type { ProviderVendorInfo } from '@/lib/providers';
import {
  discoverProviderModels,
  type ModelCapability,
  type ProviderModel,
  type ProviderModelDraft,
} from '@/lib/provider-model-catalog';
import {
  filterAllowedModelCapabilities,
  MODEL_CAPABILITIES,
  resolveProviderModelCapabilities,
} from '@/lib/provider-model-capabilities';
import { cn } from '@/lib/utils';

interface ModelDraftRow {
  modelId: string;
  capabilities: ModelCapability[];
  contextWindow: string;
  maxTokens: string;
  timeoutMs: string;
  aspectRatio: string;
  resolution: string;
  quality: string;
}

const EMPTY_MODEL_DRAFT: ModelDraftRow = {
  modelId: '',
  capabilities: ['chat'],
  contextWindow: '',
  maxTokens: '',
  timeoutMs: '',
  aspectRatio: '',
  resolution: '',
  quality: '',
};

const OPENCLAW_DEFAULT_CONTEXT_WINDOW = '128000';
const OPENCLAW_DEFAULT_MAX_TOKENS = '8192';
const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'] as const;
const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;
const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
const TEXT_TUNING_CAPABILITIES = ['chat', 'imageUnderstand'] as const satisfies readonly ModelCapability[];

function modelToDraftRow(model: ProviderModelDraft): ModelDraftRow {
  return {
    modelId: model.modelId,
    capabilities: [...model.capabilities],
    contextWindow: model.contextWindow ? String(model.contextWindow) : '',
    maxTokens: model.maxTokens ? String(model.maxTokens) : '',
    timeoutMs: model.timeoutMs ? String(model.timeoutMs) : '',
    aspectRatio: model.aspectRatio ?? '',
    resolution: model.resolution ?? '',
    quality: model.quality ?? '',
  };
}

function parsePositiveInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hasTextTuningFields(credential: ProviderCredential, row: Pick<ModelDraftRow, 'capabilities'>): boolean {
  if (credential.providerKind === 'media') return false;
  return row.capabilities.some((capability) => TEXT_TUNING_CAPABILITIES.includes(capability as typeof TEXT_TUNING_CAPABILITIES[number]));
}

function hasImageGenerationFields(row: Pick<ModelDraftRow, 'capabilities'>): boolean {
  return row.capabilities.includes('imageGenerate');
}

function draftRowToModel(credential: ProviderCredential, row: ModelDraftRow): Omit<ProviderModel, 'accountId'> | null {
  const modelId = row.modelId.trim();
  if (!modelId || row.capabilities.length === 0) return null;
  const includeTextTuning = hasTextTuningFields(credential, row);
  const includeImageGeneration = hasImageGenerationFields(row);
  const contextWindow = includeTextTuning ? parsePositiveInteger(row.contextWindow) : undefined;
  const maxTokens = includeTextTuning ? parsePositiveInteger(row.maxTokens) : undefined;
  const timeoutMs = includeImageGeneration ? parsePositiveInteger(row.timeoutMs) : undefined;
  const aspectRatio = includeImageGeneration ? row.aspectRatio.trim() : '';
  const resolution = includeImageGeneration ? row.resolution.trim() : '';
  const quality = includeImageGeneration ? row.quality.trim() : '';
  return {
    modelId,
    capabilities: row.capabilities,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(quality ? { quality } : {}),
  };
}

function draftRowSignature(row: ModelDraftRow): string {
  return JSON.stringify({
    modelId: row.modelId.trim(),
    capabilities: row.capabilities,
    contextWindow: row.contextWindow.trim(),
    maxTokens: row.maxTokens.trim(),
    timeoutMs: row.timeoutMs.trim(),
    aspectRatio: row.aspectRatio.trim(),
    resolution: row.resolution.trim(),
    quality: row.quality.trim(),
  });
}

function countPendingChanges(rows: readonly ModelDraftRow[], baseline: readonly ModelDraftRow[]): number {
  const baselineById = new Map<string, string>();
  for (const row of baseline) {
    const modelId = row.modelId.trim();
    if (modelId) baselineById.set(modelId, draftRowSignature(row));
  }

  let count = 0;
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const modelId = row.modelId.trim();
    const signature = draftRowSignature(row);
    if (modelId) {
      seen.add(modelId);
      if (baselineById.get(modelId) !== signature) count += 1;
      return;
    }
    if (draftRowSignature(baseline[index] ?? EMPTY_MODEL_DRAFT) !== signature) count += 1;
  });
  for (const modelId of baselineById.keys()) {
    if (!seen.has(modelId)) count += 1;
  }
  return count;
}

export function ProviderCredentialModelsEditor(props: {
  credential: ProviderCredential;
  vendor?: ProviderVendorInfo;
  models: ProviderModel[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  warning: string | null;
  onReplace: (next: Omit<ProviderModel, 'accountId'>[]) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const { credential, vendor, models, ready, loading, saving, error, warning, onReplace } = props;
  const allowedCapabilities = useMemo(() => resolveProviderModelCapabilities(credential, vendor), [credential, vendor]);
  const baseline = useMemo(() => models.map((model) => ({
    ...modelToDraftRow(model),
    capabilities: filterAllowedModelCapabilities(credential, model.capabilities, vendor),
  })).filter((model) => model.capabilities.length > 0), [credential, models, vendor]);
  const baselineKey = JSON.stringify(baseline);
  const [discoveredModels, setDiscoveredModels] = useState<ProviderModelDraft[]>([]);
  const [selectedDiscoveredModelIds, setSelectedDiscoveredModelIds] = useState<string[]>([]);
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryCollapsed, setDiscoveryCollapsed] = useState(false);

  const handleDiscover = async () => {
    if (discovering) return;
    setDiscoveryCollapsed(false);
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const result = await discoverProviderModels(credential.id);
      setDiscoveredModels(result.models);
      setSelectedDiscoveredModelIds(result.models.map((model) => model.modelId));
      setDiscoveryAttempted(true);
    } catch (discoverError) {
      setDiscoveredModels([]);
      setSelectedDiscoveredModelIds([]);
      setDiscoveryError(discoverError instanceof Error ? discoverError.message : String(discoverError));
      setDiscoveryAttempted(true);
    } finally {
      setDiscovering(false);
    }
  };

  const handleToggleDiscoveredModel = (modelId: string, checked: boolean) => {
    setSelectedDiscoveredModelIds((prev) => {
      if (checked) return prev.includes(modelId) ? prev : [...prev, modelId];
      return prev.filter((item) => item !== modelId);
    });
  };

  const handleImportedDiscoveredModels = (modelIds: readonly string[]) => {
    setSelectedDiscoveredModelIds((prev) => prev.filter((modelId) => !modelIds.includes(modelId)));
    if (modelIds.length > 0) setDiscoveryCollapsed(true);
  };

  return (
    <ProviderCredentialModelsEditorInner
      key={baselineKey}
      credential={credential}
      vendor={vendor}
      allowedCapabilities={allowedCapabilities}
      baseline={baseline}
      ready={ready}
      loading={loading}
      saving={saving}
      error={error}
      warning={warning}
      discoveredModels={discoveredModels}
      selectedDiscoveredModelIds={selectedDiscoveredModelIds}
      discoveryAttempted={discoveryAttempted}
      discovering={discovering}
      discoveryError={discoveryError}
      discoveryCollapsed={discoveryCollapsed}
      onDiscoveryCollapsedChange={setDiscoveryCollapsed}
      onDiscover={() => void handleDiscover()}
      onToggleDiscoveredModel={handleToggleDiscoveredModel}
      onImportedDiscoveredModels={handleImportedDiscoveredModels}
      onReplace={onReplace}
      t={t}
    />
  );
}

function ProviderCredentialModelsEditorInner(props: {
  credential: ProviderCredential;
  vendor?: ProviderVendorInfo;
  allowedCapabilities: readonly ModelCapability[];
  baseline: ModelDraftRow[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  warning: string | null;
  discoveredModels: ProviderModelDraft[];
  selectedDiscoveredModelIds: readonly string[];
  discoveryAttempted: boolean;
  discovering: boolean;
  discoveryError: string | null;
  discoveryCollapsed: boolean;
  onDiscoveryCollapsedChange: (collapsed: boolean) => void;
  onDiscover: () => void;
  onToggleDiscoveredModel: (modelId: string, checked: boolean) => void;
  onImportedDiscoveredModels: (modelIds: readonly string[]) => void;
  onReplace: (next: Omit<ProviderModel, 'accountId'>[]) => Promise<void>;
  t: ReturnType<typeof useTranslation>[0];
}) {
  const {
    credential,
    vendor,
    allowedCapabilities,
    baseline,
    ready,
    loading,
    saving,
    error,
    warning,
    discoveredModels,
    selectedDiscoveredModelIds,
    discoveryAttempted,
    discovering,
    discoveryError,
    discoveryCollapsed,
    onDiscoveryCollapsedChange,
    onDiscover,
    onToggleDiscoveredModel,
    onImportedDiscoveredModels,
    onReplace,
    t,
  } = props;
  const [rows, setRows] = useState<ModelDraftRow[]>(baseline);
  const [localError, setLocalError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set());
  const pendingChangeCount = useMemo(() => countPendingChanges(rows, baseline), [baseline, rows]);
  const dirty = pendingChangeCount > 0;
  const currentModelIds = useMemo(() => new Set(rows.map((row) => row.modelId.trim()).filter(Boolean)), [rows]);
  const selectedDiscoveredModelIdSet = useMemo(() => new Set(selectedDiscoveredModelIds), [selectedDiscoveredModelIds]);
  const importableDiscoveredModels = useMemo(() => discoveredModels.filter((model) => (
    selectedDiscoveredModelIdSet.has(model.modelId)
    && !currentModelIds.has(model.modelId)
    && filterAllowedModelCapabilities(credential, model.capabilities, vendor).length > 0
  )), [credential, currentModelIds, discoveredModels, selectedDiscoveredModelIdSet, vendor]);
  const codePlanModelId = vendor?.codePlan?.modelId;
  const codePlanRegistered = Boolean(codePlanModelId && rows.some((row) => row.modelId.trim() === codePlanModelId));

  const handleAdd = () => {
    const defaultCapabilities = allowedCapabilities.includes('chat') ? ['chat' as const] : allowedCapabilities.slice(0, 1);
    setRows((prev) => {
      setExpandedRows((expanded) => new Set([...expanded, prev.length]));
      return [...prev, { ...EMPTY_MODEL_DRAFT, capabilities: [...defaultCapabilities] }];
    });
  };

  const handleAddCodePlanModel = async () => {
    if (!codePlanModelId || codePlanRegistered) return;
    const existing = rows
      .map((row) => draftRowToModel(credential, row))
      .filter((model): model is Omit<ProviderModel, 'accountId'> => model !== null);
    await onReplace([
      ...existing,
      { modelId: codePlanModelId, capabilities: ['chat'] },
    ]);
  };

  const handleImportDiscoveredModels = () => {
    if (importableDiscoveredModels.length === 0) return;
    setLocalError(null);
    setRows((prev) => {
      const existingModelIds = new Set(prev.map((row) => row.modelId.trim()).filter(Boolean));
      const importedRows: ModelDraftRow[] = [];
      for (const model of importableDiscoveredModels) {
        if (existingModelIds.has(model.modelId)) continue;
        existingModelIds.add(model.modelId);
        importedRows.push({
          ...modelToDraftRow(model),
          capabilities: filterAllowedModelCapabilities(credential, model.capabilities, vendor),
        });
      }
      return importedRows.length > 0 ? [...prev, ...importedRows] : prev;
    });
    onImportedDiscoveredModels(importableDiscoveredModels.map((model) => model.modelId));
  };

  const handleReset = () => {
    setLocalError(null);
    setRows(baseline);
    setExpandedRows(new Set());
  };

  const handleToggleAdvanced = (index: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleChange = (index: number, patch: Partial<ModelDraftRow>) => {
    setRows((prev) => prev.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  };

  const handleToggleCapability = (index: number, capability: ModelCapability) => {
    setRows((prev) => prev.map((row, idx) => {
      if (idx !== index) return row;
      const capabilities = row.capabilities.includes(capability)
        ? row.capabilities.filter((item) => item !== capability)
        : [...row.capabilities, capability];
      return { ...row, capabilities };
    }));
  };

  const handleRemove = (index: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== index));
    setExpandedRows((prev) => new Set([...prev]
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx))));
  };

  const handleSave = async () => {
    setLocalError(null);
    const collected: Omit<ProviderModel, 'accountId'>[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.modelId.trim()) continue;
      const model = draftRowToModel(credential, row);
      if (!model) {
        setLocalError(t('providerModels.errors.invalidEntry', { id: row.modelId }));
        return;
      }
      if (seen.has(model.modelId)) {
        setLocalError(t('providerModels.errors.duplicate', { id: model.modelId }));
        return;
      }
      seen.add(model.modelId);
      collected.push(model);
    }
    await onReplace(collected);
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-background">
      <div className={cn('flex flex-wrap items-center justify-between gap-2 bg-muted/25 px-3 py-2.5', open && 'border-b border-border/70')}>
        <button
          type="button"
          className="flex items-center gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          <p className="text-sm font-medium">{t('providerModels.title')}</p>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onDiscover} disabled={saving || discovering} className="h-8">
            {discovering ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
            {t('providerModels.actions.discover')}
          </Button>
          {codePlanModelId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleAddCodePlanModel()}
              disabled={saving || codePlanRegistered}
              className="h-8"
            >
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              {t(codePlanRegistered ? 'providerModels.codePlan.added' : 'providerModels.codePlan.add', { model: codePlanModelId })}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={handleAdd} disabled={saving} className="h-8">
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t('providerModels.actions.add')}
          </Button>
        </div>
      </div>

      {open ? (
        <>
          <ProviderDiscoveredModelsPanel
            credential={credential}
            vendor={vendor}
            models={discoveredModels}
            selectedModelIds={selectedDiscoveredModelIdSet}
            existingModelIds={currentModelIds}
            discoveryAttempted={discoveryAttempted}
            discovering={discovering}
            collapsed={discoveryCollapsed}
            error={discoveryError}
            importableCount={importableDiscoveredModels.length}
            disabled={saving}
            onToggle={onToggleDiscoveredModel}
            onImport={handleImportDiscoveredModels}
            onCollapsedChange={onDiscoveryCollapsedChange}
            t={t}
          />
          {loading && !ready ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">{t('providerModels.group.empty')}</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto">
              {rows.map((row, index) => (
                <ProviderModelDraftRow
                  key={`${credential.id}-${index}`}
                  credential={credential}
                  row={row}
                  allowedCapabilities={allowedCapabilities}
                  disabled={saving}
                  advancedOpen={expandedRows.has(index)}
                  onAdvancedToggle={() => handleToggleAdvanced(index)}
                  onChange={(patch) => handleChange(index, patch)}
                  onToggleCapability={(capability) => handleToggleCapability(index, capability)}
                  onRemove={() => handleRemove(index)}
                  t={t}
                />
              ))}
            </div>
          )}

          {(localError || error) ? (
            <p className="border-t border-border/70 px-3 py-2 text-xs text-destructive">{localError || error}</p>
          ) : warning ? (
            <p className="border-t border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{warning}</p>
          ) : null}
          {dirty ? (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-background/95 px-3 py-2 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur supports-[backdrop-filter]:bg-background/85">
              <span className="text-xs font-medium text-muted-foreground">
                {t('providerModels.pending.summary', { count: pendingChangeCount })}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleReset} disabled={saving} className="h-8">
                  {t('providerModels.actions.reset')}
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving} className="h-8">
                  {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  {t('providerModels.actions.save')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
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
          {t(error === 'Provider model request was rejected' ? 'providerModels.discovery.rejected' : 'providerModels.discovery.error', { error })}
        </p>
      ) : models.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('providerModels.discovery.empty')}</p>
      ) : (
        <div className="max-h-[240px] space-y-1 overflow-y-auto pr-1">
          {models.map((model) => {
            const capabilities = filterAllowedModelCapabilities(credential, model.capabilities, vendor);
            const duplicate = existingModelIds.has(model.modelId);
            const selectable = !duplicate && capabilities.length > 0;
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
        </div>
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
  const hasTuningFields = showTextTuning || showImageGeneration;
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0 xl:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1.1fr)_auto_2.25rem] xl:items-start">
      <div className="min-w-0">
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground xl:hidden">
          {t('providerModels.row.modelIdLabel')}
        </label>
        <Input
          aria-label={t('providerModels.row.modelIdLabel')}
          value={row.modelId}
          onChange={(event) => onChange({ modelId: event.target.value })}
          disabled={disabled}
          spellCheck={false}
          placeholder="gpt-5.5"
          className="h-9 rounded-md bg-background px-3 text-sm"
        />
      </div>
      <div className="min-w-0">
        <label className="mb-1 block text-[11px] font-medium text-muted-foreground xl:hidden">
          {t('providerModels.row.capabilitiesLabel', 'Capabilities')}
        </label>
        <div className="flex flex-wrap gap-1">
          {MODEL_CAPABILITIES.filter((capability) => allowedCapabilities.includes(capability)).map((capability) => (
            <button
              key={capability}
              type="button"
              disabled={disabled}
              onClick={() => onToggleCapability(capability)}
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
      <Button
        variant="ghost"
        size="sm"
        className="h-8 justify-self-start px-2 text-xs text-muted-foreground xl:justify-self-end"
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
        className={cn('h-8 w-8 justify-self-start text-muted-foreground hover:text-destructive xl:justify-self-end')}
        onClick={onRemove}
        disabled={disabled}
        aria-label={t('providerModels.row.remove')}
        title={t('providerModels.row.remove')}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {hasTuningFields && advancedOpen ? (
        <div className="grid grid-cols-1 gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-2 lg:grid-cols-4 xl:col-span-4">
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
          {showImageGeneration ? (
            <>
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
              <LabeledModelField label={t('providerModels.row.aspectRatioLabel')}>
                <Select
                  aria-label={t('providerModels.row.aspectRatioLabel')}
                  value={row.aspectRatio}
                  onChange={(event) => onChange({ aspectRatio: event.target.value })}
                  disabled={disabled}
                  className="h-9 rounded-md bg-background px-2 pr-7 text-sm"
                >
                  <option value="">{t('providerModels.row.defaultOption')}</option>
                  {IMAGE_ASPECT_RATIOS.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
              </LabeledModelField>
              <LabeledModelField label={t('providerModels.row.resolutionLabel')}>
                <Select
                  aria-label={t('providerModels.row.resolutionLabel')}
                  value={row.resolution}
                  onChange={(event) => onChange({ resolution: event.target.value })}
                  disabled={disabled}
                  className="h-9 rounded-md bg-background px-2 pr-7 text-sm"
                >
                  <option value="">{t('providerModels.row.defaultOption')}</option>
                  {IMAGE_RESOLUTIONS.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
              </LabeledModelField>
              <LabeledModelField label={t('providerModels.row.qualityLabel')}>
                <Select
                  aria-label={t('providerModels.row.qualityLabel')}
                  value={row.quality}
                  onChange={(event) => onChange({ quality: event.target.value })}
                  disabled={disabled}
                  className="h-9 rounded-md bg-background px-2 pr-7 text-sm"
                >
                  <option value="">{t('providerModels.row.defaultOption')}</option>
                  {IMAGE_QUALITIES.map((value) => (
                    <option key={value} value={value}>{t(`providerModels.qualities.${value}`, value)}</option>
                  ))}
                </Select>
              </LabeledModelField>
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

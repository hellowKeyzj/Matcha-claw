import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ProviderCredential } from '@/stores/providers';
import type { ProviderVendorInfo } from '@/lib/providers';
import type { ModelCapability, ProviderModel } from '@/lib/provider-model-catalog';
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
const ARK_CODE_PLAN_MODEL_ID = 'ark-code-latest';
const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'] as const;
const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;
const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
const TEXT_TUNING_CAPABILITIES = ['chat', 'imageUnderstand'] as const satisfies readonly ModelCapability[];

function modelToDraftRow(model: ProviderModel): ModelDraftRow {
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

function draftRowToModel(credential: ProviderCredential, row: ModelDraftRow): Omit<ProviderModel, 'credentialId'> | null {
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

export function ProviderCredentialModelsEditor(props: {
  credential: ProviderCredential;
  vendor?: ProviderVendorInfo;
  models: ProviderModel[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onReplace: (next: Omit<ProviderModel, 'credentialId'>[]) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const { credential, vendor, models, ready, loading, saving, error, onReplace } = props;
  const allowedCapabilities = useMemo(() => resolveProviderModelCapabilities(credential, vendor), [credential, vendor]);
  const baseline = useMemo(() => models.map((model) => ({
    ...modelToDraftRow(model),
    capabilities: filterAllowedModelCapabilities(credential, model.capabilities, vendor),
  })).filter((model) => model.capabilities.length > 0), [credential, models, vendor]);
  const baselineKey = JSON.stringify(baseline);
  return (
    <ProviderCredentialModelsEditorInner
      key={baselineKey}
      credential={credential}
      allowedCapabilities={allowedCapabilities}
      baseline={baseline}
      ready={ready}
      loading={loading}
      saving={saving}
      error={error}
      onReplace={onReplace}
      t={t}
    />
  );
}

function ProviderCredentialModelsEditorInner(props: {
  credential: ProviderCredential;
  allowedCapabilities: readonly ModelCapability[];
  baseline: ModelDraftRow[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onReplace: (next: Omit<ProviderModel, 'credentialId'>[]) => Promise<void>;
  t: ReturnType<typeof useTranslation>[0];
}) {
  const { credential, allowedCapabilities, baseline, ready, loading, saving, error, onReplace, t } = props;
  const [rows, setRows] = useState<ModelDraftRow[]>(baseline);
  const [localError, setLocalError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const dirty = JSON.stringify(rows) !== JSON.stringify(baseline);
  const codePlanRegistered = credential.vendorId === 'ark'
    && rows.some((row) => row.modelId.trim() === ARK_CODE_PLAN_MODEL_ID);

  const handleAdd = () => {
    const defaultCapabilities = allowedCapabilities.includes('chat') ? ['chat' as const] : allowedCapabilities.slice(0, 1);
    setRows((prev) => [...prev, { ...EMPTY_MODEL_DRAFT, capabilities: [...defaultCapabilities] }]);
  };

  const handleAddCodePlanModel = async () => {
    if (codePlanRegistered) return;
    const existing = rows
      .map((row) => draftRowToModel(credential, row))
      .filter((model): model is Omit<ProviderModel, 'credentialId'> => model !== null);
    await onReplace([
      ...existing,
      { modelId: ARK_CODE_PLAN_MODEL_ID, capabilities: ['chat'] },
    ]);
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
  };

  const handleSave = async () => {
    setLocalError(null);
    const collected: Omit<ProviderModel, 'credentialId'>[] = [];
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
          {credential.vendorId === 'ark' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleAddCodePlanModel()}
              disabled={saving || codePlanRegistered}
              className="h-8"
            >
              <Sparkles className="mr-2 h-3.5 w-3.5" />
              {t(codePlanRegistered ? 'providerModels.codePlan.added' : 'providerModels.codePlan.add')}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={handleAdd} disabled={saving} className="h-8">
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t('providerModels.actions.add')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty} className="h-8">
            {saving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            {t('providerModels.actions.save')}
          </Button>
        </div>
      </div>

      {open ? (
        <>
          {loading && !ready ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">{t('providerModels.group.empty')}</p>
          ) : (
            <div>
              {rows.map((row, index) => (
                <ProviderModelDraftRow
                  key={`${credential.id}-${index}`}
                  credential={credential}
                  row={row}
                  allowedCapabilities={allowedCapabilities}
                  disabled={saving}
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
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ProviderModelDraftRow(props: {
  credential: ProviderCredential;
  row: ModelDraftRow;
  allowedCapabilities: readonly ModelCapability[];
  disabled: boolean;
  onChange: (patch: Partial<ModelDraftRow>) => void;
  onToggleCapability: (capability: ModelCapability) => void;
  onRemove: () => void;
  t: ReturnType<typeof useTranslation>[0];
}) {
  const { credential, row, allowedCapabilities, disabled, onChange, onToggleCapability, onRemove, t } = props;
  const showTextTuning = hasTextTuningFields(credential, row);
  const showImageGeneration = hasImageGenerationFields(row);
  const hasTuningFields = showTextTuning || showImageGeneration;
  return (
    <div className="grid grid-cols-1 gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0 xl:grid-cols-[minmax(12rem,1fr)_minmax(14rem,1.1fr)_2.25rem] xl:items-start">
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
        size="icon"
        className={cn('h-8 w-8 justify-self-start text-muted-foreground hover:text-destructive xl:justify-self-end')}
        onClick={onRemove}
        disabled={disabled}
        aria-label={t('providerModels.row.remove')}
        title={t('providerModels.row.remove')}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {hasTuningFields ? (
        <div className="grid grid-cols-1 gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-2 lg:grid-cols-4 xl:col-span-3">
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

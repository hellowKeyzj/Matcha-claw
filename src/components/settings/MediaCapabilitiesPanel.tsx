/**
 * MediaCapabilitiesPanel
 *
 * 把 OpenClaw 的 6 项能力路由（chat / imageUnderstand / imageGenerate /
 * videoGenerate / musicGenerate / tts）以 6 行表单的形式呈现，每一行只让
 * 用户设置"用什么 credential/model"，进阶选项（fallbacks / timeoutMs）放在
 * 每行的折叠区。
 *
 * 候选模型来源：模型清单。能力路由只引用已登记的 credential/model，
 * 不直接创建模型，也不写 provider 凭证。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Save, Settings2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  CAPABILITY_KEYS,
  modelRouteRefToString,
  parseModelRouteRefString,
  type CapabilityKey,
  type ModelRoute,
  type ModelRouteRef,
} from '@/lib/capability-routing';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';
import type { ProviderModel } from '@/lib/provider-model-catalog';
import { useProviderStore } from '@/stores/providers';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface CapabilityRowState {
  primary: string;
  fallbacks: string[];
  timeoutMs: string;
}

const EMPTY_ROW: CapabilityRowState = {
  primary: '',
  fallbacks: [],
  timeoutMs: '',
};

interface ModelOption {
  value: string;
  label: string;
}

function buildModelOptions(
  models: readonly ProviderModel[],
  capability: CapabilityKey,
  credentialLabels: ReadonlyMap<string, string>,
): ModelOption[] {
  return models
    .filter((model) => model.capabilities.includes(capability))
    .map((model) => {
      const value = `${model.credentialId}/${model.modelId}`;
      const label = `${credentialLabels.get(model.credentialId) ?? model.credentialId} / ${model.modelId}`;
      return { value, label };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function uniqueRegisteredRefs(refs: readonly string[], available: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!available.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

function routeToRowState(route: ModelRoute | undefined, available: ReadonlySet<string>): CapabilityRowState {
  if (!route) return EMPTY_ROW;
  const primary = modelRouteRefToString(route.primary);
  return {
    primary: available.has(primary) ? primary : '',
    fallbacks: uniqueRegisteredRefs(route.fallbacks.map((ref) => modelRouteRefToString(ref)), available),
    timeoutMs: route.timeoutMs ? String(route.timeoutMs) : '',
  };
}

function rowsEqual(a: CapabilityRowState, b: CapabilityRowState): boolean {
  return a.primary === b.primary
    && a.timeoutMs === b.timeoutMs
    && a.fallbacks.length === b.fallbacks.length
    && a.fallbacks.every((value, index) => value === b.fallbacks[index]);
}

function CapabilityRow(props: {
  capability: CapabilityKey;
  title: string;
  initial: ModelRoute | undefined;
  modelOptions: readonly ModelOption[];
  saving: boolean;
  onSave: (route: ModelRoute | undefined) => Promise<void>;
}): ReactNode {
  const { t } = useTranslation('settings');
  const { capability, title, initial, modelOptions, saving, onSave } = props;
  const availableRefs = useMemo(() => new Set(modelOptions.map((option) => option.value)), [modelOptions]);
  const baseline = useMemo(() => routeToRowState(initial, availableRefs), [initial, availableRefs]);
  const baselineKey = `${baseline.primary}|${baseline.fallbacks.join('\n')}|${baseline.timeoutMs}`;
  return (
    <CapabilityRowEditor
      key={baselineKey}
      capability={capability}
      title={title}
      baseline={baseline}
      hasInitial={Boolean(initial?.fallbacks.length || initial?.timeoutMs)}
      modelOptions={modelOptions}
      saving={saving}
      onSave={onSave}
      t={t}
    />
  );
}

interface CapabilityRowEditorProps {
  capability: CapabilityKey;
  title: string;
  baseline: CapabilityRowState;
  hasInitial: boolean;
  modelOptions: readonly ModelOption[];
  saving: boolean;
  onSave: (route: ModelRoute | undefined) => Promise<void>;
  t: ReturnType<typeof useTranslation>[0];
}

function CapabilityRowEditor(props: CapabilityRowEditorProps): ReactNode {
  const { capability, title, baseline, hasInitial, modelOptions, saving, onSave, t } = props;
  const [row, setRow] = useState<CapabilityRowState>(baseline);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(hasInitial);
  const [fallbackCandidate, setFallbackCandidate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dirty = !rowsEqual(row, baseline);
  const trimmedPrimary = row.primary.trim();
  const availableFallbackOptions = modelOptions.filter((option) => (
    option.value !== row.primary && !row.fallbacks.includes(option.value)
  ));

  const handleAddFallback = () => {
    if (!fallbackCandidate) return;
    setRow((prev) => ({
      ...prev,
      fallbacks: prev.fallbacks.includes(fallbackCandidate)
        ? prev.fallbacks
        : [...prev.fallbacks, fallbackCandidate],
    }));
    setFallbackCandidate('');
  };

  const handleMoveFallback = (index: number, direction: -1 | 1) => {
    setRow((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.fallbacks.length) return prev;
      const next = [...prev.fallbacks];
      const current = next[index];
      if (!current) return prev;
      next[index] = next[target] ?? current;
      next[target] = current;
      return { ...prev, fallbacks: next };
    });
  };

  const handleRemoveFallback = (index: number) => {
    setRow((prev) => ({
      ...prev,
      fallbacks: prev.fallbacks.filter((_, idx) => idx !== index),
    }));
  };

  const handleSave = async () => {
    setError(null);
    if (!trimmedPrimary) {
      await onSave(undefined);
      return;
    }
    const primary = parseModelRouteRefString(trimmedPrimary);
    if (!primary) {
      setError(t('capabilityRouting.errors.invalidPrimary'));
      return;
    }
    const timeoutMs = row.timeoutMs.trim();
    let timeoutValue: number | undefined;
    if (timeoutMs) {
      const parsed = Number.parseInt(timeoutMs, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError(t('capabilityRouting.errors.invalidTimeout'));
        return;
      }
      timeoutValue = parsed;
    }
    const route: ModelRoute = {
      primary,
      fallbacks: row.fallbacks
        .map((value) => parseModelRouteRefString(value))
        .filter((ref): ref is ModelRouteRef => ref !== null),
      ...(timeoutValue !== undefined ? { timeoutMs: timeoutValue } : {}),
    };
    await onSave(route);
  };

  const handleClear = async () => {
    setError(null);
    await onSave(undefined);
  };

  return (
    <div className="border-t border-border/70 first:border-t-0">
      <div className="grid gap-3 px-4 py-3 md:grid-cols-[11rem_minmax(0,1fr)_8.75rem] md:items-center">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm font-medium">{title}</p>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`capability-${capability}-primary`} className="sr-only">
            {t('capabilityRouting.primaryLabel')}
          </Label>
          <Select
            id={`capability-${capability}-primary`}
            value={row.primary}
            onChange={(event) => {
              const primary = event.target.value;
              setRow((prev) => ({
                ...prev,
                primary,
                fallbacks: prev.fallbacks.filter((fallback) => fallback !== primary),
              }));
            }}
            disabled={saving || modelOptions.length === 0}
            className="h-9 rounded-md bg-background text-sm"
          >
            <option value="">{t('capabilityRouting.noModelOption')}</option>
            {modelOptions.map((option) => (
              <option key={`${capability}-${option.value}`} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {modelOptions.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('capabilityRouting.noRegisteredModels')}</p>
          )}
        </div>
        <div className="grid grid-cols-[3.25rem_2rem_2rem] items-center justify-end gap-1.5">
          {baseline.primary ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              disabled={saving}
              className="h-8 px-2.5"
            >
              {t('capabilityRouting.clear')}
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAdvancedOpen((open) => !open)}
            className={cn('h-8 w-8', advancedOpen && 'bg-secondary text-foreground')}
            aria-label={advancedOpen ? t('capabilityRouting.advanced.collapse') : t('capabilityRouting.advanced.expand')}
            title={advancedOpen ? t('capabilityRouting.advanced.collapse') : t('capabilityRouting.advanced.expand')}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="h-8 w-8"
            aria-label={t('capabilityRouting.save')}
            title={t('capabilityRouting.save')}
          >
            <Save className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {advancedOpen ? (
        <div className="space-y-3 border-t border-border/70 bg-muted/25 px-4 py-3">
          <div className="space-y-1.5">
            <Label htmlFor={`capability-${capability}-fallback-add`} className="text-xs">
              {t('capabilityRouting.fallbacksLabel')}
            </Label>
            <div className="flex flex-wrap gap-2">
              <Select
                id={`capability-${capability}-fallback-add`}
                value={fallbackCandidate}
                onChange={(event) => setFallbackCandidate(event.target.value)}
                disabled={saving || availableFallbackOptions.length === 0}
                className="h-9 min-w-64 flex-1 rounded-md bg-background text-sm"
              >
                <option value="">{t('capabilityRouting.fallbackSelectPlaceholder')}</option>
                {availableFallbackOptions.map((option) => (
                  <option key={`${capability}-fallback-${option.value}`} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddFallback}
                disabled={saving || !fallbackCandidate}
                className="h-9"
              >
                <Plus className="mr-2 h-4 w-4" />
                {t('capabilityRouting.addFallback')}
              </Button>
            </div>
            {row.fallbacks.length > 0 && (
              <div className="space-y-2">
                {row.fallbacks.map((fallback, index) => (
                  <div key={`${capability}-${fallback}`} className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm">{fallback}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleMoveFallback(index, -1)}
                      disabled={saving || index === 0}
                      aria-label={t('capabilityRouting.moveFallbackUp')}
                      title={t('capabilityRouting.moveFallbackUp')}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleMoveFallback(index, 1)}
                      disabled={saving || index === row.fallbacks.length - 1}
                      aria-label={t('capabilityRouting.moveFallbackDown')}
                      title={t('capabilityRouting.moveFallbackDown')}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemoveFallback(index)}
                      disabled={saving}
                      aria-label={t('capabilityRouting.removeFallback')}
                      title={t('capabilityRouting.removeFallback')}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`capability-${capability}-timeout`} className="text-xs">
              {t('capabilityRouting.timeoutLabel')}
            </Label>
            <Input
              id={`capability-${capability}-timeout`}
              value={row.timeoutMs}
              onChange={(event) => setRow((prev) => ({ ...prev, timeoutMs: event.target.value }))}
              placeholder="180000"
              spellCheck={false}
              disabled={saving}
              className="h-9 rounded-md bg-background text-sm"
            />
          </div>
        </div>
      ) : null}

      {error ? <p className="px-4 pb-3 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function MediaCapabilitiesPanel() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const routing = useCapabilityRoutingStore((state) => state.routing);
  const ready = useCapabilityRoutingStore((state) => state.ready);
  const loading = useCapabilityRoutingStore((state) => state.loading);
  const saving = useCapabilityRoutingStore((state) => state.saving);
  const error = useCapabilityRoutingStore((state) => state.error);
  const refresh = useCapabilityRoutingStore((state) => state.refresh);
  const setRoute = useCapabilityRoutingStore((state) => state.setRoute);
  const models = useProviderModelCatalogStore((state) => state.models);
  const modelCatalogReady = useProviderModelCatalogStore((state) => state.ready);
  const modelCatalogLoading = useProviderModelCatalogStore((state) => state.loading);
  const refreshModelCatalog = useProviderModelCatalogStore((state) => state.refresh);
  const credentials = useProviderStore((state) => state.providerSnapshot.credentials);
  const credentialLabels = useMemo(() => new Map(
    credentials.map((credential) => [credential.id, credential.label || credential.vendorId]),
  ), [credentials]);

  useEffect(() => {
    void refresh();
    void refreshModelCatalog();
  }, [refresh, refreshModelCatalog]);

  const initialLoading = (loading && !ready) || (modelCatalogLoading && !modelCatalogReady);

  return (
    <Card className="overflow-hidden rounded-lg">
      <CardHeader className={cn('pb-4', open && 'border-b border-border/70')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <CardTitle>{t('capabilityRouting.title')}</CardTitle>
          </button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
              void refreshModelCatalog();
            }}
            disabled={loading || modelCatalogLoading}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', (loading || modelCatalogLoading) && 'animate-spin')} />
            {t('capabilityRouting.refresh')}
          </Button>
        </div>
      </CardHeader>
      {open ? <CardContent className="p-0">
        {initialLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div>
            {error && (
              <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            {CAPABILITY_KEYS.map((capability) => (
              <CapabilityRow
                key={capability}
                capability={capability}
                title={t(`capabilityRouting.capabilities.${capability}.title`)}
                initial={routing[capability]}
                modelOptions={buildModelOptions(models, capability, credentialLabels)}
                saving={saving}
                onSave={(route) => setRoute(capability, route)}
              />
            ))}
            <CapabilityRow
              capability="tts"
              title={t('capabilityRouting.tts.title')}
              initial={routing.tts}
              modelOptions={buildModelOptions(models, 'tts', credentialLabels)}
              saving={saving}
              onSave={(route) => setRoute('tts', route)}
            />
          </div>
        )}
      </CardContent> : null}
    </Card>
  );
}

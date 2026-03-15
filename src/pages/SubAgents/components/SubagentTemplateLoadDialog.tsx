import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { ModelCatalogEntry, SubagentTemplateDetail } from '@/types/subagent';
import { useTranslation } from 'react-i18next';

interface SubagentTemplateLoadDialogProps {
  open: boolean;
  loading: boolean;
  template: SubagentTemplateDetail | null;
  modelOptions: ModelCatalogEntry[];
  modelsLoading: boolean;
  submitting: boolean;
  onSubmit: (modelId: string) => Promise<void>;
  onClose: () => void;
}

export function SubagentTemplateLoadDialog({
  open,
  loading,
  template,
  modelOptions,
  modelsLoading,
  submitting,
  onSubmit,
  onClose,
}: SubagentTemplateLoadDialogProps) {
  const { t } = useTranslation('subagents');
  const { t: tTemplate } = useTranslation('subagentTemplates');
  const [manualModelId, setManualModelId] = useState('');
  const resolvedModelOptions = useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const item of modelOptions) {
      if (!item?.id) {
        continue;
      }
      byId.set(item.id, item);
    }
    return [...byId.values()];
  }, [modelOptions]);

  const modelId = useMemo(() => {
    if (manualModelId && resolvedModelOptions.some((item) => item.id === manualModelId)) {
      return manualModelId;
    }
    return resolvedModelOptions[0]?.id ?? '';
  }, [manualModelId, resolvedModelOptions]);

  if (!open) {
    return null;
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
        <section
          role="dialog"
          aria-label={t('templates.loading')}
          className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-xl"
        >
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('templates.loading')}</h2>
            <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </header>
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-r-transparent" />
            <span>{t('templates.loadingButton')}</span>
          </div>
        </section>
      </div>
    );
  }

  if (!template) {
    return null;
  }

  const localizedTemplateName = tTemplate(`templates.${template.id}.name`, { defaultValue: template.name });
  const localizedTemplateSummary = tTemplate(`templates.${template.id}.summary`, {
    defaultValue: template.summary ?? '',
  });
  const canSubmit = !submitting && !modelsLoading && !!modelId.trim() && resolvedModelOptions.length > 0;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={t('templates.loadDialog.title', { name: localizedTemplateName })}
        className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('templates.loadDialog.title', { name: localizedTemplateName })}</h2>
          <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="mt-4 space-y-4">
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-lg">
                {template.emoji || '\uD83E\uDD16'}
              </div>
              <div>
                <p className="text-sm font-semibold">{localizedTemplateName}</p>
                <p className="text-xs text-muted-foreground">{template.id}</p>
                {localizedTemplateSummary && (
                  <p className="mt-1 text-xs text-muted-foreground">{localizedTemplateSummary}</p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="template-load-model">{t('templates.loadDialog.model')}</Label>
            <Select
              id="template-load-model"
              value={modelId}
              disabled={modelsLoading || resolvedModelOptions.length === 0}
              onChange={(event) => setManualModelId(event.target.value)}
            >
              <option value="">
                {modelsLoading ? t('form.modelsLoading') : t('form.selectModel')}
              </option>
              {resolvedModelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.provider ? `${model.id} (${model.provider})` : model.id}
                </option>
              ))}
            </Select>
            {!modelsLoading && resolvedModelOptions.length === 0 && (
              <p className="text-xs text-destructive">{t('form.modelUnavailable')}</p>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('deleteDialog.cancel')}
          </Button>
          <Button
            onClick={async () => {
              if (!canSubmit) {
                return;
              }
              await onSubmit(modelId.trim());
            }}
            disabled={!canSubmit}
          >
            {submitting ? t('templates.loadDialog.loading') : t('templates.loadDialog.confirm')}
          </Button>
        </div>
      </section>
    </div>
  );
}

export default SubagentTemplateLoadDialog;

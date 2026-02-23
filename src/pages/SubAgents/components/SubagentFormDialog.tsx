import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  buildSubagentWorkspacePath,
  hasSubagentNameConflict,
} from '@/lib/subagent/workspace';
import type { ModelCatalogEntry, SubagentSummary } from '@/types/subagent';
import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type SubagentFormMode = 'create' | 'edit';

interface SubagentFormValues {
  name: string;
  workspace: string;
  model: string;
  emoji: string;
  prompt: string;
}

interface SubagentFormDialogProps {
  open: boolean;
  title: string;
  mode: SubagentFormMode;
  existingAgents: Pick<SubagentSummary, 'id' | 'workspace'>[];
  modelOptions: ModelCatalogEntry[];
  modelsLoading: boolean;
  initialValues?: Partial<SubagentFormValues>;
  onSubmit: (values: SubagentFormValues) => Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: SubagentFormValues = {
  name: '',
  workspace: '',
  model: '',
  emoji: '',
  prompt: '',
};

const EMOJI_OPTIONS = [
  '\u{1F916}', '\u{1F9E0}', '\u{1F4A1}', '\u{1F680}', '\u{1F6E0}', '\u{1F4BB}', '\u{1F527}', '\u{1F4CA}', '\u{1F4C8}', '\u{1F4C4}',
  '\u{1F4DD}', '\u{1F4E6}', '\u{1F3AF}', '\u{1F3C1}', '\u{1F3C6}', '\u{2705}', '\u{26A0}\u{FE0F}', '\u{1F6A7}', '\u{1F9F0}', '\u{1F4E3}',
  '\u{1F4A5}', '\u{1F525}', '\u{1F48E}', '\u{2B50}', '\u{1F31F}', '\u{1F984}', '\u{1F981}', '\u{1F43C}', '\u{1F431}', '\u{1F436}',
  '\u{1F332}', '\u{1F33F}', '\u{1F30A}', '\u{1F308}', '\u{2601}\u{FE0F}', '\u{1F31E}', '\u{1F319}', '\u{1F680}', '\u{1F6F0}\u{FE0F}', '\u{1F30D}',
  '\u{1F3B5}', '\u{1F3A8}', '\u{1F3AD}', '\u{1F3AE}', '\u{1F3C0}', '\u{26BD}', '\u{1F3B2}', '\u{1F3AF}', '\u{1F4AF}', '\u{1F44D}',
];

export function SubagentFormDialog({
  open,
  title,
  mode,
  existingAgents,
  modelOptions,
  modelsLoading,
  initialValues,
  onSubmit,
  onClose,
}: SubagentFormDialogProps) {
  const { t } = useTranslation('subagents');
  const [values, setValues] = useState<SubagentFormValues>(EMPTY_VALUES);
  const [submitting, setSubmitting] = useState(false);
  const [emojiPanelOpen, setEmojiPanelOpen] = useState(false);
  const resolvedModelOptions = useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const model of modelOptions) {
      if (model?.id) {
        byId.set(model.id, model);
      }
    }
    const current = values.model.trim();
    if (current && !byId.has(current)) {
      byId.set(current, { id: current, name: current });
    }
    return Array.from(byId.values());
  }, [modelOptions, values.model]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const initialName = initialValues?.name ?? '';
    const initialWorkspace = mode === 'create'
      ? buildSubagentWorkspacePath({ name: initialName, agents: existingAgents })
      : (initialValues?.workspace ?? '');
    setValues({
      name: initialName,
      workspace: initialWorkspace,
      model: initialValues?.model ?? (mode === 'create' ? (modelOptions[0]?.id ?? '') : ''),
      emoji: initialValues?.emoji ?? '',
      prompt: initialValues?.prompt ?? '',
    });
    setSubmitting(false);
    setEmojiPanelOpen(false);
  }, [existingAgents, initialValues, mode, modelOptions, open]);

  useEffect(() => {
    if (!open || mode !== 'create' || values.model || modelOptions.length === 0) {
      return;
    }
    setValues((prev) => ({ ...prev, model: modelOptions[0].id }));
  }, [mode, modelOptions, open, values.model]);

  if (!open) {
    return null;
  }

  const submitLabel = mode === 'create' ? t('form.create') : t('form.save');
  const duplicateName = mode === 'create'
    ? hasSubagentNameConflict(values.name, existingAgents)
    : false;
  const missingModel = !values.model.trim();
  const hasModelOptions = resolvedModelOptions.length > 0;
  const canSubmit = !submitting
    && !!values.name.trim()
    && !!values.workspace.trim()
    && !duplicateName
    && !missingModel
    && hasModelOptions
    && !modelsLoading;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-background p-4 shadow-lg"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <form
          className="mt-4 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSubmit) {
              return;
            }
            setSubmitting(true);
            try {
              await onSubmit({
                name: values.name.trim(),
                workspace: values.workspace.trim(),
                model: values.model.trim(),
                emoji: values.emoji.trim(),
                prompt: values.prompt.trim(),
              });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="subagent-name">{t('form.name')}</Label>
            <Input
              id="subagent-name"
              value={values.name}
              onChange={(event) => {
                const nextName = event.target.value;
                setValues((prev) => ({
                  ...prev,
                  name: nextName,
                  ...(mode === 'create'
                    ? {
                      workspace: buildSubagentWorkspacePath({
                        name: nextName,
                        agents: existingAgents,
                      }),
                    }
                    : {}),
                }));
              }}
            />
            {duplicateName && (
              <p className="text-xs text-destructive">{t('form.nameDuplicate')}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="subagent-workspace">{t('form.workspace')}</Label>
            <Input
              id="subagent-workspace"
              value={values.workspace}
              readOnly
              className="text-muted-foreground"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="subagent-model">{t('form.model')}</Label>
            <Select
              id="subagent-model"
              value={values.model}
              disabled={modelsLoading || !hasModelOptions}
              onChange={(event) => setValues((prev) => ({ ...prev, model: event.target.value }))}
            >
              <option value="">
                {modelsLoading
                  ? t('form.modelsLoading')
                  : t('form.selectModel')}
              </option>
              {resolvedModelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.provider ? `${model.id} (${model.provider})` : model.id}
                </option>
              ))}
            </Select>
            {!modelsLoading && !hasModelOptions && (
              <p className="text-xs text-destructive">{t('form.modelUnavailable')}</p>
            )}
          </div>
          {mode === 'create' && (
            <div className="space-y-2">
              <Label htmlFor="subagent-emoji">{t('form.emoji')}</Label>
              <Input
                id="subagent-emoji"
                value={values.emoji}
                maxLength={16}
                placeholder={t('form.emojiPlaceholder')}
                onChange={(event) => setValues((prev) => ({ ...prev, emoji: event.target.value }))}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEmojiPanelOpen((prev) => !prev)}
              >
                {emojiPanelOpen ? t('form.emojiPanelHide') : t('form.emojiPanelShow')}
              </Button>
              {emojiPanelOpen && (
                <div className="rounded-md border p-2">
                  <div className="grid max-h-40 grid-cols-10 gap-1 overflow-y-auto pr-1">
                    {EMOJI_OPTIONS.map((emoji) => {
                      const selected = values.emoji === emoji;
                      return (
                        <button
                          key={emoji}
                          type="button"
                          aria-label={`pick-emoji-${emoji}`}
                          onClick={() => setValues((prev) => ({ ...prev, emoji }))}
                          className={cn(
                            'h-8 w-8 rounded border text-lg leading-none transition-colors',
                            selected
                              ? 'border-primary bg-primary/10'
                              : 'border-transparent hover:bg-accent'
                          )}
                        >
                          {emoji}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t('form.emojiHelp')}</p>
              {values.emoji && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setValues((prev) => ({ ...prev, emoji: '' }))}
                >
                  {t('form.emojiNone')}
                </Button>
              )}
            </div>
          )}
          {mode === 'create' && (
            <div className="space-y-1">
              <Label htmlFor="subagent-initial-prompt">{t('form.initialPrompt')}</Label>
              <Textarea
                id="subagent-initial-prompt"
                rows={3}
                value={values.prompt}
                placeholder={t('form.initialPromptPlaceholder')}
                onChange={(event) => setValues((prev) => ({ ...prev, prompt: event.target.value }))}
              />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="submit" disabled={!canSubmit}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default SubagentFormDialog;


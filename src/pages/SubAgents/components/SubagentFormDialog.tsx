import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  AGENT_AVATAR_PICKER_OPTION_COUNT,
  buildAvatarPickerSeeds,
  DEFAULT_AGENT_AVATAR_STYLE,
  type AgentAvatarStyle,
} from '@/lib/agent-avatar';
import { hostOpenClawGetConfigDir, hostOpenClawGetWorkspaceDir } from '@/lib/host-api';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  buildSubagentWorkspacePath,
  buildWorkspaceSubagentsRootFromConfigDir,
  hasSubagentNameConflict,
} from '@/features/subagents/domain/workspace';
import type { ModelCatalogEntry, SubagentSummary } from '@/types/subagent';
import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type SubagentFormMode = 'create' | 'edit';

interface SubagentFormValues {
  name: string;
  workspace: string;
  model: string;
  avatarSeed: string;
  avatarStyle: AgentAvatarStyle;
  prompt: string;
}

interface SubagentFormDialogProps {
  open: boolean;
  title: string;
  mode: SubagentFormMode;
  lockBasicInfo?: boolean;
  existingAgents: Pick<SubagentSummary, 'id' | 'workspace' | 'isDefault'>[];
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
  avatarSeed: '',
  avatarStyle: DEFAULT_AGENT_AVATAR_STYLE,
  prompt: '',
};

export function SubagentFormDialog({
  open,
  title,
  mode,
  lockBasicInfo = false,
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
  const [fallbackWorkspaceRoot, setFallbackWorkspaceRoot] = useState<string | undefined>(undefined);
  const [avatarPickerPage, setAvatarPickerPage] = useState(0);
  const basicInfoLocked = mode === 'edit' && lockBasicInfo;
  const resolvedModelOptions = useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const model of modelOptions) {
      if (model?.id) {
        byId.set(model.id, model);
      }
    }
    return Array.from(byId.values());
  }, [modelOptions]);
  const buildWorkspaceValue = useCallback(
    (name: string) =>
      buildSubagentWorkspacePath({
        name,
        agents: existingAgents,
        fallbackRoot: fallbackWorkspaceRoot,
      }),
    [existingAgents, fallbackWorkspaceRoot],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const initialName = initialValues?.name ?? '';
    const initialWorkspace = mode === 'create'
      ? buildWorkspaceValue(initialName)
      : (initialValues?.workspace ?? '');
    const initialAvatarSeed = mode === 'create'
      ? (initialValues?.avatarSeed ?? buildAvatarPickerSeeds({ agentName: initialName, page: 0, count: 1 })[0] ?? '')
      : (initialValues?.avatarSeed ?? '');
    const initialAvatarStyle = initialValues?.avatarStyle ?? DEFAULT_AGENT_AVATAR_STYLE;
    setValues({
      name: initialName,
      workspace: initialWorkspace,
      model: initialValues?.model ?? (mode === 'create' ? (modelOptions[0]?.id ?? '') : ''),
      avatarSeed: initialAvatarSeed,
      avatarStyle: initialAvatarStyle,
      prompt: initialValues?.prompt ?? '',
    });
    setAvatarPickerPage(0);
    setSubmitting(false);
  }, [
    buildWorkspaceValue,
    initialValues,
    mode,
    modelOptions,
    open,
  ]);

  const avatarPickerSeeds = useMemo(() => (
    buildAvatarPickerSeeds({
      agentName: values.name,
      page: avatarPickerPage,
      count: AGENT_AVATAR_PICKER_OPTION_COUNT,
    })
  ), [avatarPickerPage, values.name]);

  useEffect(() => {
    if (!open || mode !== 'create') {
      return;
    }
    if (avatarPickerSeeds.includes(values.avatarSeed)) {
      return;
    }
    const nextAvatarSeed = avatarPickerSeeds[0] ?? '';
    setValues((prev) => {
      if (prev.avatarSeed === nextAvatarSeed) {
        return prev;
      }
      return {
        ...prev,
        avatarSeed: nextAvatarSeed,
      };
    });
  }, [avatarPickerSeeds, mode, open, values.avatarSeed]);

  useEffect(() => {
    if (!open || mode !== 'create') {
      return;
    }
    let cancelled = false;
    const loadFallbackWorkspaceRoot = async () => {
      try {
        const configDir = (await hostOpenClawGetConfigDir()).trim();
        if (cancelled) {
          return;
        }
        if (!configDir) {
          setFallbackWorkspaceRoot(undefined);
          return;
        }
        setFallbackWorkspaceRoot(buildWorkspaceSubagentsRootFromConfigDir(configDir));
      } catch {
        if (!cancelled) {
          setFallbackWorkspaceRoot(undefined);
        }
      }
    };
    void loadFallbackWorkspaceRoot();
    return () => {
      cancelled = true;
    };
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== 'create') {
      return;
    }
    setValues((prev) => {
      const nextWorkspace = buildWorkspaceValue(prev.name);
      if (nextWorkspace === prev.workspace) {
        return prev;
      }
      return {
        ...prev,
        workspace: nextWorkspace,
      };
    });
  }, [buildWorkspaceValue, mode, open]);

  useEffect(() => {
    if (!open || mode !== 'edit' || !basicInfoLocked) {
      return;
    }
    if (values.workspace.trim()) {
      return;
    }
    let cancelled = false;
    const loadMainWorkspace = async () => {
      try {
        const workspaceDir = (await hostOpenClawGetWorkspaceDir()).trim();
        if (!workspaceDir || cancelled) {
          return;
        }
        setValues((prev) => {
          if (prev.workspace.trim()) {
            return prev;
          }
          return {
            ...prev,
            workspace: workspaceDir,
          };
        });
      } catch {
        // best-effort fallback only
      }
    };
    void loadMainWorkspace();
    return () => {
      cancelled = true;
    };
  }, [basicInfoLocked, mode, open, values.workspace]);

  useEffect(() => {
    if (!open || mode !== 'create' || values.model || modelOptions.length !== 1) {
      return;
    }
    setValues((prev) => ({ ...prev, model: modelOptions[0].id }));
  }, [mode, modelOptions, open, values.model]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const current = values.model.trim();
    if (!current) {
      return;
    }
    const exists = resolvedModelOptions.some((entry) => entry.id === current);
    if (!exists) {
      setValues((prev) => ({ ...prev, model: modelOptions.length === 1 ? modelOptions[0].id : '' }));
    }
  }, [modelOptions, open, resolvedModelOptions, values.model]);

  if (!open) {
    return null;
  }

  const avatarStyleOptions: Array<{ value: AgentAvatarStyle; label: string }> = [
    { value: 'pixelArt', label: t('form.avatarStyles.pixelArt') },
    { value: 'bottts', label: t('form.avatarStyles.bottts') },
    { value: 'botttsNeutral', label: t('form.avatarStyles.botttsNeutral') },
  ];
  const submitLabel = mode === 'create' ? t('form.create') : t('form.save');
  const duplicateName = mode === 'create'
    ? hasSubagentNameConflict(values.name, existingAgents)
    : false;
  const missingModel = mode === 'create' && !values.model.trim();
  const hasModelOptions = resolvedModelOptions.length > 0;
  const canSubmit = !submitting
    && !!values.name.trim()
    && (basicInfoLocked || !!values.workspace.trim())
    && !duplicateName
    && !missingModel
    && (mode === 'edit' || hasModelOptions)
    && !modelsLoading;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={title}
        className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-xl border bg-background p-6 shadow-xl"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <form
          className="mt-5 space-y-6"
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
                avatarSeed: values.avatarSeed.trim(),
                avatarStyle: values.avatarStyle,
                prompt: values.prompt.trim(),
              });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">{t('form.basicInfo')}</h3>
            <div className={cn('grid gap-4 md:grid-cols-1')}>
              {mode === 'create' ? (
                <div className="grid gap-x-4 gap-y-3 xl:grid-cols-[320px,minmax(0,1fr)] xl:grid-rows-[auto,auto,auto,1fr]">
                  <div className="xl:col-start-1 xl:row-start-1">
                    <Label>{t('form.avatar')}</Label>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-2.5 xl:col-start-1 xl:row-start-2 xl:row-end-5 xl:self-stretch">
                    <div className="grid grid-cols-[minmax(0,1fr),auto] items-center gap-2">
                      <div className="grid min-w-0 grid-cols-3 gap-1 rounded-full border border-border/70 bg-background/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
                        {avatarStyleOptions.map((option) => (
                          <Button
                            key={option.value}
                            type="button"
                            variant="ghost"
                            aria-label={`avatar-style-${option.value}`}
                            className={cn(
                              'h-8 min-w-0 rounded-full px-2 text-[10px] leading-none shadow-none',
                              values.avatarStyle === option.value
                                ? 'border border-border bg-card text-foreground shadow-sm hover:bg-card'
                                : 'border border-transparent bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                            )}
                            onClick={() => setValues((prev) => ({ ...prev, avatarStyle: option.value }))}
                          >
                            <span className="whitespace-nowrap">{option.label}</span>
                          </Button>
                        ))}
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        aria-label={t('form.avatarRefresh')}
                        title={t('form.avatarRefresh')}
                        className="h-8 w-8 rounded-full border-border/70 bg-background/70 shadow-none hover:bg-muted/70"
                        onClick={() => setAvatarPickerPage((prev) => prev + 1)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="mt-2.5 grid grid-cols-3 gap-2">
                      {avatarPickerSeeds.map((seed) => {
                        const selected = values.avatarSeed === seed;
                        return (
                          <button
                            key={seed}
                            type="button"
                            aria-label={`pick-avatar-${seed}`}
                            onClick={() => setValues((prev) => ({ ...prev, avatarSeed: seed }))}
                            className={cn(
                              'flex h-14 items-center justify-center rounded-xl border bg-background p-2 transition-colors',
                              selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                            )}
                          >
                            <AgentAvatar
                              avatarSeed={seed}
                              avatarStyle={values.avatarStyle}
                              agentName={values.name || 'Agent'}
                              className="h-10 w-10"
                              alt={`Avatar option ${seed}`}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="xl:col-start-2 xl:row-start-1">
                    <Label htmlFor="subagent-name">{t('form.name')}</Label>
                  </div>
                  <div className="space-y-1 xl:col-start-2 xl:row-start-2">
                    <Input
                      id="subagent-name"
                      value={values.name}
                      readOnly={basicInfoLocked}
                      className={basicInfoLocked ? 'text-muted-foreground' : undefined}
                      onChange={(event) => {
                        if (basicInfoLocked) {
                          return;
                        }
                        const nextName = event.target.value;
                        setValues((prev) => ({
                          ...prev,
                          name: nextName,
                          workspace: buildWorkspaceValue(nextName),
                        }));
                      }}
                    />
                    {duplicateName && (
                      <p className="text-xs text-destructive">{t('form.nameDuplicate')}</p>
                    )}
                  </div>
                  <div className="xl:col-start-2 xl:row-start-3">
                    <Label htmlFor="subagent-initial-prompt">{t('form.initialPrompt')}</Label>
                  </div>
                  <div className="xl:col-start-2 xl:row-start-4">
                    <Textarea
                      id="subagent-initial-prompt"
                      rows={6}
                      className="min-h-[220px] resize-none xl:h-full"
                      value={values.prompt}
                      placeholder={t('form.initialPromptPlaceholder')}
                      onChange={(event) => setValues((prev) => ({ ...prev, prompt: event.target.value }))}
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="subagent-name">{t('form.name')}</Label>
                    <Input
                      id="subagent-name"
                      value={values.name}
                      readOnly={basicInfoLocked}
                      className={basicInfoLocked ? 'text-muted-foreground' : undefined}
                      onChange={(event) => {
                        if (basicInfoLocked) {
                          return;
                        }
                        const nextName = event.target.value;
                        setValues((prev) => ({
                          ...prev,
                          name: nextName,
                        }));
                      }}
                    />
                    {duplicateName && (
                      <p className="text-xs text-destructive">{t('form.nameDuplicate')}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">{t('form.aiConfig')}</h3>
            <div className="grid gap-4 md:grid-cols-2">
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
                  disabled={modelsLoading || (mode === 'create' && !hasModelOptions)}
                  onChange={(event) => setValues((prev) => ({ ...prev, model: event.target.value }))}
                >
                  {mode === 'edit' ? (
                    <option value="">{t('form.useDefaultModel')}</option>
                  ) : (
                    <option value="">
                      {modelsLoading
                        ? t('form.modelsLoading')
                        : t('form.selectModel')}
                    </option>
                  )}
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
            </div>
          </section>

          <div className="flex justify-end gap-2 border-t pt-3">
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

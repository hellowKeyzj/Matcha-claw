import { AgentAvatar } from '@/plugins/agents/presentation/AgentAvatar';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AGENT_AVATAR_PICKER_OPTION_COUNT,
  buildAvatarPickerSeeds,
  DEFAULT_AGENT_AVATAR_STYLE,
} from '@/plugins/agents/presentation/agent-avatar';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { hasSubagentNameConflict } from '@/plugins/agents/domain/workspace';
import type {
  AgentEditorController,
  AgentEditorOwnerProps,
  AgentEditorRuntimeContribution,
  AgentEditorSubmission,
  AgentEditorTab,
  AgentEditorValues,
} from '@/plugins/agents/extensions';
import { RefreshCw, X } from 'lucide-react';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SubagentFilesPreview } from '@/plugins/agents/pages/components/SubagentFilesPreview';
import type { AgentAvatarStyle, SubagentTargetFile } from '@/types/subagent';

interface SubagentFormDialogProps extends Omit<AgentEditorOwnerProps, 'name' | 'activeTab' | 'initialSnapshot' | 'children'> {
  title: string;
  runtime: AgentEditorRuntimeContribution;
  initialTab?: AgentEditorTab;
  persistedContentByFile?: Partial<Record<SubagentTargetFile, string>>;
  onSubmit: (submission: AgentEditorSubmission) => Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: AgentEditorValues = {
  name: '',
  description: '',
  avatarSeed: '',
  avatarStyle: DEFAULT_AGENT_AVATAR_STYLE,
};

const CREATE_AGENT_AVATAR_PICKER_OPTION_COUNT = 15;

export function SubagentFormDialog({
  open,
  title,
  mode,
  agentId,
  runtime,
  scope,
  initialTab = 'basic',
  existingAgents,
  modelOptions,
  modelsLoading,
  initialValues,
  skillConfigView,
  skillConfigLoading = false,
  skillConfigError = null,
  toolConfigView,
  toolConfigLoading = false,
  toolConfigError = null,
  persistedContentByFile = {},
  onSubmit,
  onClose,
}: SubagentFormDialogProps) {
  const { t } = useTranslation('subagents');
  const [values, setValues] = useState<AgentEditorValues>(EMPTY_VALUES);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [initialSnapshot] = useState(() => ({ initialValues, modelOptions, existingAgents }));
  const initialized = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [avatarPickerPage, setAvatarPickerPage] = useState(0);
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('basic');

  useEffect(() => {
    if (!open || initialized.current) {
      return;
    }
    initialized.current = true;
    const initial = initialSnapshot.initialValues;
    const initialName = initial?.name ?? '';
    const initialAvatarSeed = mode === 'create'
      ? (initial?.avatarSeed ?? buildAvatarPickerSeeds({ agentName: initialName, page: 0, count: 1 })[0] ?? '')
      : (initial?.avatarSeed ?? '');
    const initialAvatarStyle = initial?.avatarStyle ?? DEFAULT_AGENT_AVATAR_STYLE;
    setValues({
      name: initialName,
      description: initial?.description ?? '',
      avatarSeed: initialAvatarSeed,
      avatarStyle: initialAvatarStyle,
    });
    setActiveTab(mode === 'edit' ? initialTab : 'basic');
    setAvatarPickerPage(0);
    setSubmitting(false);
  }, [initialSnapshot, initialTab, mode, open]);

  const avatarPickerSeeds = useMemo(() => (
    buildAvatarPickerSeeds({
      agentName: values.name,
      page: avatarPickerPage,
      count: mode === 'create' ? CREATE_AGENT_AVATAR_PICKER_OPTION_COUNT : AGENT_AVATAR_PICKER_OPTION_COUNT,
    })
  ), [avatarPickerPage, mode, values.name]);

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

  const renderBasicInfo = (editor: AgentEditorController) => {
    const basicInfoLocked = mode === 'edit' && editor.basicInfoLocked;
    return (
      <div className="space-y-6 [container-type:inline-size]">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t('form.basicInfo')}</h3>
          <div className="grid items-start gap-4 [@container(min-width:48rem)]:grid-cols-[320px_minmax(0,1fr)]">
            <div className="min-w-0 w-full max-w-[320px]">
              {mode === 'create' ? (
                <div className="space-y-2">
                  <Label>{t('form.avatar')}</Label>
                  <div className="rounded-lg border bg-muted/20 p-2.5">
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
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <Label>{t('form.avatar')}</Label>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={t('form.avatarRefresh')}
                      title={t('form.avatarRefresh')}
                      disabled={basicInfoLocked}
                      className="h-8 w-8 rounded-full border-border/70 bg-background/70 shadow-none hover:bg-muted/70"
                      onClick={() => setAvatarPickerPage((prev) => prev + 1)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex justify-center py-2">
                    <AgentAvatar
                      avatarSeed={values.avatarSeed}
                      avatarStyle={values.avatarStyle}
                      agentId={agentId ?? undefined}
                      agentName={values.name || agentId || 'Agent'}
                      className="h-24 w-24 border border-border/70 bg-background shadow-sm"
                      alt={`${values.name || agentId || 'Agent'} avatar`}
                    />
                  </div>
                  <div className="grid min-w-0 grid-cols-3 gap-1 rounded-full border border-border/70 bg-background/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
                    {avatarStyleOptions.map((option) => (
                      <Button
                        key={option.value}
                        type="button"
                        variant="ghost"
                        aria-label={`avatar-style-${option.value}`}
                        disabled={basicInfoLocked}
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
                  <div className="grid grid-cols-4 gap-2">
                    {avatarPickerSeeds.map((seed) => {
                      const selected = values.avatarSeed === seed;
                      return (
                        <button
                          key={seed}
                          type="button"
                          aria-label={`pick-avatar-${seed}`}
                          disabled={basicInfoLocked}
                          onClick={() => setValues((prev) => ({ ...prev, avatarSeed: seed }))}
                          className={cn(
                            'flex h-14 items-center justify-center rounded-xl border bg-background p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                          )}
                        >
                          <AgentAvatar
                            avatarSeed={seed}
                            avatarStyle={values.avatarStyle}
                            agentName={values.name || agentId || 'Agent'}
                            className="h-10 w-10"
                            alt={`Avatar option ${seed}`}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className={cn('min-w-0', mode === 'create' ? 'space-y-3' : 'space-y-6')}>
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
                    setValues((prev) => ({ ...prev, name: nextName }));
                    editor.reconcileName(nextName);
                  }}
                />
                {duplicateName && (
                  <p className="text-xs text-destructive">{t('form.nameDuplicate')}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="subagent-description">{t('form.description')}</Label>
                <Textarea
                  id="subagent-description"
                  rows={mode === 'create' ? 2 : 3}
                  value={values.description}
                  readOnly={basicInfoLocked}
                  className={cn('resize-none', basicInfoLocked && 'text-muted-foreground')}
                  placeholder={t('form.descriptionPlaceholder')}
                  onChange={(event) => setValues((prev) => ({ ...prev, description: event.target.value }))}
                />
              </div>
              {editor.fields.basic}
            </div>
          </div>
        </section>
      </div>
    );
  };

  const renderPersonaConfig = () => (
    <div className="flex min-h-[420px] flex-col gap-3">
      {!agentId ? (
        <p className="text-sm text-muted-foreground">{t('manage.noAgentSelected')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/15 p-3">
          <SubagentFilesPreview persistedContentByFile={persistedContentByFile} />
        </div>
      )}
    </div>
  );

  const renderDialog = (editor: AgentEditorController) => {
    const canSubmit = !submitting
      && !!values.name.trim()
      && !duplicateName
      && editor.valid;
    const formContent = mode === 'edit' ? (
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as AgentEditorTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-full shrink-0 justify-start">
          <TabsTrigger value="basic" onClick={() => setActiveTab('basic')}>{t('form.tabs.basic')}</TabsTrigger>
          <TabsTrigger value="persona" onClick={() => setActiveTab('persona')}>{t('form.tabs.persona')}</TabsTrigger>
          <TabsTrigger value="skills" onClick={() => setActiveTab('skills')}>{t('form.tabs.skills')}</TabsTrigger>
          <TabsTrigger value="tools" onClick={() => setActiveTab('tools')}>{t('form.tabs.tools')}</TabsTrigger>
        </TabsList>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TabsContent value="basic" className="min-h-0 flex-1 overflow-y-auto pr-1">{renderBasicInfo(editor)}</TabsContent>
          <TabsContent value="persona" className="min-h-0 flex-1 overflow-y-auto pr-1">{renderPersonaConfig()}</TabsContent>
          <TabsContent value="skills" className="min-h-0 flex-1 overflow-y-auto pr-1">{editor.fields.skills}</TabsContent>
          <TabsContent value="tools" className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {editor.fields.tools}
          </TabsContent>
        </div>
      </Tabs>
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {renderBasicInfo(editor)}
      </div>
    );

    const submitForm = async () => {
      if (!canSubmit) {
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const trimmedValues: AgentEditorValues = {
          name: values.name.trim(),
          description: values.description.trim(),
          avatarSeed: values.avatarSeed.trim(),
          avatarStyle: values.avatarStyle,
        };
        if (mode === 'create') {
          await onSubmit({ mode, input: editor.prepareCreate(trimmedValues) });
        } else if (agentId) {
          await onSubmit({ mode, ...editor.prepareUpdate(trimmedValues, agentId) });
        }
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : '保存未完成；已确认的更改会保留，请检查后再试。');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
        <section
          role="dialog"
          aria-label={title}
          className={cn(
            'flex min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-background p-6 shadow-xl',
            mode === 'edit' ? 'h-[94vh]' : 'max-h-[94vh]',
          )}
        >
          <header className="flex shrink-0 items-center justify-between">
            <h2 className="text-lg font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </header>
          <div className="mt-5 flex min-h-0 flex-1 flex-col gap-6">
            {formContent}

            {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
            <div className="flex shrink-0 justify-end gap-2 border-t pt-3">
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('form.cancel')}
              </Button>
              <Button
                type="button"
                disabled={!canSubmit}
                onClick={() => {
                  void submitForm();
                }}
              >
                {submitLabel}
              </Button>
            </div>
          </div>
        </section>
      </div>
    );
  };

  const Owner = runtime.owner;
  return (
    <Suspense fallback={
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
        <section role="dialog" aria-label={title} className="w-full max-w-5xl rounded-xl border bg-background p-6 shadow-xl">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </header>
          <LoadingState label={t('common:status.loading')} />
        </section>
      </div>
    }>
      <Owner
        open={open}
        mode={mode}
        agentId={agentId}
        scope={scope}
        name={values.name}
        activeTab={activeTab}
        initialValues={initialValues}
        initialSnapshot={initialSnapshot}
        existingAgents={existingAgents}
        modelOptions={modelOptions}
        modelsLoading={modelsLoading}
        skillConfigView={skillConfigView}
        skillConfigLoading={skillConfigLoading}
        skillConfigError={skillConfigError}
        toolConfigView={toolConfigView}
        toolConfigLoading={toolConfigLoading}
        toolConfigError={toolConfigError}
      >
        {renderDialog}
      </Owner>
    </Suspense>
  );
}

export default SubagentFormDialog;

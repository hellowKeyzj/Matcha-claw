import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Loader2, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SettingsSectionProps } from '@/app/extensions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { teamPromptsApi } from '@/lib/team-prompts-api';
import type { TeamPromptGroup, TeamPromptPreviewVariant } from '@/types/team-prompts';
import { useTeamPrompts } from './useTeamPrompts';
import './team-prompts.css';

const groups: readonly TeamPromptGroup[] = ['discussion', 'design', 'execution', 'repair', 'introduction'];
const entries: Record<TeamPromptGroup, readonly string[]> = {
  discussion: ['body'],
  design: ['body'],
  execution: ['rules', 'completion', 'work', 'reviewCompleted', 'reviewRework'],
  repair: ['common', 'missing', 'declared', 'unreadable', 'fallback'],
  introduction: ['system', 'input'],
};

type Preview = {
  values: Record<string, string>;
  group: TeamPromptGroup;
  variant: TeamPromptPreviewVariant;
  retry: number;
} & ({ status: 'ready'; prompt: string } | { status: 'error'; error: unknown });

export default function TeamPromptsSettings({ active }: SettingsSectionProps) {
  const { t } = useTranslation('teams');
  const id = useId();
  const { catalog, draft, dirty, invalid, operation, failure, recovery, load, update, discard, save } = useTeamPrompts(active);
  const [group, setGroup] = useState<TeamPromptGroup>('repair');
  const [choices, setChoices] = useState<Record<TeamPromptGroup, string>>({
    discussion: 'body', design: 'body', execution: 'rules', repair: 'declared', introduction: 'system',
  });
  const [variants, setVariants] = useState<Record<TeamPromptGroup, TeamPromptPreviewVariant>>({
    discussion: 'work', design: 'work', execution: 'work', repair: 'declared', introduction: 'work',
  });
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const previousPreviewTarget = useRef('');
  const expandRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const variant = variants[group];
  const loaded = catalog !== null;

  useEffect(() => {
    if (!active || !previewing || !loaded) {
      previousPreviewTarget.current = '';
      return;
    }
    const target = `${group}:${variant}:${previewRetry}`;
    const delay = previousPreviewTarget.current === target ? 300 : 0;
    previousPreviewTarget.current = target;
    const controller = new AbortController();
    const context = { values: draft, group, variant, retry: previewRetry };
    const timer = window.setTimeout(() => {
      void teamPromptsApi.preview(draft, group, variant, controller.signal).then(
        ({ prompt }) => { if (!controller.signal.aborted) setPreview({ ...context, status: 'ready', prompt }); },
        (cause: unknown) => { if (!controller.signal.aborted) setPreview({ ...context, status: 'error', error: cause }); },
      );
    }, delay);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, previewing, loaded, draft, group, variant, previewRetry]);

  if (!active) return null;

  const busy = operation !== null;
  const entry = choices[group];
  const entryId = `${group}.${entry}`;
  const bodyKey = `${entryId}.body`;
  const entryKeys = Object.keys(catalog?.defaults ?? {}).filter((key) => key.startsWith(`${entryId}.`));
  const restored = entryKeys.every((key) => draft[key] === catalog?.defaults[key]);
  const errorMessage = (cause: unknown) => {
    const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : null;
    switch (code) {
      case 'TEAM_PROMPTS_INVALID': return t('prompts.errors.invalid');
      case 'TEAM_PROMPTS_CONFLICT': return t('prompts.conflict');
      case 'TEAM_PROMPTS_OUTCOME_UNKNOWN': return t('prompts.unknown');
      case 'TEAM_PROMPTS_UNAVAILABLE': return t('prompts.errors.unavailable');
      default: return t('prompts.errors.failed');
    }
  };
  const entryLabel = (groupId: string, entryName: string) => t(`prompts.entries.${groupId}.${entryName}`);
  const [invalidGroup, invalidEntry, invalidField] = invalid?.key.split('.') ?? [];
  const validation = invalid ? t(invalid.slots.length ? 'prompts.invalidSlots' : 'prompts.emptyField', {
    entry: entryLabel(invalidGroup, invalidEntry),
    field: t(`prompts.fields.${invalidField}`),
    slots: invalid.slots.join(', '),
  }) : '';
  const currentPreview = preview?.values === draft && preview.group === group && preview.variant === variant && preview.retry === previewRetry ? preview : null;
  const status = operation === 'save' ? 'saving' : operation === 'load' ? 'loading'
    : recovery ? `${recovery}Status` : failure ? 'saveFailed' : dirty ? 'unsaved' : 'saved';
  const editorLabel = t('prompts.editorLabel', { group: t(`prompts.groups.${group}`), entry: entryLabel(group, entry) });

  const selectEntry = (value: string) => {
    setChoices((current) => ({ ...current, [group]: value }));
    if (group === 'repair' && ['missing', 'declared', 'unreadable'].includes(value)) {
      setVariants((current) => ({ ...current, repair: value as TeamPromptPreviewVariant }));
    }
    if (group === 'execution' && ['work', 'reviewCompleted', 'reviewRework'].includes(value)) {
      setVariants((current) => ({ ...current, execution: value === 'work' ? 'work' : 'review' }));
    }
  };

  const saveBar = <footer className="team-prompts-save-bar">
    <div className="team-prompts-save-row">
      <div role="status" aria-live="polite" className="team-prompts-status">
        {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />
          : dirty ? <span aria-hidden="true" className="mx-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-600 dark:bg-amber-400" />
            : failure === null ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
        <span>{t(`prompts.${status}`)}</span>
      </div>
      <div className="team-prompts-save-actions">
        {dirty && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={discard}>{t('prompts.discard')}</Button>}
        <Button type="button" size="sm" disabled={busy || !dirty || !!invalid || recovery !== null} onClick={() => void save()}>{t('prompts.save')}</Button>
      </div>
    </div>
    {failure && <div role="alert" className="team-prompts-error team-prompts-save-error">
      <p>{recovery ? t(`prompts.${recovery}`) : errorMessage(failure.cause)}</p>
      {recovery && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>{t('prompts.reload')}</Button>}
    </div>}
    {dirty && validation && <p id={`${id}-validation`} role="alert" className="team-prompts-error">{validation}</p>}
  </footer>;

  const editor = <div className="team-prompts-editor">
    <div className="team-prompts-toolbar" data-single={entries[group].length === 1}>
      {entries[group].length > 1 && <Select
        className="team-prompts-rule-picker"
        aria-label={t('prompts.selectRule')}
        value={entry}
        onChange={(event) => selectEntry(event.target.value)}
      >
        {entries[group].map((value) => <option key={value} value={value}>{entryLabel(group, value)}</option>)}
      </Select>}
      <div className="team-prompts-modes" role="group" aria-label={t('prompts.editorMode')}>
        <Button type="button" variant="ghost" size="sm" aria-pressed={!previewing} onClick={() => setPreviewing(false)}>{t('prompts.edit')}</Button>
        <Button type="button" variant="ghost" size="sm" aria-pressed={previewing} onClick={() => setPreviewing(true)}>{t('prompts.preview')}</Button>
      </div>
      <div className="team-prompts-editor-actions">
        <Button type="button" variant="ghost" size="sm" disabled={busy || restored} onClick={() => update(Object.fromEntries(entryKeys.map((key) => [key, catalog!.defaults[key]])))}>
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />{t('prompts.restore')}
        </Button>
        <Button
          ref={expanded ? undefined : expandRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t(expanded ? 'prompts.collapse' : 'prompts.expand')}
          title={t(expanded ? 'prompts.collapse' : 'prompts.expand')}
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 aria-hidden="true" className="h-4 w-4" /> : <Maximize2 aria-hidden="true" className="h-4 w-4" />}
        </Button>
      </div>
    </div>
    {previewing && (group === 'execution' || group === 'repair') && <div className="team-prompts-case-bar">
      <Select
        className="team-prompts-case-picker"
        aria-label={t('prompts.previewVariant')}
        value={variant}
        onChange={(event) => setVariants((current) => ({ ...current, [group]: event.target.value as TeamPromptPreviewVariant }))}
      >
        {(group === 'execution' ? ['work', 'review'] : ['missing', 'declared', 'unreadable']).map((value) => <option key={value} value={value}>{t(`prompts.variants.${value}`)}</option>)}
      </Select>
    </div>}
    {previewing ? <div ref={previewRef} role="region" tabIndex={0} className="team-prompts-preview" aria-label={t('prompts.preview')} aria-busy={!currentPreview}>
      {currentPreview?.status === 'ready' ? <pre>{currentPreview.prompt}</pre>
        : currentPreview?.status === 'error' ? <div role="alert" className="team-prompts-preview-error">
          <p>{errorMessage(currentPreview.error)}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setPreviewRetry((value) => value + 1)}>{t('prompts.retry')}</Button>
        </div> : <span role="status">{t('prompts.loadingPreview')}</span>}
    </div> : <>
      <Textarea
        key={bodyKey}
        ref={bodyRef}
        className="team-prompts-body"
        aria-label={editorLabel}
        aria-invalid={invalid?.key === bodyKey}
        aria-describedby={dirty && invalid?.key === bodyKey ? `${id}-validation` : undefined}
        spellCheck={false}
        readOnly={busy}
        value={draft[bodyKey] ?? ''}
        onChange={(event) => update({ [bodyKey]: event.target.value })}
      />
      {entryKeys.length > 1 && <div className="team-prompts-fields">
        {entryKeys.filter((key) => key !== bodyKey).map((key) => <label key={key} className="team-prompts-field">
          <span>{t(`prompts.fields.${key.split('.').at(-1)}`)}</span>
          <Input
            type="text"
            spellCheck={false}
            readOnly={busy}
            value={draft[key] ?? ''}
            aria-invalid={invalid?.key === key}
            aria-describedby={dirty && invalid?.key === key ? `${id}-validation` : undefined}
            onChange={(event) => update({ [key]: event.target.value })}
          />
        </label>)}
      </div>}
    </>}
  </div>;

  return <section className="team-prompts" aria-labelledby={`${id}-title`} aria-busy={busy} onKeyDown={(event) => {
    if (!event.nativeEvent.isComposing && !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  }}>
    <h2 id={`${id}-title`} className="text-2xl font-semibold tracking-[-0.025em]">{t('prompts.title')}</h2>
    {catalog ? <>
      <Tabs value={group} onValueChange={(value) => setGroup(value as TeamPromptGroup)} className="team-prompts-tab-layout">
        <TabsList variant="line" className="team-prompts-tabs" aria-label={t('prompts.title')}>
          {groups.map((value) => <TabsTrigger key={value} value={value}>{t(`prompts.groups.${value}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={group} className="team-prompts-panel">
          <Dialog.Root open={expanded} onOpenChange={setExpanded}>
            {!expanded && editor}
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-[hsl(var(--shell-scrim))] backdrop-blur-[3px]" />
              <Dialog.Content
                className="team-prompts-fullscreen"
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => { event.preventDefault(); (previewing ? previewRef.current : bodyRef.current)?.focus(); }}
                onCloseAutoFocus={(event) => { event.preventDefault(); expandRef.current?.focus(); }}
              >
                <Dialog.Title className="sr-only">{editorLabel}</Dialog.Title>
                {editor}
                {saveBar}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </TabsContent>
      </Tabs>
      {!expanded && saveBar}
    </> : <div className="team-prompts-load-state">
      {busy || !failure ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />{t('prompts.loading')}</p>
        : <><p role="alert" className="team-prompts-error">{errorMessage(failure?.cause)}</p><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('prompts.retry')}</Button></>}
    </div>}
  </section>;
}

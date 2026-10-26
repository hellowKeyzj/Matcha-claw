import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Lock, MoreHorizontal, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AgentPageToolbar, AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon } from '@/components/common/AgentPage';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { sealedSkillErrorMessage } from '@/lib/sealed-skills-error';
import { useContributions } from '@/plugin-host/react';
import { useAccountStore } from '@/plugins/account/stores/account';
import type { SealedSkillMetadata, Skill } from '@/types/skill';
import { skillTransfers, type SkillOwnerProps, type SkillScopeContext, type SkillToolbarProps, type SkillViewProps } from '../extensions';
import { isPackageDigest, PACKAGE_CARD_FOOTER_CLASS_NAME, SKILL_CARD_DESCRIPTION_CLASS_NAME, SKILL_CARD_ICON_CLASS_NAME, SkillFolderButton, SkillRefreshButton } from '../presentation';
import { useSealedSkillsStore } from '../stores/sealed-skills';
import { useSkillsStore } from '../stores/skills';

type SealedSkillDeleteTarget = Pick<SealedSkillMetadata, 'skillKey' | 'name'>;
type SealedSkillRuntimeState = 'enabled' | 'disabled' | 'syncing';

interface SealedSkillCardViewModel {
  skill: SealedSkillMetadata;
  runtimeProjection: {
    runtimeId?: string;
    state: SealedSkillRuntimeState;
    canToggle: boolean;
  };
}

const SealedInstalledIntentContext = createContext<((target: SealedSkillDeleteTarget) => void) | null>(null);

function normalizeRuntimeId(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function buildSealedSkillCardModels(sealedSkills: SealedSkillMetadata[], runtimeSkills: Skill[]): SealedSkillCardViewModel[] {
  const runtimeSkillsByKey = new Map<string, Skill[]>();
  for (const skill of runtimeSkills) {
    const existing = runtimeSkillsByKey.get(skill.id);
    if (existing) existing.push(skill);
    else runtimeSkillsByKey.set(skill.id, [skill]);
  }

  return sealedSkills.map((skill) => {
    const supportedRuntimeIds = new Set((skill.runtimes ?? []).map(normalizeRuntimeId).filter((id): id is string => Boolean(id)));
    const runtimeSkill = (runtimeSkillsByKey.get(skill.skillKey) ?? []).find((candidate) => {
      const runtimeId = normalizeRuntimeId(candidate.runtimeId);
      return supportedRuntimeIds.size === 0 || (runtimeId !== undefined && supportedRuntimeIds.has(runtimeId));
    });
    const runtimeId = normalizeRuntimeId(runtimeSkill?.runtimeId) ?? supportedRuntimeIds.values().next().value;
    return {
      skill,
      runtimeProjection: {
        runtimeId,
        state: runtimeId === 'matcha-agent'
          ? skill.installed === true ? 'enabled' : skill.installed === false ? 'disabled' : 'syncing'
          : runtimeSkill ? (runtimeSkill.enabled ? 'enabled' : 'disabled') : 'syncing',
        canToggle: runtimeId !== 'matcha-agent' && skill.installed !== false,
      },
    };
  });
}

function refreshInstalledPanel(scope: SkillScopeContext['scope']): void {
  if (!scope) return;
  void useSealedSkillsStore.getState().fetchSealedSkills();
  void useSkillsStore.getState().fetchSkills({ force: true, silent: true, fresh: true, scope });
}

interface SealedSkillCardProps extends SkillScopeContext {
  model: SealedSkillCardViewModel;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
  onUninstallSkill: (skillId: string) => void;
}

function SealedSkillCard({ model, onToggleSkill, onUninstallSkill, ...scopeContext }: SealedSkillCardProps) {
  const { t } = useTranslation('skills');
  const transfers = useContributions(skillTransfers);
  const { skill, runtimeProjection } = model;
  const mutationLocked = useSkillsStore((state) => Boolean(state.mutatingBySkillId[skill.skillKey]));
  const uninstalling = useSealedSkillsStore((state) => Boolean(state.uninstallingBySkillKey[skill.skillKey]));
  const cloudUploading = useSealedSkillsStore((state) => Boolean(state.cloudUploadingBySkillKey[skill.skillKey]));
  const enabled = runtimeProjection.state === 'enabled';
  const runtimeStateLabel = runtimeProjection.state === 'syncing'
    ? t('availability.unknown')
    : runtimeProjection.runtimeId === 'matcha-agent'
    ? enabled ? t('sealed.enabledLoadUnconfirmed') : t('sealed.packageAvailable')
    : enabled ? t('detail.enabled') : t('detail.disabled');

  return (
    <AgentResourceCard className="gap-3 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Lock className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{skill.name || skill.skillKey}</h3>
          {skill.skillKey !== skill.name && <p className="mt-1 truncate text-xs text-muted-foreground">{skill.skillKey}</p>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`${t('sealed.packageActions')}: ${skill.name || skill.skillKey}`}>
              {cloudUploading || uninstalling ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <MoreHorizontal className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {transfers.map(({ id, packageMenuItems: MenuItems }) => MenuItems && (
              <MenuItems key={id} {...scopeContext} skill={skill} disabled={cloudUploading || uninstalling} />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" disabled={mutationLocked || uninstalling} onSelect={() => onUninstallSkill(skill.skillKey)}>
              {uninstalling ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="size-4" />}
              {t('actions.uninstall')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{skill.description || t('sealed.noDescription')}</p>
      {skill.version && !isPackageDigest(skill.version) && <p className="text-xs text-muted-foreground">{skill.version}</p>}
      <AgentResourceFooter className={PACKAGE_CARD_FOOTER_CLASS_NAME}>
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
          <span className={runtimeProjection.runtimeId === 'matcha-agent' ? 'whitespace-normal' : 'truncate'}>{runtimeStateLabel}</span>
        </span>
        {runtimeProjection.runtimeId !== 'matcha-agent' && <Switch
          className="shrink-0"
          checked={enabled}
          onCheckedChange={(checked) => onToggleSkill(skill.skillKey, checked)}
          disabled={mutationLocked || uninstalling || !runtimeProjection.canToggle}
          aria-label={`${runtimeStateLabel}: ${skill.name || skill.skillKey}`}
        />}
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

export function SealedInstalledOwner({ scopeKey, selectionCurrent, children }: SkillOwnerProps) {
  const { t } = useTranslation('skills');
  const uninstallSealedSkill = useSealedSkillsStore((state) => state.uninstallSealedSkill);
  const [sealedSkillToDelete, setSealedSkillToDelete] = useState<SealedSkillDeleteTarget | null>(null);
  const [previousScopeKey, setPreviousScopeKey] = useState(scopeKey);

  if (previousScopeKey !== scopeKey) {
    setPreviousScopeKey(scopeKey);
    setSealedSkillToDelete(null);
  }

  const handleConfirmUninstallSealedSkill = useCallback(async () => {
    if (!sealedSkillToDelete) return;
    await uninstallSealedSkill(sealedSkillToDelete.skillKey);
    if (!selectionCurrent()) return;
    setSealedSkillToDelete(null);
    const state = useSealedSkillsStore.getState();
    if (state.error || state.cloudError) toast.warning(t('sealed.uninstalledRefreshFailed'));
    else toast.success(t('toast.uninstalled'));
  }, [sealedSkillToDelete, uninstallSealedSkill, selectionCurrent, t]);

  return (
    <SealedInstalledIntentContext.Provider value={setSealedSkillToDelete}>
      {children}
      <ConfirmDialog
        open={sealedSkillToDelete !== null}
        title={t('sealed.uninstallConfirmTitle')}
        message={t('sealed.uninstallConfirmMessage', { name: sealedSkillToDelete?.name || sealedSkillToDelete?.skillKey || '' })}
        confirmLabel={t('actions.uninstall')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={handleConfirmUninstallSealedSkill}
        onCancel={() => setSealedSkillToDelete(null)}
        onError={(error) => {
          toast.error(sealedSkillErrorMessage(error, t, 'toast.failedUninstall'));
        }}
      />
    </SealedInstalledIntentContext.Provider>
  );
}

export function SealedInstalledView({ active, view, ...scopeContext }: SkillViewProps) {
  const { scope, scopeKey, selectionCurrent } = scopeContext;
  const { t } = useTranslation('skills');
  const [searchParams] = useSearchParams();
  const requestUninstall = useContext(SealedInstalledIntentContext)!;
  const storeScopeKey = useSkillsStore((state) => state.scopeKey);
  const storedSkills = useSkillsStore((state) => state.skills);
  const enableSkill = useSkillsStore((state) => state.enableSkill);
  const disableSkill = useSkillsStore((state) => state.disableSkill);
  const sealedScopeKey = useSealedSkillsStore((state) => state.scopeKey);
  const storedSealedSkills = useSealedSkillsStore((state) => state.skills);
  const issues = useSealedSkillsStore((state) => state.issues);
  const loading = useSealedSkillsStore((state) => state.loading);
  const snapshotReady = useSealedSkillsStore((state) => state.snapshotReady);
  const error = useSealedSkillsStore((state) => state.error);
  const cloudAccountUserId = useAccountStore((state) => state.user?.id);
  const cloudAccountSignedOut = useAccountStore((state) => state.status === 'signedOut' || state.status === 'requires2fa');
  const sealedSkills = useMemo(() => sealedScopeKey === scopeKey ? storedSealedSkills : [], [sealedScopeKey, scopeKey, storedSealedSkills]);
  const runtimeSkills = useMemo(() => storeScopeKey === scopeKey && Array.isArray(storedSkills) ? storedSkills : [], [storeScopeKey, scopeKey, storedSkills]);
  const packageSearch = (searchParams.get('packageSearch') || '').trim().toLowerCase();
  const cardModels = useMemo(() => buildSealedSkillCardModels(sealedSkills, runtimeSkills), [sealedSkills, runtimeSkills]);
  const filteredCardModels = useMemo(
    () => cardModels.filter(({ skill }) => [skill.name, skill.skillKey, skill.description].some((value) => value?.toLowerCase().includes(packageSearch))),
    [cardModels, packageSearch],
  );
  const panelUnknown = Boolean(scope) && (sealedScopeKey !== scopeKey || (!snapshotReady && !error));

  useEffect(() => {
    if (active) refreshInstalledPanel(scope);
  }, [active, scope, cloudAccountUserId, cloudAccountSignedOut]);

  const handleToggle = useCallback(async (skillId: string, enable: boolean) => {
    try {
      if (enable) {
        await enableSkill(skillId);
        if (!selectionCurrent()) return;
        toast.success(t('toast.enabled'));
      } else {
        await disableSkill(skillId);
        if (!selectionCurrent()) return;
        toast.success(t('toast.disabled'));
      }
    } catch (err) {
      if (selectionCurrent()) toast.error(String(err));
    }
  }, [enableSkill, disableSkill, selectionCurrent, t]);

  const handleUninstallSkillQuick = useCallback((skillId: string) => {
    const skill = sealedSkills.find((entry) => entry.skillKey === skillId);
    requestUninstall({ skillKey: skillId, name: skill?.name || skillId });
  }, [sealedSkills, requestUninstall]);

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words text-destructive">{sealedSkillErrorMessage(error, t, 'sealed.errors.listFailed')}</span>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => refreshInstalledPanel(scope)}>{t('sealed.retry')}</Button>
        </div>
      )}
      {sealedScopeKey === scopeKey && issues.length > 0 && (
        <ul className="space-y-2" aria-label={t('sealed.catalogIssues')}>
          {issues.map((issue) => (
            <li key={issue.fileName} className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <p className="break-all font-medium">{issue.fileName}{issue.skillKey && <span className="ml-2 font-normal text-muted-foreground">{issue.skillKey}</span>}</p>
                <p className="break-words text-muted-foreground">{t(`sealed.issues.${issue.reason}`)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {panelUnknown ? (
        <LoadingState label={t('common:status.loading')} />
      ) : filteredCardModels.length === 0 ? (
        !error && <p className="py-8 text-sm text-muted-foreground">{packageSearch ? t('noSkillsSearch') : t('sealed.emptyTitle')}</p>
      ) : (
        <AgentResourceGrid className={view === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
          {filteredCardModels.map((model) => (
            <SealedSkillCard
              key={model.skill.skillKey}
              {...scopeContext}
              model={model}
              onToggleSkill={handleToggle}
              onUninstallSkill={handleUninstallSkillQuick}
            />
          ))}
        </AgentResourceGrid>
      )}
    </div>
  );
}

export function SealedInstalledToolbar({ navigation, entries, viewControls }: SkillToolbarProps) {
  const { t } = useTranslation('skills');
  const [searchParams, setSearchParams] = useSearchParams();
  const packageSearch = searchParams.get('packageSearch') || '';
  const searchLabel = t('sealed.searchInstalled');

  return (
    <AgentPageToolbar className="w-full max-w-full flex-nowrap overflow-x-auto">
      {navigation}
      <div className="relative min-w-40 max-w-72 flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input aria-label={searchLabel} placeholder={searchLabel} value={packageSearch} onChange={(event) => {
          const value = event.target.value;
          setSearchParams((params) => {
            const next = new URLSearchParams(params);
            if (value) next.set('packageSearch', value);
            else next.delete('packageSearch');
            return next;
          }, { replace: true });
        }} className="h-9 pl-9 text-sm" />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {entries}
        {viewControls}
      </div>
    </AgentPageToolbar>
  );
}

export function SealedInstalledHeaderActions(props: SkillViewProps) {
  const loading = useSealedSkillsStore((state) => state.loading);
  const refreshing = useSkillsStore((state) => state.refreshing);
  const mutating = useSkillsStore((state) => state.mutating);
  const manualRefreshBusy = refreshing || mutating;

  return <>
    <SkillRefreshButton refreshing={loading || refreshing} disabled={loading || manualRefreshBusy} onClick={() => refreshInstalledPanel(props.scope)} />
    <SkillFolderButton {...props} />
  </>;
}

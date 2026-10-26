import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Download, Lock, Puzzle, RefreshCw, Search, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon, AgentResourcePill } from '@/components/common/AgentPage';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { AppError } from '@/lib/error-model';
import { sealedSkillErrorMessage } from '@/lib/sealed-skills-error';
import { requireSkillsScope } from '@/lib/skills';
import type { Skill } from '@/types/skill';
import type { SkillOwnerProps, SkillPackageMenuProps } from '../extensions';
import {
  PACKAGE_CARD_FOOTER_CLASS_NAME,
  SKILL_CARD_DESCRIPTION_CLASS_NAME,
  SKILL_CARD_ICON_CLASS_NAME,
  isPackageDigest,
  resolveSkillSourceLabel,
} from '../presentation';
import { useSealedSkillsStore } from '../stores/sealed-skills';
import { useSkillsStore } from '../stores/skills';

const SealedTransferContext = createContext<(() => void) | null>(null);

function LocalSkillPackageInstallDialog({
  open,
  installing,
  onClose,
  onInstall,
}: {
  open: boolean;
  installing: boolean;
  onClose: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation('skills');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card
        className="w-full max-w-[30rem] rounded-[1.5rem] border border-border/80 bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-xl">{t('sealed.installDialog.title')}</CardTitle>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('actions.close')} onClick={onClose} disabled={installing}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-[1.25rem] border border-border/70 bg-muted/15 px-6 py-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Upload className="h-5 w-5" />
            </div>
            <div className="mt-4 space-y-1">
              <p className="text-base font-medium text-foreground">{t('sealed.installDialog.empty')}</p>
              <p className="text-sm text-muted-foreground">{t('sealed.installDialog.hint')}</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={installing}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button onClick={onInstall} disabled={installing} className="gap-2">
              {installing ? <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Download className="h-4 w-4" />}
              {t('sealed.installDialog.confirm')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ExportSkillPackageCard({ skill, exporting, onExportSkillPackage }: {
  skill: Skill;
  exporting: boolean;
  onExportSkillPackage: (skillId: string) => void;
}) {
  const { t } = useTranslation('skills');
  const displayName = skill.name.trim() || skill.slug?.trim() || skill.id;

  return (
    <AgentResourceCard className="gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Puzzle className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{displayName}</h3>
          {skill.id !== displayName && <p className="mt-1 truncate text-xs text-muted-foreground">{skill.id}</p>}
        </div>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{skill.description || t('sealed.noDescription')}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {skill.source !== 'matcha-sealed' && <AgentResourcePill>{resolveSkillSourceLabel(skill, t)}</AgentResourcePill>}
        {skill.version && !isPackageDigest(skill.version) && <span>{skill.version}</span>}
      </div>
      <AgentResourceFooter className={PACKAGE_CARD_FOOTER_CLASS_NAME}>
        <span>{t('sealed.exportTitle')}</span>
        <Button size="sm" variant="outline" className="h-8 shrink-0 gap-2" disabled={exporting} onClick={() => onExportSkillPackage(skill.id)}>
          {exporting ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Lock className="size-3.5" />}
          {t('sealed.export')}
        </Button>
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

export function SealedTransferOwner({ scopeKey, selectionCurrent, children }: SkillOwnerProps) {
  const { t } = useTranslation('skills');
  const storeScopeKey = useSkillsStore((state) => state.scopeKey);
  const skills = useSkillsStore((state) => state.skills);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const localPackageInstalling = useSealedSkillsStore((state) => state.localPackageInstalling);
  const installLocalSkillPackage = useSealedSkillsStore((state) => state.installLocalSkillPackage);
  const exportingBySkillKey = useSealedSkillsStore((state) => state.exportingBySkillKey);
  const exportSkillPackage = useSealedSkillsStore((state) => state.exportSkillPackage);
  const [localSkillPackageInstallDialogOpen, setLocalSkillPackageInstallDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportSearch, setExportSearch] = useState('');
  const exportQuery = exportSearch.trim().toLowerCase();
  const filteredExportableSkills = useMemo(() => (
    storeScopeKey === scopeKey && Array.isArray(skills) ? skills : []
  ).filter((skill) => !skill.isCore && !skill.isBundled
    && [skill.name, skill.id, skill.description].some((value) => value?.toLowerCase().includes(exportQuery))),
  [storeScopeKey, scopeKey, skills, exportQuery]);

  const [dialogScopeKey, setDialogScopeKey] = useState(scopeKey);
  if (dialogScopeKey !== scopeKey) {
    setDialogScopeKey(scopeKey);
    setLocalSkillPackageInstallDialogOpen(false);
    setExportDialogOpen(false);
  }

  const onExportOpenChange = useCallback((open: boolean) => {
    setExportDialogOpen(open);
    if (!open) setExportSearch('');
  }, []);
  const openInstallDialog = useCallback(() => setLocalSkillPackageInstallDialogOpen(true), []);
  const closeInstallDialog = useCallback(() => {
    if (!localPackageInstalling) setLocalSkillPackageInstallDialogOpen(false);
  }, [localPackageInstalling]);

  const handleInstallLocalSkillPackage = useCallback(async () => {
    if (localPackageInstalling) return;
    const operationScope = requireSkillsScope();
    try {
      const installed = await installLocalSkillPackage();
      if (!installed || !selectionCurrent()) return;
      if (useSealedSkillsStore.getState().error) toast.warning(t('sealed.installedRefreshFailed'));
      else toast.success(t('sealed.installedLocal'));
      setLocalSkillPackageInstallDialogOpen(false);
      await fetchSkills({ force: true, fresh: true, scope: operationScope });
    } catch (error) {
      if (selectionCurrent()) toast.error(sealedSkillErrorMessage(error, t, 'sealed.installLocalFailed'));
    }
  }, [fetchSkills, installLocalSkillPackage, localPackageInstalling, selectionCurrent, t]);

  const handleExportSkillPackage = useCallback(async (skillId: string) => {
    try {
      const result = await exportSkillPackage(skillId);
      if (!result || !selectionCurrent()) return;
      if (result.warning) toast.warning(t(result.refreshed ? 'sealed.exportedCleanupFailed' : 'sealed.exportedCleanupRefreshFailed'));
      else if (result.refreshed) toast.success(t('sealed.exported'));
      else toast.warning(t('sealed.exportedRefreshFailed'));
    } catch (error) {
      if (selectionCurrent()) toast.error(sealedSkillErrorMessage(error, t, 'sealed.exportFailed'));
    }
  }, [exportSkillPackage, selectionCurrent, t]);

  return (
    <SealedTransferContext.Provider value={openInstallDialog}>
      <DialogPrimitive.Root open={exportDialogOpen} onOpenChange={onExportOpenChange}>
        {children}
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[1.5rem] border border-border bg-background shadow-elevated focus:outline-none">
            <div className="flex items-start justify-between gap-4 p-5 pb-4">
              <div>
                <DialogPrimitive.Title className="text-lg font-semibold">{t('sealed.exportSkills')}</DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{t('sealed.exportDescription')}</DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t('actions.close')}><X className="size-4" /></Button>
              </DialogPrimitive.Close>
            </div>
            <div className="relative mx-5 mb-4">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input aria-label={t('sealed.exportSearch')} placeholder={t('sealed.exportSearch')} value={exportSearch} onChange={(event) => setExportSearch(event.target.value)} className="h-9 pl-9" />
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-5">
              {filteredExportableSkills.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">{exportQuery ? t('noSkillsSearch') : t('sealed.noExportTargets')}</p>
              ) : (
                <AgentResourceGrid className="xl:grid-cols-2">
                  {filteredExportableSkills.map((skill) => (
                    <ExportSkillPackageCard key={skill.id} skill={skill} exporting={Boolean(exportingBySkillKey[skill.id])} onExportSkillPackage={handleExportSkillPackage} />
                  ))}
                </AgentResourceGrid>
              )}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <LocalSkillPackageInstallDialog
        open={localSkillPackageInstallDialogOpen}
        installing={localPackageInstalling}
        onClose={closeInstallDialog}
        onInstall={() => { void handleInstallLocalSkillPackage(); }}
      />
    </SealedTransferContext.Provider>
  );
}

export function SealedTransferEntries() {
  const { t } = useTranslation('skills');
  const openInstallDialog = useContext(SealedTransferContext)!;
  const localPackageInstalling = useSealedSkillsStore((state) => state.localPackageInstalling);

  return (
    <>
      <DialogPrimitive.Trigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9 gap-2">
          <Upload className="size-4" />
          {t('sealed.exportSkills')}
        </Button>
      </DialogPrimitive.Trigger>
      <Button type="button" size="sm" className="h-9 gap-2" disabled={localPackageInstalling} onClick={openInstallDialog}>
        {localPackageInstalling ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Download className="size-4" />}
        {t('sealed.installLocalPackage')}
      </Button>
    </>
  );
}

export function SealedUploadMenuItem({ skill, disabled, selectionCurrent }: SkillPackageMenuProps) {
  const { t } = useTranslation('skills');
  const [, setSearchParams] = useSearchParams();
  const cloudUploading = useSealedSkillsStore((state) => Boolean(state.cloudUploadingBySkillKey[skill.skillKey]));
  const uploadInstalledSkillPackageToCloud = useSealedSkillsStore((state) => state.uploadInstalledSkillPackageToCloud);

  const handleUpload = useCallback(async () => {
    try {
      const result = await uploadInstalledSkillPackageToCloud(skill.skillKey);
      if (!result || !selectionCurrent()) return;
      const notify = result.warning || !result.refreshed ? toast.warning : toast.success;
      notify(t(result.warning
        ? result.refreshed ? 'sealed.uploadedCleanupFailed' : 'sealed.uploadedCleanupRefreshFailed'
        : result.refreshed ? 'sealed.uploaded' : 'sealed.uploadedRefreshFailed'), {
        action: {
          label: t('sealed.viewCloudPackages'),
          onClick: () => setSearchParams((params) => {
            const next = new URLSearchParams(params);
            next.set('tab', 'sealed');
            next.set('packageTab', 'mine');
            next.delete('packageSearch');
            return next;
          }),
        },
      });
    } catch (error) {
      if (!selectionCurrent()) return;
      toast.error(sealedSkillErrorMessage(error, t, 'sealed.uploadFailed'), {
        ...(error instanceof AppError && error.details?.exportWarning === 'cleanup-failed'
          ? { description: t('sealed.exportedCleanupFailed') } : {}),
      });
    }
  }, [uploadInstalledSkillPackageToCloud, skill.skillKey, selectionCurrent, setSearchParams, t]);

  return (
    <DropdownMenuItem disabled={cloudUploading || disabled} onSelect={() => { void handleUpload(); }}>
      {cloudUploading ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Upload className="size-4" />}
      {t('sealed.uploadToCloud')}
    </DropdownMenuItem>
  );
}

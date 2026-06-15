import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { invokeIpc } from '@/lib/api-client';
import { isGatewayOperational } from '@/lib/gateway-status';
import { pickLocalArchive, pickLocalDirectory, pickLocalSkillSource } from '@/services/local-path-picker';
import {
  planTeamDependencies,
  validateTeamSkillPackage,
  type TeamDependencyPlanItem,
  type TeamDependencyPreparationPlan,
} from '@/services/openclaw/team-runtime-client';
import {
  isClawHubDependencySource,
  isLocalDependencySource,
  isOpenableDependencySource,
  normalizeDependencySource,
  readClawHubSkillSlug,
} from './dependency-source';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useTeamsStore, type TeamSkillCandidate, type TeamSkillCreationPlan } from '@/stores/teams';
import { useTranslation } from 'react-i18next';

type TeamSkillReview = {
  candidate: TeamSkillCandidate;
  creationPlan: TeamSkillCreationPlan;
  dependencyPlan: TeamDependencyPreparationPlan;
};

type CreateDialogPhase =
  | { type: 'editing_source' }
  | { type: 'validating_package' }
  | { type: 'review_ready'; review: TeamSkillReview }
  | { type: 'installing_dependency'; review: TeamSkillReview; dependencyName: string }
  | { type: 'importing_dependency'; review: TeamSkillReview; dependencyName: string }
  | { type: 'creating_run'; review: TeamSkillReview };

function formatDependencyCount(plan: TeamDependencyPreparationPlan): string {
  const blockers = plan.items.filter((item) => item.severity === 'blocker').length;
  const warnings = plan.items.filter((item) => item.severity === 'warning').length;
  return `${blockers} blocker · ${warnings} warning`;
}

export function TeamsPage() {
  const { t } = useTranslation('teams');
  const subtitle = t('subtitle');
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayOperational = isGatewayOperational(gatewayStatus);

  const teams = useTeamsStore((state) => state.teams);
  const rolesByTeamId = useTeamsStore((state) => state.rolesByTeamId);
  const loadingByTeamId = useTeamsStore((state) => state.loadingByTeamId);
  const errorByTeamId = useTeamsStore((state) => state.errorByTeamId);
  const planTeamSkillCreation = useTeamsStore((state) => state.planTeamSkillCreation);
  const createTeam = useTeamsStore((state) => state.createTeam);
  const replaceTeamSkillVersion = useTeamsStore((state) => state.replaceTeamSkillVersion);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const deleteTeam = useTeamsStore((state) => state.deleteTeam);
  const ensureRunCreated = useTeamsStore((state) => state.ensureRunCreated);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const installSkill = useSkillsStore((state) => state.installSkill);
  const importLocalSkill = useSkillsStore((state) => state.importLocalSkill);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [teamSkillPackagePath, setTeamSkillPackagePath] = useState('');
  const [createDialogPhase, setCreateDialogPhase] = useState<CreateDialogPhase>({ type: 'editing_source' });
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const packagePath = teamSkillPackagePath.trim();
  const review = createDialogPhase.type === 'review_ready'
    || createDialogPhase.type === 'installing_dependency'
    || createDialogPhase.type === 'importing_dependency'
    || createDialogPhase.type === 'creating_run'
    ? createDialogPhase.review
    : null;
  const checkingPackage = createDialogPhase.type === 'validating_package';
  const creatingRun = createDialogPhase.type === 'creating_run';
  const installingDependency = createDialogPhase.type === 'installing_dependency' ? createDialogPhase.dependencyName : null;
  const importingDependency = createDialogPhase.type === 'importing_dependency' ? createDialogPhase.dependencyName : null;
  const mutatingDependency = installingDependency || importingDependency;
  const canCheckPackage = gatewayOperational && Boolean(packagePath) && !checkingPackage && !creatingRun && !mutatingDependency;
  const provisionedRoleCount = teams.reduce((count, team) => count + (rolesByTeamId[team.id]?.length ?? 0), 0);

  const resetPackageReview = () => {
    setCreateDialogPhase({ type: 'editing_source' });
    setReplacementConfirmed(false);
  };

  const buildReview = async (): Promise<TeamSkillReview> => {
    const validation = await validateTeamSkillPackage({ packagePath });
    if (!validation.valid || !validation.package) {
      throw new Error(validation.errors.map((issue) => issue.message).join('; ') || t('create.invalidPackage'));
    }
    const candidate: TeamSkillCandidate = {
      displayName: teamName.trim() || validation.package.name,
      packagePath,
      teamSkillPackage: validation.package,
    };
    const dependencyPlan = await planTeamDependencies({ packagePath });
    return {
      candidate,
      creationPlan: planTeamSkillCreation(candidate),
      dependencyPlan,
    };
  };

  const handleCheckPackage = async () => {
    if (!canCheckPackage) {
      return;
    }
    setCreateDialogPhase({ type: 'validating_package' });
    setReplacementConfirmed(false);
    setCreateError(null);
    try {
      setCreateDialogPhase({ type: 'review_ready', review: await buildReview() });
    } catch (error) {
      setCreateDialogPhase({ type: 'editing_source' });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshDependencyPlan = async (currentReview: TeamSkillReview): Promise<TeamSkillReview> => {
    const dependencyPlan = await planTeamDependencies({ packagePath: currentReview.candidate.packagePath });
    return {
      ...currentReview,
      creationPlan: planTeamSkillCreation(currentReview.candidate),
      dependencyPlan,
    };
  };

  const refreshDependencyPlanAfterSkillChange = async (currentReview: TeamSkillReview) => {
    await fetchSkills({ force: true, fresh: true });
    setCreateDialogPhase({ type: 'review_ready', review: await refreshDependencyPlan(currentReview) });
  };

  const handleInstallDependency = async (item: TeamDependencyPlanItem) => {
    if (!review || item.kind !== 'skill' || !item.installable || !isClawHubDependencySource(item.source) || mutatingDependency || creatingRun) {
      return;
    }
    setCreateDialogPhase({ type: 'installing_dependency', review, dependencyName: item.name });
    setCreateError(null);
    try {
      await installSkill(readClawHubSkillSlug(item.name, item.source));
      await refreshDependencyPlanAfterSkillChange(review);
    } catch (error) {
      setCreateDialogPhase({ type: 'review_ready', review });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleImportDependencyFromDeclaredSource = async (item: TeamDependencyPlanItem) => {
    if (!review || item.kind !== 'skill' || !item.installable || !isLocalDependencySource(item.source) || mutatingDependency || creatingRun) {
      return;
    }
    setCreateDialogPhase({ type: 'importing_dependency', review, dependencyName: item.name });
    setCreateError(null);
    try {
      await importLocalSkill(normalizeDependencySource(item.source));
      await refreshDependencyPlanAfterSkillChange(review);
    } catch (error) {
      setCreateDialogPhase({ type: 'review_ready', review });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleImportDependencyFromLocalPicker = async (item: TeamDependencyPlanItem) => {
    if (!review || item.kind !== 'skill' || !item.installable || mutatingDependency || creatingRun) {
      return;
    }
    setCreateDialogPhase({ type: 'importing_dependency', review, dependencyName: item.name });
    setCreateError(null);
    try {
      const selectedPath = await pickLocalSkillSource({
        title: t('create.importLocalSkillButton'),
        buttonLabel: t('create.importLocalSkillButton'),
      });
      if (!selectedPath) {
        setCreateDialogPhase({ type: 'review_ready', review });
        return;
      }
      await importLocalSkill(selectedPath);
      await refreshDependencyPlanAfterSkillChange(review);
    } catch (error) {
      setCreateDialogPhase({ type: 'review_ready', review });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleOpenDependencySource = async (source: string | undefined) => {
    const value = normalizeDependencySource(source);
    if (!isOpenableDependencySource(value)) {
      return;
    }
    await invokeIpc('shell:openExternal', value);
  };

  const openExistingTeam = async (teamId: string) => {
    setActiveTeam(teamId);
    setCreateDialogOpen(false);
    navigate(`/teams/${teamId}`);
    await refreshSnapshot(teamId);
  };

  const handleCreateOrReplace = async () => {
    if (!review || creatingRun || mutatingDependency || !review.dependencyPlan.canProceed) {
      return;
    }
    if (review.creationPlan.action === 'open_existing') {
      await openExistingTeam(review.creationPlan.teamId);
      return;
    }
    if (review.creationPlan.action === 'replace_required' && !replacementConfirmed) {
      return;
    }

    setCreateDialogPhase({ type: 'creating_run', review });
    setCreateError(null);
    if (review.creationPlan.action === 'create') {
      const teamId = createTeam(review.candidate);
      try {
        await ensureRunCreated(teamId);
        setActiveTeam(teamId);
        setCreateDialogOpen(false);
        navigate(`/teams/${teamId}`);
      } catch (error) {
        const provisioningErrorMessage = error instanceof Error ? error.message : String(error);
        try {
          await deleteTeam(teamId);
        } catch {
          // Store-level delete failure keeps the team and records its own per-team error.
        }
        setCreateDialogPhase({ type: 'review_ready', review });
        setCreateError(provisioningErrorMessage);
      }
      return;
    }

    const teamId = replaceTeamSkillVersion({
      teamId: review.creationPlan.teamId,
      expectedCurrentVersion: review.creationPlan.currentVersion,
      candidate: review.candidate,
    });
    try {
      await ensureRunCreated(teamId);
      setActiveTeam(teamId);
      setCreateDialogOpen(false);
      navigate(`/teams/${teamId}`);
    } catch (error) {
      setCreateDialogPhase({ type: 'review_ready', review });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleBrowsePackageDirectory = async () => {
    setCreateError(null);
    const selectedPath = await pickLocalDirectory({
      title: t('create.browsePackageDirectory'),
      buttonLabel: t('create.browsePackageDirectory'),
    });
    if (selectedPath) {
      resetPackageReview();
      setTeamSkillPackagePath(selectedPath);
    }
  };

  const handleBrowsePackageArchive = async () => {
    setCreateError(null);
    const selectedPath = await pickLocalArchive({
      title: t('create.browsePackageArchive'),
      buttonLabel: t('create.browsePackageArchive'),
    });
    if (selectedPath) {
      resetPackageReview();
      setTeamSkillPackagePath(selectedPath);
    }
  };

  const primaryButtonLabel = review?.creationPlan.action === 'open_existing'
    ? t('create.openExistingButton')
    : review?.creationPlan.action === 'replace_required'
      ? creatingRun ? t('create.replacingButton') : t('create.replaceButton')
      : creatingRun ? t('create.creatingButton') : t('create.createButton');
  const primaryDisabled = !review
    || creatingRun
    || Boolean(mutatingDependency)
    || !review.dependencyPlan.canProceed
    || (review.creationPlan.action === 'replace_required' && !replacementConfirmed);

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em]">{t('title')}</h1>
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
        {!createDialogOpen ? (
          <Button onClick={() => setCreateDialogOpen(true)}>
            {t('create.openCreateDialog')}
          </Button>
        ) : null}
      </header>

      <Card className="overflow-hidden border-border/70 bg-[linear-gradient(135deg,hsl(var(--card))_0%,hsl(var(--muted))_100%)]">
        <CardContent className="grid gap-5 p-6 md:grid-cols-[1.2fr_0.8fr] md:items-center">
          <div className="space-y-3">
            <Badge variant="outline" className="w-fit">{t('overview.badge')}</Badge>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold tracking-[-0.02em]">{t('overview.title')}</h2>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t('overview.description')}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-border/70 bg-background/60 p-2 text-center shadow-whisper">
            <div className="rounded-xl bg-card px-3 py-3">
              <div className="text-lg font-semibold">{teams.length}</div>
              <div className="text-[11px] text-muted-foreground">{t('create.metricTeams')}</div>
            </div>
            <div className="rounded-xl bg-card px-3 py-3">
              <div className="text-lg font-semibold">{provisionedRoleCount}</div>
              <div className="text-[11px] text-muted-foreground">{t('create.metricRoles')}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {createDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6" role="presentation">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-create-title"
            className="relative flex h-[min(720px,calc(100dvh-3rem))] w-full max-w-3xl flex-col overflow-hidden rounded-[1.25rem] border border-border bg-card text-card-foreground shadow-elevated"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('create.cancelButton')}
              onClick={() => setCreateDialogOpen(false)}
              className="absolute right-4 top-4 z-10 h-8 w-8 rounded-sm opacity-70 transition-opacity hover:bg-transparent hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">{t('create.cancelButton')}</span>
            </Button>

            <div className="border-b border-border bg-muted/25 p-6 pr-14">
              <h2 id="team-create-title" className="text-xl font-semibold tracking-[-0.02em]">{t('create.modalTitle')}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('create.modalDescription')}</p>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
              <div className="space-y-2">
                <Label htmlFor="team-name" className="text-foreground">{t('create.teamName')}</Label>
                <Input
                  id="team-name"
                  value={teamName}
                  onChange={(event) => {
                    setTeamName(event.target.value);
                    resetPackageReview();
                  }}
                  placeholder={t('create.teamNamePlaceholder')}
                  className="bg-background"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="team-skill-package-path" className="text-foreground">{t('create.packagePath')}</Label>
                <Input
                  id="team-skill-package-path"
                  value={teamSkillPackagePath}
                  onChange={(event) => {
                    setCreateError(null);
                    resetPackageReview();
                    setTeamSkillPackagePath(event.target.value);
                  }}
                  placeholder={t('create.packagePathPlaceholder')}
                  className="bg-background"
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleBrowsePackageDirectory()} className="border-border bg-card text-foreground hover:bg-secondary">
                    {t('create.browsePackageDirectory')}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleBrowsePackageArchive()} className="border-border bg-card text-foreground hover:bg-secondary">
                    {t('create.browsePackageArchive')}
                  </Button>
                  <Button type="button" size="sm" onClick={() => void handleCheckPackage()} disabled={!canCheckPackage}>
                    {checkingPackage ? t('create.checkingButton') : t('create.checkPackageButton')}
                  </Button>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-muted/25 p-4">
                <div className="text-sm font-medium text-foreground">{t('create.teamSkillDefinition')}</div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">{t('create.teamSkillDefinitionDescription')}</div>
              </div>

              {review ? (
                <div className="space-y-4 rounded-2xl border border-border bg-background p-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">{review.candidate.teamSkillPackage.name}@{review.candidate.teamSkillPackage.version}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{review.candidate.teamSkillPackage.description}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{review.dependencyPlan.sourcePath}</div>
                  </div>

                  {review.creationPlan.action === 'open_existing' ? (
                    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                      {t('create.existingTeamDetected')}
                    </div>
                  ) : null}

                  {review.creationPlan.action === 'replace_required' ? (
                    <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                      <div className="font-medium text-amber-800 dark:text-amber-200">{t('create.versionChangeDetected')}</div>
                      <div className="text-muted-foreground">
                        {t('create.versionChangeDescription', {
                          currentVersion: review.creationPlan.currentVersion,
                          incomingVersion: review.creationPlan.incomingVersion,
                        })}
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={replacementConfirmed}
                          onChange={(event) => setReplacementConfirmed(event.target.checked)}
                        />
                        <span>{t('create.confirmReplacement')}</span>
                      </label>
                    </div>
                  ) : null}

                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium">{t('create.dependenciesTitle')}</div>
                      <div className="text-xs text-muted-foreground">{formatDependencyCount(review.dependencyPlan)}</div>
                    </div>
                    {review.dependencyPlan.items.length === 0 ? (
                      <div className="rounded border p-3 text-xs text-muted-foreground">{t('create.noDependencies')}</div>
                    ) : review.dependencyPlan.items.map((item) => {
                      const canInstallFromClawHub = item.kind === 'skill' && item.installable && isClawHubDependencySource(item.source);
                      const canImportFromDeclaredSource = item.kind === 'skill' && item.installable && isLocalDependencySource(item.source);
                      const canImportFromPicker = item.kind === 'skill' && item.installable && !canImportFromDeclaredSource;
                      const canOpenSource = isOpenableDependencySource(item.source);
                      const isMutatingThisDependency = mutatingDependency === item.name;
                      return (
                        <div key={`${item.kind}:${item.name}`} className="flex items-start justify-between gap-3 rounded border p-3 text-sm">
                          <div className="min-w-0">
                            <div className="font-medium">
                              {item.name} · {t(`create.dependencyKind.${item.kind}`)} · {t(`create.dependencySeverity.${item.severity}`)}
                            </div>
                            <div className="mt-1 text-xs leading-5 text-muted-foreground">{item.purpose}</div>
                            {item.source ? <div className="mt-1 truncate text-xs text-muted-foreground">{item.source}</div> : null}
                            {item.kind === 'skill' && item.installable && !canInstallFromClawHub ? (
                              <div className="mt-1 text-xs text-muted-foreground">{t('create.noAutomaticInstallSource')}</div>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap justify-end gap-2">
                            {canOpenSource ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleOpenDependencySource(item.source)}
                                disabled={creatingRun || Boolean(mutatingDependency)}
                              >
                                {t('create.openDependencySourceButton')}
                              </Button>
                            ) : null}
                            {canInstallFromClawHub ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleInstallDependency(item)}
                                disabled={Boolean(mutatingDependency) || creatingRun}
                              >
                                {installingDependency === item.name ? t('create.installingSkillButton') : t('create.installSkillButton')}
                              </Button>
                            ) : null}
                            {canImportFromDeclaredSource ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleImportDependencyFromDeclaredSource(item)}
                                disabled={Boolean(mutatingDependency) || creatingRun}
                              >
                                {isMutatingThisDependency ? t('create.importingLocalSkillButton') : t('create.importLocalSkillButton')}
                              </Button>
                            ) : null}
                            {canImportFromPicker ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void handleImportDependencyFromLocalPicker(item)}
                                disabled={Boolean(mutatingDependency) || creatingRun}
                              >
                                {isMutatingThisDependency ? t('create.importingLocalSkillButton') : t('create.importLocalSkillButton')}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    {!review.dependencyPlan.canProceed ? (
                      <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        {t('create.requiredDependencyBlocker')}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            {createError ? (
              <div className="mx-6 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {createError}
              </div>
            ) : null}

            <div className="mt-6 flex items-center justify-between gap-3 border-t border-border p-6 pt-4">
              <Button type="button" variant="ghost" onClick={() => setCreateDialogOpen(false)} className="text-muted-foreground hover:bg-secondary hover:text-foreground">
                {t('create.cancelButton')}
              </Button>
              <Button type="button" onClick={() => void handleCreateOrReplace()} disabled={primaryDisabled}>
                {primaryButtonLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">{t('list.title')}</h2>
        {teams.length === 0 ? (
          <Card>
            <CardContent className="py-4 text-sm text-muted-foreground">{t('list.empty')}</CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {teams.map((team) => {
              const roleCount = rolesByTeamId[team.id]?.length ?? 0;
              const deletingTeam = loadingByTeamId[team.id] === true;
              const teamError = errorByTeamId[team.id];
              return (
                <Card key={team.id}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{team.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {team.teamSkillName}@{team.teamSkillVersion}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('list.packagePath')}: {team.packagePath}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('list.managedRoles')}: {roleCount}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!gatewayOperational}
                          onClick={async () => {
                            setActiveTeam(team.id);
                            navigate(`/teams/${team.id}`);
                            await refreshSnapshot(team.id);
                          }}
                        >
                          {t('list.open')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!gatewayOperational || deletingTeam}
                          onClick={() => void deleteTeam(team.id).catch(() => undefined)}
                        >
                          {t('list.delete')}
                        </Button>
                      </div>
                    </div>
                    {teamError ? (
                      <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {teamError}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default TeamsPage;

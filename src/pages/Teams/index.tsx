import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Bot, ChevronDown, Crown, FileArchive, Folder, FolderArchive, Loader2, Package, UserRoundPlus, Users, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { invokeIpc } from '@/lib/api-client';
import { RuntimeScopeSelector } from '@/components/common/RuntimeScopeSelector';
import { isRuntimeEndpointReady, selectManagementEndpoint, selectManagementRuntime, supportsRuntimeEndpointCapabilityFamily, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { agentScope, buildCapabilityScopeKey, buildRuntimeEndpointKey, runtimeEndpointsEqual, runtimeInstanceScope } from '@/types/desktop/runtime-address';
import { pickLocalArchive, pickLocalDirectory, pickLocalSkillSource, readLocalSkillImport } from '@/services/local-path-picker';
import {
  planTeamDependencies,
  validateTeamSkillPackage,
  type TeamDependencyPlanItem,
  type TeamDependencyPreparationPlan,
  type TeamRoleBindingRecord,
  type TeamRunListItem,
} from '@/services/openclaw/team-runtime-client';
import {
  isClawHubDependencySource,
  isLocalDependencySource,
  isOpenableDependencySource,
  normalizeDependencySource,
  readClawHubSkillSlug,
} from './dependency-source';
import { useSkillsStore } from '@/stores/skills';
import { getSubagentManagementScope, useSubagentsStore } from '@/stores/subagents';
import { resolveTeamRuntimeScope, useTeamsStore, type ManualTeamCandidate, type ManualTeamMemberProvisionRecord, type TeamMeta, type TeamSkillCandidate, type TeamSkillCreationPlan } from '@/stores/teams';
import type { SubagentSummary } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { ManualTeamCreationProgress } from './ManualTeamCreationProgress';
import { TeamMemberPicker, type ManualMemberDraft } from './TeamMemberPicker';

type TeamSkillReview = {
  revision: number;
  candidate: TeamSkillCandidate;
  creationPlan: TeamSkillCreationPlan;
  dependencyPlan: TeamDependencyPreparationPlan;
};

type CreateSourceType = 'teamskill' | 'manual';

type SealedTeamSkillPackage = TeamSkillCandidate['teamSkillPackage'];

type SealedTeamSkillPackageValidationResult =
  | { status: 'valid'; package: SealedTeamSkillPackage }
  | { status: 'invalid' | 'unavailable' };

function readSealedTeamSkillPackageValidationResult(value: unknown): SealedTeamSkillPackageValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unavailable' };
  }
  const validation = value as { status?: unknown; package?: unknown };
  if (validation.status === 'valid' && validation.package && typeof validation.package === 'object' && !Array.isArray(validation.package)) {
    const teamSkillPackage = validation.package as Record<string, unknown>;
    if (
      typeof teamSkillPackage.selectionId === 'string'
      && typeof teamSkillPackage.name === 'string'
      && typeof teamSkillPackage.version === 'string'
      && teamSkillPackage.kind === 'team-skill'
      && typeof teamSkillPackage.description === 'string'
    ) {
      return {
        status: 'valid',
        package: {
          selectionId: teamSkillPackage.selectionId,
          name: teamSkillPackage.name,
          version: teamSkillPackage.version,
          kind: 'team-skill',
          description: teamSkillPackage.description,
        },
      };
    }
  }
  return validation.status === 'invalid' ? { status: 'invalid' } : { status: 'unavailable' };
}

type CreateDialogPhase =
  | { type: 'editing_source' }
  | { type: 'selecting_package' }
  | { type: 'validating_package' }
  | { type: 'review_ready'; review: TeamSkillReview }
  | { type: 'installing_dependency'; review: TeamSkillReview; dependencyName: string }
  | { type: 'importing_dependency'; review: TeamSkillReview; dependencyName: string }
  | { type: 'creating_run'; review: TeamSkillReview }
  | { type: 'creating_manual' };

function formatDependencyCount(plan: TeamDependencyPreparationPlan): string {
  const blockers = plan.items.filter((item) => item.severity === 'blocker').length;
  const warnings = plan.items.filter((item) => item.severity === 'warning').length;
  return `${blockers} blocker · ${warnings} warning`;
}

function sanitizeManualTeamName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'manual-team';
}

function displayAgentName(agent: SubagentSummary): string {
  return agent.name ?? agent.identity?.name ?? agent.id;
}

function sanitizeManualRoleId(value: string): string {
  return sanitizeManualTeamName(value).toLocaleLowerCase();
}

function buildManualRoleId(agent: SubagentSummary, usedRoleIds: ReadonlySet<string>): string {
  const agentIdRoleId = sanitizeManualRoleId(agent.id);
  const agentNameRoleId = sanitizeManualRoleId(displayAgentName(agent));
  const baseRoleId = agentIdRoleId && agentIdRoleId !== 'leader'
    ? agentIdRoleId
    : agentNameRoleId && agentNameRoleId !== 'leader'
      ? agentNameRoleId
      : 'member';
  let roleId = baseRoleId;
  let suffix = 2;
  while (roleId === 'leader' || usedRoleIds.has(roleId)) {
    roleId = `${baseRoleId}-${suffix}`;
    suffix += 1;
  }
  return roleId;
}

function teamRoleCount(team: TeamMeta, roles: TeamRoleBindingRecord[] | undefined, runs: TeamRunListItem[] | undefined): number | undefined {
  if (roles?.length && (!team.activeRunId || roles.every((role) => role.runId === team.activeRunId))) return roles.length;
  const run = runs?.find((run) => run.runId === team.activeRunId);
  if (run) return run.sessions.length;
  return !team.activeRunId && runs?.length === 0 ? 0 : undefined;
}

export function TeamsPage() {
  const { t } = useTranslation('teams');
  const subtitle = t('subtitle');
  const navigate = useNavigate();
  const selectedRuntime = useRuntimeEndpointsStore(selectManagementRuntime);
  const selectedEndpoint = useRuntimeEndpointsStore(selectManagementEndpoint);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const creationRuntime = selectedRuntime?.runtimeAdapterId === 'openclaw' ? selectedRuntime : null;
  const runtimeReady = Boolean(creationRuntime && isRuntimeEndpointReady(creationRuntime) && supportsRuntimeEndpointCapabilityFamily(creationRuntime, 'team'));
  const requestedManagementScope = getSubagentManagementScope(creationRuntime?.endpointRef ?? null);
  const managementScopeKey = requestedManagementScope ? buildCapabilityScopeKey(requestedManagementScope) : '';
  const manualAgentsReady = Boolean(requestedManagementScope && runtimeReady);

  const teams = useTeamsStore((state) => state.teams);
  const rolesByTeamId = useTeamsStore((state) => state.rolesByTeamId);
  const runListByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const syncRunList = useTeamsStore((state) => state.syncRunList);
  const loadingByTeamId = useTeamsStore((state) => state.loadingByTeamId);
  const errorByTeamId = useTeamsStore((state) => state.errorByTeamId);
  const planTeamSkillCreation = useTeamsStore((state) => state.planTeamSkillCreation);
  const createTeam = useTeamsStore((state) => state.createTeam);
  const manualTeamCreation = useTeamsStore((state) => state.manualTeamCreation);
  const createManualTeamWithProgress = useTeamsStore((state) => state.createManualTeamWithProgress);
  const resetManualTeamCreation = useTeamsStore((state) => state.resetManualTeamCreation);
  const replaceTeamSkillVersion = useTeamsStore((state) => state.replaceTeamSkillVersion);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const deleteTeam = useTeamsStore((state) => state.deleteTeam);
  const provisionTeamAgents = useTeamsStore((state) => state.provisionTeamAgents);
  const createRun = useTeamsStore((state) => state.createRun);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const installSkill = useSkillsStore((state) => state.installSkill);
  const importLocalSkill = useSkillsStore((state) => state.importLocalSkill);
  const finishSkillInstallation = useSkillsStore((state) => state.finishSkillInstallation);
  const agentsResource = useSubagentsStore((state) => state.agentsResource);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const setManagementScope = useSubagentsStore((state) => state.setManagementScope);

  const [roleReads, setRoleReads] = useState<Record<string, { loading: boolean; error?: string }>>({});
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createSourceType, setCreateSourceType] = useState<CreateSourceType>('teamskill');
  const [teamName, setTeamName] = useState('');
  const [teamSkillPackagePath, setTeamSkillPackagePath] = useState('');
  const [createDialogElement, setCreateDialogElement] = useState<HTMLDivElement | null>(null);
  const [manualMembers, setManualMembers] = useState<ManualMemberDraft[]>([]);
  const [createDialogPhase, setCreateDialogPhase] = useState<CreateDialogPhase>({ type: 'editing_source' });
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createTitleRef = useRef<HTMLHeadingElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const packageReviewRevisionRef = useRef(0);
  const createOperationRef = useRef(0);

  useEffect(() => {
    const directory = useRuntimeEndpointsStore.getState();
    directory.init();
    if (directory.status === 'idle') void directory.refresh();
    return () => {
      packageReviewRevisionRef.current += 1;
      createOperationRef.current += 1;
    };
  }, []);

  const packagePath = teamSkillPackagePath.trim();
  const managementScope = useSubagentsStore((state) => state.managementScope);
  const managementMatches = Boolean(managementScopeKey && managementScope && buildCapabilityScopeKey(managementScope) === managementScopeKey);
  const agentsLoading = manualAgentsReady && (!managementMatches || agentsResource.status === 'idle' || agentsResource.status === 'loading');
  const agents = creationRuntime && managementMatches && Array.isArray(agentsResource.data) ? agentsResource.data : [];
  const refreshManualAgents = useCallback(async () => {
    if (!requestedManagementScope || !manualAgentsReady) return;
    setManagementScope(requestedManagementScope);
    const scope = useSubagentsStore.getState().managementScope;
    if (scope && buildCapabilityScopeKey(scope) === managementScopeKey) await loadAgents({ silent: true, scope });
  }, [requestedManagementScope, manualAgentsReady, managementScopeKey, setManagementScope, loadAgents]);
  const teamAssignableAgents = agents.filter((agent) => agent.kind !== 'system');
  const creationScope = useMemo(() => creationRuntime ? runtimeInstanceScope(creationRuntime.endpointRef) : null, [creationRuntime]);
  const selectedManualMembers = manualMembers.map((member) => ({
    member,
    agent: agents.find((agent) => agent.id === member.agentId) ?? null,
  }));
  const manualLeaderCount = manualMembers.filter((member) => member.isLeader).length;
  const showingManualCreation = manualTeamCreation !== null;
  const creatingManual = manualTeamCreation?.status === 'running' || manualTeamCreation?.status === 'cleaning_up';
  const canCreateManualTeam = manualAgentsReady
    && !showingManualCreation
    && manualMembers.length > 0
    && manualLeaderCount === 1
    && selectedManualMembers.every(({ agent }) => agent && agent.kind !== 'system');
  const phaseReview = createDialogPhase.type === 'review_ready'
    || createDialogPhase.type === 'installing_dependency'
    || createDialogPhase.type === 'importing_dependency'
    || createDialogPhase.type === 'creating_run'
    ? createDialogPhase.review
    : null;
  const review = phaseReview?.revision === packageReviewRevisionRef.current ? phaseReview : null;
  const selectingPackage = createDialogPhase.type === 'selecting_package';
  const checkingPackage = createDialogPhase.type === 'validating_package';
  const creatingRun = createDialogPhase.type === 'creating_run';
  const installingDependency = createDialogPhase.type === 'installing_dependency' ? createDialogPhase.dependencyName : null;
  const importingDependency = createDialogPhase.type === 'importing_dependency' ? createDialogPhase.dependencyName : null;
  const mutatingDependency = installingDependency || importingDependency;
  const packageBusy = selectingPackage || checkingPackage || creatingRun || Boolean(mutatingDependency);
  const canSelectPackage = runtimeReady && Boolean(creationScope) && !packageBusy;
  const roleCounts = teams.map((team) => teamRoleCount(team, rolesByTeamId[team.id], runListByTeamId[team.id]));
  const provisionedRoleCount = roleCounts.every((count) => count !== undefined)
    ? roleCounts.reduce((total, count) => total + count, 0)
    : undefined;
  const rolesLoading = teams.some((team, index) => roleCounts[index] === undefined && roleReads[team.id]?.loading);
  useEffect(() => {
    for (const team of teams) {
      const teamId = team.id;
      const state = useTeamsStore.getState();
      if (teamRoleCount(team, state.rolesByTeamId[teamId], state.runListByTeamId[teamId]) !== undefined) continue;
      const scope = resolveTeamRuntimeScope(teamId);
      if (!endpoints.some((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint)
        && isRuntimeEndpointReady(entry) && supportsRuntimeEndpointCapabilityFamily(entry, 'team'))) continue;
      const read = { loading: true };
      setRoleReads((current) => ({ ...current, [teamId]: read }));
      void syncRunList(teamId).then(() => {
        setRoleReads((current) => current[teamId] === read ? { ...current, [teamId]: { loading: false } } : current);
      }, (error: unknown) => {
        setRoleReads((current) => current[teamId] === read ? {
          ...current, [teamId]: { loading: false, error: error instanceof Error ? error.message : String(error) },
        } : current);
      });
    }
  }, [teams, endpoints, syncRunList]);

  const resetPackageReview = () => {
    packageReviewRevisionRef.current += 1;
    setCreateDialogPhase({ type: 'editing_source' });
    setReplacementConfirmed(false);
  };

  const closeCreateDialog = () => {
    createOperationRef.current += 1;
    resetPackageReview();
    setCreateDialogOpen(false);
  };

  const restorePackageReview = (currentReview: TeamSkillReview, error: string | null = null) => {
    if (currentReview.revision !== packageReviewRevisionRef.current) return;
    setCreateDialogPhase({ type: 'review_ready', review: currentReview });
    setCreateError(error);
  };

  useEffect(() => useRuntimeEndpointsStore.subscribe((state, previous) => {
    const endpoint = selectManagementEndpoint(state);
    const previousEndpoint = selectManagementEndpoint(previous);
    if ((endpoint ? buildRuntimeEndpointKey(endpoint) : '') === (previousEndpoint ? buildRuntimeEndpointKey(previousEndpoint) : '')) return;
    packageReviewRevisionRef.current += 1;
    createOperationRef.current += 1;
    setCreateDialogPhase({ type: 'editing_source' });
    setReplacementConfirmed(false);
    setCreateError(null);
    setTeamName('');
    setTeamSkillPackagePath('');
    setManualMembers([]);
  }), []);

  useEffect(() => {
    if (!createDialogOpen || createSourceType !== 'manual' || !manualAgentsReady
      || (managementMatches && (agentsResource.hasLoadedOnce || agentsResource.status !== 'idle'))) {
      return;
    }
    void refreshManualAgents();
  }, [agentsResource.hasLoadedOnce, agentsResource.status, createDialogOpen, createSourceType, manualAgentsReady, managementMatches, refreshManualAgents]);

  useEffect(() => {
    if (createDialogOpen && showingManualCreation) {
      createTitleRef.current?.focus({ preventScroll: true });
    }
  }, [createDialogOpen, showingManualCreation]);

  const handleCreateSourceTypeChange = (value: string) => {
    const nextSourceType = value === 'manual' ? 'manual' : 'teamskill';
    setCreateSourceType(nextSourceType);
    setCreateError(null);
  };

  const buildManualCandidate = (): ManualTeamCandidate => {
    const displayName = teamName.trim() || t('create.manualDefaultTeamName');
    const usedRoleIds = new Set<string>();
    const members = manualMembers.map((member): ManualTeamMemberProvisionRecord => {
      const agent = agents.find((candidate) => candidate.id === member.agentId);
      if (!agent) {
        throw new Error(t('create.manualAgentMissing', { agentId: member.agentId }));
      }
      const workspace = agent.workspace?.trim();
      if (!workspace) {
        throw new Error(t('create.manualAgentWorkspaceRequired', { agentName: displayAgentName(agent) }));
      }
      const roleId = member.isLeader ? 'leader' : buildManualRoleId(agent, usedRoleIds);
      if (usedRoleIds.has(roleId)) {
        throw new Error(t('create.manualRoleDuplicate', { roleId }));
      }
      usedRoleIds.add(roleId);
      return {
        agentId: agent.id,
        agentName: displayAgentName(agent),
        workspace,
        roleId,
        skills: agent.skills ?? [],
        tools: [],
        ...(agent.model ? { model: agent.model } : {}),
        isLeader: member.isLeader,
      };
    });
    const leader = members.find((member) => member.isLeader);
    if (!leader || members.filter((member) => member.isLeader).length !== 1) {
      throw new Error(t('create.manualLeaderRequired'));
    }
    if (!selectedEndpoint) throw new Error('Select a runtime for this team.');
    return {
      displayName,
      runtimeScope: agentScope(selectedEndpoint, leader.agentId),
      manualTeam: {
        name: displayName,
        description: t('create.manualDescription', { teamName: displayName }),
        version: 'manual',
        members,
      },
    };
  };

  const buildReview = async (revision: number, selectedPath: string): Promise<TeamSkillReview | null> => {
    if (!creationScope) throw new Error('Select a runtime for this team.');
    const scope = creationScope;
    const validation = readSealedTeamSkillPackageValidationResult(await validateTeamSkillPackage({ packagePath: selectedPath, scope }));
    if (revision !== packageReviewRevisionRef.current) return null;
    if (validation.status !== 'valid') {
      throw new Error(t('create.invalidPackage'));
    }
    const candidate: TeamSkillCandidate = {
      displayName: teamName.trim() || validation.package.name,
      packagePath: selectedPath,
      teamSkillPackage: validation.package,
      runtimeScope: scope,
    };
    const dependencyResult = await planTeamDependencies({ packagePath: selectedPath, scope });
    if (revision !== packageReviewRevisionRef.current) return null;
    if (dependencyResult.status !== 'available') {
      throw new Error(t(dependencyResult.status === 'invalid' ? 'create.invalidPackage' : 'create.dependencyPlanUnavailable'));
    }
    return {
      revision,
      candidate,
      creationPlan: planTeamSkillCreation(candidate),
      dependencyPlan: dependencyResult.plan,
    };
  };

  const handleCheckPackage = async (selectedPath: string) => {
    if (!canSelectPackage || !selectedPath) {
      return;
    }
    const revision = ++packageReviewRevisionRef.current;
    setCreateDialogPhase({ type: 'validating_package' });
    setReplacementConfirmed(false);
    setCreateError(null);
    try {
      const nextReview = await buildReview(revision, selectedPath);
      if (nextReview) restorePackageReview(nextReview);
    } catch (error) {
      if (revision !== packageReviewRevisionRef.current) return;
      setCreateDialogPhase({ type: 'editing_source' });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshDependencyPlan = async (currentReview: TeamSkillReview): Promise<TeamSkillReview> => {
    const scope = currentReview.candidate.runtimeScope;
    const dependencyResult = await planTeamDependencies({ packagePath: currentReview.candidate.packagePath, scope });
    if (dependencyResult.status !== 'available') {
      throw new Error(t(dependencyResult.status === 'invalid' ? 'create.invalidPackage' : 'create.dependencyPlanUnavailable'));
    }
    return {
      ...currentReview,
      creationPlan: planTeamSkillCreation(currentReview.candidate),
      dependencyPlan: dependencyResult.plan,
    };
  };

  const refreshDependencyPlanAfterSkillChange = async (currentReview: TeamSkillReview) => {
    if (currentReview.revision !== packageReviewRevisionRef.current) return;
    restorePackageReview(await refreshDependencyPlan(currentReview));
  };

  const handleInstallDependency = async (item: TeamDependencyPlanItem) => {
    if (!runtimeReady || !review || review.revision !== packageReviewRevisionRef.current || item.kind !== 'skill' || !item.installable || !isClawHubDependencySource(item.source) || mutatingDependency || creatingRun) {
      return;
    }
    setCreateDialogPhase({ type: 'installing_dependency', review, dependencyName: item.name });
    setCreateError(null);
    try {
      await installSkill(readClawHubSkillSlug(item.name, item.source), undefined, review.candidate.runtimeScope);
      await refreshDependencyPlanAfterSkillChange(review);
    } catch (error) {
      restorePackageReview(review, error instanceof Error ? error.message : String(error));
    }
  };

  const handleImportDependencyFromDeclaredSource = async (item: TeamDependencyPlanItem) => {
    if (!runtimeReady || !review || review.revision !== packageReviewRevisionRef.current || item.kind !== 'skill' || !item.installable || !isLocalDependencySource(item.source) || mutatingDependency || creatingRun) {
      return;
    }
    setCreateDialogPhase({ type: 'importing_dependency', review, dependencyName: item.name });
    setCreateError(null);
    try {
      const importedSkill = await readLocalSkillImport(normalizeDependencySource(item.source));
      if (review.revision !== packageReviewRevisionRef.current) return;
      if (!importedSkill) {
        throw new Error('Local skill import was canceled');
      }
      await importLocalSkill(importedSkill, review.candidate.runtimeScope);
      await finishSkillInstallation(importedSkill.skillKey, review.candidate.runtimeScope,
        () => review.revision === packageReviewRevisionRef.current);
      await refreshDependencyPlanAfterSkillChange(review);
    } catch (error) {
      restorePackageReview(review, error instanceof Error ? error.message : String(error));
    }
  };

  const handleImportDependencyFromLocalPicker = async (item: TeamDependencyPlanItem) => {
    if (!runtimeReady || !review || review.revision !== packageReviewRevisionRef.current || item.kind !== 'skill' || !item.installable || mutatingDependency || creatingRun) {
      return;
    }
    setCreateDialogPhase({ type: 'importing_dependency', review, dependencyName: item.name });
    setCreateError(null);
    try {
      const selectedPath = await pickLocalSkillSource({
        title: t('create.importLocalSkillButton'),
        buttonLabel: t('create.importLocalSkillButton'),
      });
      if (review.revision !== packageReviewRevisionRef.current) return;
      if (!selectedPath) {
        restorePackageReview(review);
        return;
      }
      const importedSkill = await readLocalSkillImport(selectedPath);
      if (review.revision !== packageReviewRevisionRef.current) return;
      if (!importedSkill) {
        restorePackageReview(review);
        return;
      }
      await importLocalSkill(importedSkill, review.candidate.runtimeScope);
      await finishSkillInstallation(importedSkill.skillKey, review.candidate.runtimeScope,
        () => review.revision === packageReviewRevisionRef.current);
      await refreshDependencyPlanAfterSkillChange(review);
    } catch (error) {
      restorePackageReview(review, error instanceof Error ? error.message : String(error));
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
    if (createSourceType !== 'teamskill' || !runtimeReady || !review || review.revision !== packageReviewRevisionRef.current || creatingRun || mutatingDependency || !review.dependencyPlan.canProceed) {
      return;
    }
    if (review.creationPlan.action === 'open_existing') {
      await openExistingTeam(review.creationPlan.teamId);
      return;
    }
    if (review.creationPlan.action === 'replace_required' && !replacementConfirmed) {
      return;
    }

    const operation = ++createOperationRef.current;
    setCreateDialogPhase({ type: 'creating_run', review });
    setCreateError(null);
    if (review.creationPlan.action === 'create') {
      const teamId = createTeam({ ...review.candidate, displayName: teamName.trim() || review.candidate.teamSkillPackage.name });
      try {
        await provisionTeamAgents(teamId);
        await createRun(teamId);
        if (operation !== createOperationRef.current || review.revision !== packageReviewRevisionRef.current) return;
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
        restorePackageReview(review, provisioningErrorMessage);
      }
      return;
    }

    const teamId = replaceTeamSkillVersion({
      teamId: review.creationPlan.teamId,
      expectedCurrentVersion: review.creationPlan.currentVersion,
      candidate: { ...review.candidate, displayName: teamName.trim() || review.candidate.teamSkillPackage.name },
    });
    try {
      await provisionTeamAgents(teamId);
      await createRun(teamId);
      if (operation !== createOperationRef.current || review.revision !== packageReviewRevisionRef.current) return;
      setActiveTeam(teamId);
      setCreateDialogOpen(false);
      navigate(`/teams/${teamId}`);
    } catch (error) {
      restorePackageReview(review, error instanceof Error ? error.message : String(error));
    }
  };

  const handleCreateManualTeam = async () => {
    if (!canCreateManualTeam) {
      return;
    }
    const operation = ++createOperationRef.current;
    setCreateError(null);
    try {
      const candidate = buildManualCandidate();
      setCreateDialogPhase({ type: 'creating_manual' });
      const teamId = await createManualTeamWithProgress(candidate);
      if (operation !== createOperationRef.current) return;
      setActiveTeam(teamId);
      setCreateDialogOpen(false);
      setCreateDialogPhase({ type: 'editing_source' });
      navigate(`/teams/${teamId}`);
    } catch (error) {
      if (operation !== createOperationRef.current) return;
      if (useTeamsStore.getState().manualTeamCreation === null) {
        setCreateDialogPhase({ type: 'editing_source' });
        setCreateError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  const handleSelectPackage = async (kind: 'directory' | 'archive') => {
    if (!canSelectPackage) return;
    const revision = ++packageReviewRevisionRef.current;
    setCreateDialogPhase({ type: 'selecting_package' });
    setCreateError(null);
    const label = t(kind === 'directory' ? 'create.browsePackageDirectory' : 'create.browsePackageArchive');
    try {
      const selectedPath = await (kind === 'directory' ? pickLocalDirectory : pickLocalArchive)({ title: label, buttonLabel: label });
      if (revision !== packageReviewRevisionRef.current) return;
      if (!selectedPath) {
        if (phaseReview) restorePackageReview({ ...phaseReview, revision });
        else setCreateDialogPhase({ type: 'editing_source' });
        return;
      }
      setTeamSkillPackagePath(selectedPath);
      await handleCheckPackage(selectedPath);
    } catch (error) {
      if (revision !== packageReviewRevisionRef.current) return;
      setCreateDialogPhase({ type: 'editing_source' });
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDeleteTeam = async (teamId: string) => {
    try {
      const result = await deleteTeam(teamId);
      if (result.state === 'outcome_unknown') {
        toast.warning(t('deleteToast.cleanupUnknownTitle'), {
          description: t('deleteToast.cleanupUnknownDescription'),
          duration: 8000,
        });
        return;
      }
      toast.success(t('deleteToast.deletedTitle'), {
        description: t('deleteToast.deletedDescription'),
        duration: 4000,
      });
    } catch {
      // Store keeps the team visible and records the per-team error.
    }
  };

  const primaryButtonLabel = createSourceType === 'manual'
    ? creatingManual ? t('create.creatingButton') : t('create.createButton')
    : review?.creationPlan.action === 'open_existing'
      ? t('create.openExistingButton')
      : review?.creationPlan.action === 'replace_required'
        ? creatingRun ? t('create.replacingButton') : t('create.replaceButton')
        : creatingRun ? t('create.creatingButton') : t('create.createButton');
  const primaryDisabled = createSourceType === 'manual'
    ? !canCreateManualTeam
    : !runtimeReady
      || !review
      || creatingRun
      || Boolean(mutatingDependency)
      || !review.dependencyPlan.canProceed
      || (review.creationPlan.action === 'replace_required' && !replacementConfirmed);

  return (
    <section className="space-y-6 text-foreground">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t('title')}</h1>
          {subtitle ? <p className="text-sm text-[hsl(var(--shell-text-muted))]">{subtitle}</p> : null}
        </div>
        {!createDialogOpen ? (
          <Button ref={createTriggerRef} onClick={() => setCreateDialogOpen(true)}>
            {t('create.openCreateDialog')}
          </Button>
        ) : null}
      </header>

      <Card className="overflow-hidden bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
        <CardContent className="grid gap-5 p-6 md:grid-cols-[1.2fr_0.8fr] md:items-center">
          <div className="space-y-3">
            <Badge variant="outline" className="w-fit">{t('overview.badge')}</Badge>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold tracking-[-0.02em]">{t('overview.title')}</h2>
              <p className="max-w-2xl text-sm leading-6 text-[hsl(var(--shell-text-muted))]">{t('overview.description')}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-2xl border bg-[hsl(var(--shell-surface))] p-2 text-center [border-color:hsl(var(--shell-border))]">
            <div className="rounded-xl bg-[hsl(var(--shell-surface-muted))] px-3 py-3">
              <div className="text-lg font-semibold">{teams.length}</div>
              <div className="text-[11px] text-[hsl(var(--shell-text-muted))]">{t('create.metricTeams')}</div>
            </div>
            <div className="rounded-xl bg-[hsl(var(--shell-surface-muted))] px-3 py-3">
              <div className="text-lg font-semibold" aria-busy={rolesLoading}>{provisionedRoleCount ?? (rolesLoading ? t('common:status.loading') : '—')}</div>
              <div className="text-[11px] text-[hsl(var(--shell-text-muted))]">{t('create.metricRoles')}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <DialogPrimitive.Root open={createDialogOpen} onOpenChange={(open) => {
        if (!open && !creatingManual && !creatingRun && !mutatingDependency) closeCreateDialog();
      }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[hsl(var(--shell-scrim))]" />
          <DialogPrimitive.Content
            ref={setCreateDialogElement}
            aria-describedby={undefined}
            aria-busy={creatingManual || creatingRun}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              createTitleRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              createTriggerRef.current?.focus();
            }}
            onInteractOutside={(event) => event.preventDefault()}
            className="fixed left-1/2 top-1/2 z-50 flex h-[min(680px,calc(100dvh-3rem))] w-[min(1000px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[22px] border border-border bg-card text-card-foreground shadow-[var(--shell-shadow-overlay)] outline-none max-sm:h-[calc(100dvh-1.5rem)] max-sm:w-[calc(100vw-1.5rem)]"
          >
            <header className="flex shrink-0 items-center gap-4 px-8 pb-6 pt-6 max-sm:px-5">
              <div aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
                <Users className="h-6 w-6" strokeWidth={1.6} />
              </div>
              <DialogPrimitive.Title ref={createTitleRef} tabIndex={-1} className="min-w-0 flex-1 text-[22px] font-semibold tracking-[-0.025em] outline-none">
                {manualTeamCreation ? t(`create.manualProgress.status.${manualTeamCreation.status}`) : t('create.modalTitle')}
              </DialogPrimitive.Title>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={showingManualCreation ? t('create.manualProgress.closeButton') : t('create.cancelButton')}
                disabled={creatingManual || creatingRun || Boolean(mutatingDependency)}
                onClick={closeCreateDialog}
                className="-mr-2 h-8 w-8 shrink-0 text-muted-foreground"
              >
                <X className="h-5 w-5" />
              </Button>
            </header>

            {manualTeamCreation ? (
              <ManualTeamCreationProgress creation={manualTeamCreation} />
            ) : (
            <div className="flex min-h-0 flex-1 flex-col px-8 max-sm:px-5">
              <fieldset disabled={creatingRun || Boolean(mutatingDependency)} className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(160px,205px)] gap-6 pb-6 max-sm:grid-cols-1 max-sm:gap-3">
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="team-name" className="text-xs text-muted-foreground">{t('create.teamName')}</Label>
                  <Input
                    id="team-name"
                    value={teamName}
                    onChange={(event) => {
                      setTeamName(event.target.value);
                    }}
                    placeholder={t('create.teamNamePlaceholder')}
                    className="h-11 bg-card text-sm"
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">{t('create.runtimeLabel')}</div>
                  <RuntimeScopeSelector
                    runtimeAdapterId="openclaw"
                    collisionBoundary={createDialogElement}
                    className="h-11 rounded-[var(--radius-interactive)] border border-border bg-muted/40 px-3"
                  />
                </div>
              </fieldset>

              <Tabs value={createSourceType} onValueChange={handleCreateSourceTypeChange} className="flex min-h-0 flex-1 flex-col">
                <div className="shrink-0 border-b border-border pb-6">
                  <TabsList className="grid w-[304px] max-w-full grid-cols-2 border-0 bg-muted/70">
                    <TabsTrigger value="manual" disabled={packageBusy} className="gap-2 px-3 text-xs data-[state=active]:shadow-sm">
                      <UserRoundPlus aria-hidden="true" className="h-4 w-4 shrink-0" />{t('create.sourceTypes.manual')}
                    </TabsTrigger>
                    <TabsTrigger value="teamskill" disabled={packageBusy} className="gap-2 px-3 text-xs data-[state=active]:shadow-sm">
                      <Package aria-hidden="true" className="h-4 w-4 shrink-0" />{t('create.sourceTypes.teamskill')}
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="teamskill" className="mt-0 min-h-0 flex-1 overflow-y-auto py-6">
                  <div className="grid min-h-full grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] max-sm:grid-cols-1">
                    <div className="min-w-0 pr-8 max-sm:pr-0">
                      <div className="flex min-h-48 flex-col items-center justify-center gap-5 rounded-[var(--radius-interactive)] border border-dashed border-input bg-muted/20 px-6 py-8 text-center">
                        <FolderArchive aria-hidden="true" className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
                        {packagePath ? <p title={packagePath} className="max-h-24 w-full overflow-y-auto break-all font-mono text-xs leading-5 text-muted-foreground">{packagePath}</p> : null}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" variant="outline" size="sm" disabled={!canSelectPackage} className="gap-2 bg-card text-xs">
                              {packagePath ? t('create.changePackage') : t('create.choosePackage')}
                              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent collisionBoundary={createDialogElement} align="center" className="min-w-44 max-w-[var(--radix-dropdown-menu-content-available-width)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
                            <DropdownMenuItem onSelect={() => void handleSelectPackage('directory')}>
                              <Folder aria-hidden="true" className="h-4 w-4" />{t('create.browsePackageDirectory')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void handleSelectPackage('archive')}>
                              <FileArchive aria-hidden="true" className="h-4 w-4" />{t('create.browsePackageArchive')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {checkingPackage ? (
                        <p role="status" className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{t('create.checkingButton')}
                        </p>
                      ) : packagePath && !review && !selectingPackage ? (
                        <Button type="button" variant="ghost" size="sm" disabled={!canSelectPackage} onClick={() => void handleCheckPackage(packagePath)} className="mt-3 text-xs">
                          {t('create.retryCheck')}
                        </Button>
                      ) : null}
                    </div>
                    <section aria-labelledby="team-preview-title" className="flex min-w-0 flex-col border-l border-border pl-8 max-sm:mt-6 max-sm:border-l-0 max-sm:border-t max-sm:pl-0 max-sm:pt-5">
                      <h3 id="team-preview-title" className="mb-5 text-sm font-semibold">{t('create.previewTitle')}</h3>
                      {review ? (
                    <div className="space-y-5">
                      <div>
                        <div className="text-sm font-medium text-foreground">{review.candidate.teamSkillPackage.name}@{review.candidate.teamSkillPackage.version}</div>
                        <div className="mt-1 text-sm text-muted-foreground">{review.candidate.teamSkillPackage.description}</div>
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
                            <div key={`${item.kind}:${item.name}`} className="flex flex-wrap items-start justify-between gap-3 border-t border-border py-3 text-sm">
                              <div className="min-w-0">
                                <div className="break-words font-medium">
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
                      ) : (
                        <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-6 py-6 text-center text-muted-foreground">
                          <div aria-hidden="true" className="flex flex-col items-center">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted/40"><Crown className="h-4 w-4" strokeWidth={1.5} /></div>
                            <div className="h-3 border-l border-border" />
                            <div className="flex gap-4 border-t border-border pt-3">
                              {[0, 1, 2].map((index) => <div key={index} className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-muted/20"><Bot className="h-3.5 w-3.5" strokeWidth={1.5} /></div>)}
                            </div>
                          </div>
                          <p className="text-xs">{t('create.previewEmpty')}</p>
                        </div>
                      )}
                    </section>
                  </div>
                </TabsContent>

                <TabsContent value="manual" className="mt-0 min-h-0 flex-1 overflow-y-auto py-6">
                  <TeamMemberPicker
                    key={managementScopeKey}
                    agents={teamAssignableAgents}
                    loading={agentsLoading}
                    error={managementMatches && agentsResource.status === 'error' ? agentsResource.error : null}
                    ready={manualAgentsReady}
                    members={manualMembers}
                    onMembersChange={(members) => {
                      setCreateError(null);
                      setManualMembers(members);
                    }}
                    onRefresh={() => void refreshManualAgents()}
                  />
                </TabsContent>
              </Tabs>
            </div>
            )}

            {createError && !showingManualCreation ? (
              <div role="alert" className="mx-8 mb-4 max-h-24 shrink-0 overflow-y-auto rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {createError}
              </div>
            ) : null}

            <footer className="flex min-h-[76px] shrink-0 items-center justify-end gap-3 border-t border-border px-8 py-4 max-sm:px-5">
              {manualTeamCreation ? (
                <>
                  <Button type="button" variant="ghost" disabled={creatingManual} onClick={closeCreateDialog} className="text-muted-foreground hover:bg-secondary hover:text-foreground">
                    {manualTeamCreation.status === 'unconfirmed' ? t('create.manualProgress.viewTeamsButton') : t('create.manualProgress.closeButton')}
                  </Button>
                  {manualTeamCreation.status === 'failed' && manualTeamCreation.cleanup === 'confirmed' ? (
                    <Button type="button" onClick={() => {
                      if (selectedEndpoint && manualTeamCreation.candidate.runtimeScope && runtimeEndpointsEqual(selectedEndpoint, manualTeamCreation.candidate.runtimeScope.endpoint)) {
                        setTeamName(manualTeamCreation.candidate.displayName);
                        setManualMembers(manualTeamCreation.candidate.manualTeam.members.map((member) => ({ agentId: member.agentId, isLeader: member.isLeader })));
                      }
                      resetManualTeamCreation();
                      setCreateSourceType('manual');
                      setCreateError(null);
                      resetPackageReview();
                    }}>
                      {t('create.manualProgress.editButton')}
                    </Button>
                  ) : creatingManual ? (
                    <span className="text-xs text-muted-foreground">{t('create.manualProgress.keepOpen')}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <Button type="button" variant="ghost" disabled={creatingRun || Boolean(mutatingDependency)} onClick={closeCreateDialog} className="text-muted-foreground hover:bg-secondary hover:text-foreground">
                    {t('create.cancelButton')}
                  </Button>
                  <Button type="button" onClick={() => void (createSourceType === 'manual' ? handleCreateManualTeam() : handleCreateOrReplace())} disabled={primaryDisabled}>
                    {primaryButtonLabel}
                  </Button>
                </>
              )}
            </footer>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">{t('list.title')}</h2>
        {teams.length === 0 ? (
          <Card>
            <CardContent className="py-4 text-sm text-muted-foreground">{t('list.empty')}</CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {teams.map((team, index) => {
              const roleCount = roleCounts[index];
              const roleLoading = roleCount === undefined && roleReads[team.id]?.loading;
              const deletingTeam = loadingByTeamId[team.id] === true;
              const teamError = errorByTeamId[team.id] ?? roleReads[team.id]?.error;
              return (
                <Card key={team.id}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{team.name}</div>
                        <div className="text-xs text-muted-foreground" aria-busy={Boolean(roleLoading)}>
                          {t('list.managedRoles')}: {roleCount ?? (roleLoading ? t('common:status.loading') : '—')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!endpoints.some((entry) => runtimeEndpointsEqual(entry.endpointRef, resolveTeamRuntimeScope(team.id).endpoint) && isRuntimeEndpointReady(entry))}
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
                          disabled={!endpoints.some((entry) => runtimeEndpointsEqual(entry.endpointRef, resolveTeamRuntimeScope(team.id).endpoint) && isRuntimeEndpointReady(entry)) || deletingTeam}
                          onClick={() => void handleDeleteTeam(team.id)}
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

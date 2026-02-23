import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, ChevronRight, LogOut, Plus, Trash2, User } from 'lucide-react';
import { ChatInput, type MentionCandidate } from '@/pages/Chat/ChatInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  deleteTeamSessions,
  runAgentAndCollectFinalOutput,
  runAgentAndCollectFinalText,
  runAgentAndCollectReportWithRun,
} from '@/pages/Teams/lib/orchestrator';
import {
  exportTeamFlowEvents,
  initTeamArtifactsLayout,
} from '@/pages/Teams/lib/team-artifacts';
import { buildTeamContextEnvelope, wrapMessageWithTeamContext } from '@/pages/Teams/lib/context';
import { fetchLatestAgentOutput } from '@/pages/Teams/lib/output';
import {
  buildPlanFormatRetryMessage,
  buildTeamTaskRuntime,
  parseTeamPlanFromText,
} from '@/pages/Teams/lib/plan';
import {
  buildReportRetryMessage,
  buildConvergenceDigestRetryMessage,
  buildControllerDecisionRetryMessage,
  buildExecutionBlueprintRetryMessage,
  buildReviewRetryMessage,
  type ControllerDecision,
  type RequiredDecision,
  parseConvergenceDigestFromText,
  parseExecutionBlueprintFromText,
  parseControllerDecisionFromText,
  parseTeamReviewJsonFromText,
  validateTeamPlanProtocol,
  validateTeamReportProtocol,
} from '@/pages/Teams/lib/protocol';
import { findForbiddenToolsForPhase } from '@/pages/Teams/lib/tool-policy';
import { ensureTeamPhaseTransition } from '@/pages/Teams/lib/fsm';
import { normalizeSubagentNameToSlug } from '@/lib/subagent/workspace';
import { resolvePlanAssignmentsForTeam } from '@/lib/team/role-resolver';
import type { PendingAgentCreation } from '@/lib/team/role-resolver';
import { filterMissingAgents } from '@/lib/team/binding';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import type { TeamBindingState, TeamContext, TeamPhase, TeamPlan, TeamTaskRuntime } from '@/types/team';
import type { SubagentSummary } from '@/types/subagent';
import { useTranslation } from 'react-i18next';

interface TeamChatProps {
  teamId?: string;
}

interface PendingBootstrapState {
  plan: TeamPlan;
  sourceMessage: string;
  requests: PendingAgentCreation[];
}

type ConvergenceMode = 'chat' | 'review_run' | 'decision_resolution';
type ConvergenceIssueKind = 'blocker' | 'required-decision' | 'suggestion';
type ConvergenceIssueState = 'open' | 'resolved' | 'deferred';

interface ConvergenceIssue {
  id: string;
  kind: ConvergenceIssueKind;
  state: ConvergenceIssueState;
  content: string;
  owner?: string;
  sourceRound: number;
  decisionKey?: string;
  options?: string[];
  defaultValue?: string;
}

const CONTROLLER_DECISION_MAX_RETRY = 2;
const CONTROLLER_DRIFT_MAX_ROUNDS = 3;
const TEAM_DISCUSSION_MAX_ROUNDS_STORAGE_KEY = 'clawx.team.discussion.maxRounds';
const DEFAULT_CONTROLLER_DISCUSSION_MAX_ROUNDS = 5;
const CONTROLLER_DISCUSSION_MAX_ROUNDS_OPTIONS = [3, 5, 8, 12];
const CONVERGENCE_MAX_ROUNDS = 3;
const CONVERGENCE_REVIEW_MAX_RETRY = 2;
const CONVERGENCE_DIGEST_MAX_RETRY = 2;
const CONVERGENCE_BLUEPRINT_MAX_RETRY = 2;

type BootstrapItemStatus = 'pending' | 'creating' | 'drafting' | 'applying' | 'done' | 'error';

function bootstrapRequestKey(request: PendingAgentCreation): string {
  return `${request.role}:${request.suggestedName}`;
}

function bootstrapStatusLabel(status: BootstrapItemStatus): string {
  switch (status) {
    case 'creating':
      return '创建中';
    case 'drafting':
      return '草稿中';
    case 'applying':
      return '应用中';
    case 'done':
      return '已完成';
    case 'error':
      return '失败';
    default:
      return '待处理';
  }
}

function bootstrapStatusClass(status: BootstrapItemStatus): string {
  switch (status) {
    case 'done':
      return 'bg-emerald-100 text-emerald-700 border-emerald-300';
    case 'error':
      return 'bg-rose-100 text-rose-700 border-rose-300';
    case 'creating':
    case 'drafting':
    case 'applying':
      return 'bg-blue-100 text-blue-700 border-blue-300';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

function mergeRequiredDecisions(list: RequiredDecision[]): RequiredDecision[] {
  const byKey = new Map<string, RequiredDecision>();
  for (const item of list) {
    const key = item.key?.trim();
    const question = item.question?.trim();
    if (!key || !question) {
      continue;
    }
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        key,
        question,
        ...(item.defaultValue ? { defaultValue: item.defaultValue } : {}),
        options: uniq(item.options ?? []),
      });
      continue;
    }
    byKey.set(key, {
      ...prev,
      question: prev.question || question,
      defaultValue: prev.defaultValue || item.defaultValue,
      options: uniq([...(prev.options ?? []), ...(item.options ?? [])]),
    });
  }
  return Array.from(byKey.values());
}

function toIssueSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'issue';
}

function buildConvergenceIssueId(input: {
  kind: ConvergenceIssueKind;
  content: string;
  decisionKey?: string;
}): string {
  if (input.kind === 'required-decision' && input.decisionKey) {
    return `decision:${toIssueSlug(input.decisionKey)}`;
  }
  const prefix = input.kind === 'blocker'
    ? 'blocker'
    : input.kind === 'suggestion'
      ? 'suggestion'
      : 'decision';
  return `${prefix}:${toIssueSlug(input.content)}`;
}

function parseDirectMemberReplyCommand(message: string): { target: string; prompt: string } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('@')) {
    return null;
  }
  const match = trimmed.match(/^@([^\s]+)\s+回答(?:\s*[:：]\s*|\s+)?([\s\S]*)$/);
  if (!match) {
    return null;
  }
  return {
    target: match[1].trim(),
    prompt: (match[2] ?? '').trim(),
  };
}

function getAgentDisplayEmoji(agent: SubagentSummary | undefined, agentId: string): string {
  if (agent?.identityEmoji) {
    return agent.identityEmoji;
  }
  return agentId === 'main' ? '\u2699\uFE0F' : '\uD83E\uDD16';
}

function buildWorkspaceMapForTeam(input: {
  controllerId: string;
  memberIds: string[];
  agents: SubagentSummary[];
}): Record<string, string> {
  const workspaceByAgent: Record<string, string> = {};
  for (const memberId of input.memberIds) {
    const workspace = input.agents.find((agent) => agent.id === memberId)?.workspace?.trim();
    if (workspace) {
      workspaceByAgent[memberId] = workspace;
    }
  }
  const controllerWorkspace = workspaceByAgent[input.controllerId];
  if (!controllerWorkspace) {
    throw new Error(`Controller workspace not found: ${input.controllerId}`);
  }
  return workspaceByAgent;
}

function buildNextTeamContext(previous: TeamContext | undefined, result: string[]): TeamContext {
  const prev: TeamContext = previous ?? {
    goal: '',
    plan: [],
    roles: [],
    status: 'running',
    decisions: [],
    openQuestions: [],
    artifacts: [],
    updatedAt: new Date().toISOString(),
  };

  return {
    ...prev,
    decisions: uniq([...prev.decisions, ...result]),
    artifacts: uniq([...prev.artifacts, ...result]),
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
}

function buildTaskExecutionMessage(input: {
  task: TeamTaskRuntime;
  rawMessage: string;
  envelope: ReturnType<typeof buildTeamContextEnvelope>;
}): string {
  const payload = {
    task_id: input.task.taskId,
    agent_id: input.task.agentId,
    instruction: input.task.instruction,
    acceptance: input.task.acceptance,
    user_message: input.rawMessage,
  };
  return [
    '[TEAM_CONTEXT]',
    JSON.stringify(input.envelope, null, 2),
    '',
    '[TEAM_TASK]',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function systemErrorMessage(text: string): string {
  return `WARNING: ${text}`;
}

function normalizeDiscussionMaxRounds(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CONTROLLER_DISCUSSION_MAX_ROUNDS;
  }
  const normalized = Math.floor(parsed);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 20) {
    return 20;
  }
  return normalized;
}

function buildDiscussionLoopContinuationMessage(input: {
  originalMessage: string;
  round: number;
  previousReply: string;
}): string {
  const lines = [
    input.originalMessage,
    '',
    `[DISCUSSION_LOOP_ROUND] ${input.round}`,
    'Continue research and return CONTROLLER_DECISION JSON only.',
    'Semantic contract:',
    '- ask_user: if you ask user questions or still need user confirmation.',
    '- keep_research: internal research only, no questions to user.',
    '- ready_for_planning: no open questions, no question-style reply.',
    '- ready_for_convergence: no open questions, no question-style reply.',
    'If information is sufficient, use action=ready_for_planning.',
    'If plan already exists and you can start member convergence review, use action=ready_for_convergence.',
    'If user input is still required, use action=ask_user and ask concrete questions.',
  ];
  if (input.previousReply.trim()) {
    lines.push('', '[PREVIOUS_REPLY]', input.previousReply.trim());
  }
  return lines.join('\n');
}

function replyLooksLikeQuestion(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (/[?？]/.test(normalized)) {
    return true;
  }
  const hints = [
    '需要确认',
    '请确认',
    '请提供',
    '请补充',
    '请选择',
    '是否',
    'which',
    'what',
    'could you',
    'please provide',
  ];
  const lower = normalized.toLowerCase();
  return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

function normalizeDiscussionDecision(decision: ControllerDecision): ControllerDecision {
  const hasQuestionReply = replyLooksLikeQuestion(decision.reply);
  const hasQuestions = (decision.questions?.length ?? 0) > 0;
  const hasMissingInfo = (decision.missingInfo?.length ?? 0) > 0;

  if (decision.action === 'ask_user') {
    return decision;
  }

  if (decision.action === 'keep_research') {
    if (!hasQuestionReply && !hasQuestions && !hasMissingInfo) {
      return decision;
    }
    return {
      ...decision,
      action: 'ask_user',
      reason: decision.reason || 'normalized: keep_research with user-question signal',
    };
  }

  if (decision.action === 'ready_for_planning' || decision.action === 'ready_for_convergence') {
    if (!hasQuestionReply && !hasQuestions && !hasMissingInfo) {
      return decision;
    }
    return {
      ...decision,
      action: 'ask_user',
      reason: decision.reason || `normalized: ${decision.action} with open questions`,
    };
  }

  return decision;
}

function buildBootstrapPrompt(input: {
  request: PendingAgentCreation;
  plan: TeamPlan;
}): string {
  return [
    'You are being created as a reusable specialist subagent for multi-team collaboration.',
    `Current team objective (context only): ${input.plan.objective}`,
    `Role to create: ${input.request.role}`,
    `Role summary: ${input.request.summary}`,
    `Related tasks in this team: ${input.request.taskIds.join(', ')}`,
    '',
    'Generate and refine AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md.',
    'Requirements:',
    '1. Make the agent reusable across projects and teams; do not hardcode this single objective.',
    '2. Define stable expertise boundaries, deliverable contracts, and collaboration protocol.',
    '3. Include structured REPORT output contract for done / partial / blocked.',
    '4. Keep text concise and executable; avoid task-specific filler.',
    '5. roleMetadata.summary and roleMetadata.tags must describe generalized long-term capability.',
  ].join('\n');
}
export function TeamChat({ teamId }: TeamChatProps = {}) {
  const { t } = useTranslation('teams');
  const [discussionMaxRounds, setDiscussionMaxRounds] = useState<number>(() => {
    try {
      return normalizeDiscussionMaxRounds(
        window.localStorage.getItem(TEAM_DISCUSSION_MAX_ROUNDS_STORAGE_KEY),
      );
    } catch {
      return DEFAULT_CONTROLLER_DISCUSSION_MAX_ROUNDS;
    }
  });
  const [refreshingByAgent, setRefreshingByAgent] = useState<Record<string, boolean>>({});
  const [removingByAgent, setRemovingByAgent] = useState<Record<string, boolean>>({});
  const [executing, setExecuting] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState('');
  const [bindingState, setBindingState] = useState<TeamBindingState>({
    status: 'idle',
    missingAgentIds: [],
  });
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [pendingBootstrap, setPendingBootstrap] = useState<PendingBootstrapState | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapProgress, setBootstrapProgress] = useState<Record<string, BootstrapItemStatus>>({});
  const [convergenceMode, setConvergenceMode] = useState<ConvergenceMode>('chat');
  const [convergenceIssues, setConvergenceIssues] = useState<ConvergenceIssue[]>([]);
  const [pendingConvergenceDecisions, setPendingConvergenceDecisions] = useState<RequiredDecision[]>([]);
  const [resolvedConvergenceDecisions, setResolvedConvergenceDecisions] = useState<Record<string, string>>({});
  const [decisionDraftValues, setDecisionDraftValues] = useState<Record<string, string>>({});
  const [convergenceAssumptions, setConvergenceAssumptions] = useState<string[]>([]);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const controllerDriftRoundsRef = useRef(0);

  const teams = useTeamsStore((state) => state.teams);
  const teamSessionKeys = useTeamsStore((state) => state.teamSessionKeys);
  const teamReports = useTeamsStore((state) => state.teamReports);
  const teamContexts = useTeamsStore((state) => state.teamContexts);
  const teamPhaseById = useTeamsStore((state) => state.teamPhaseById);
  const teamMessagesById = useTeamsStore((state) => state.teamMessagesById);
  const agentLatestOutput = useTeamsStore((state) => state.agentLatestOutput);
  const teamPlans = useTeamsStore((state) => state.teamPlans);
  const teamTasksById = useTeamsStore((state) => state.teamTasksById);
  const teamMemberRuntimeById = useTeamsStore((state) => state.teamMemberRuntimeById);
  const teamAuditById = useTeamsStore((state) => state.teamAuditById);
  const teamFlowEventsById = useTeamsStore((state) => state.teamFlowEventsById);
  const bindTeamMembers = useTeamsStore((state) => state.bindTeamMembers);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const resetTeamRuntime = useTeamsStore((state) => state.resetTeamRuntime);
  const clearTeamMemberRuntime = useTeamsStore((state) => state.clearTeamMemberRuntime);
  const updateTeam = useTeamsStore((state) => state.updateTeam);
  const setTeamPhase = useTeamsStore((state) => state.setTeamPhase);
  const appendReport = useTeamsStore((state) => state.appendReport);
  const updateTeamContext = useTeamsStore((state) => state.updateTeamContext);
  const appendTeamMessage = useTeamsStore((state) => state.appendTeamMessage);
  const setAgentLatestOutput = useTeamsStore((state) => state.setAgentLatestOutput);
  const setTeamPlan = useTeamsStore((state) => state.setTeamPlan);
  const setTeamTasks = useTeamsStore((state) => state.setTeamTasks);
  const upsertTeamTask = useTeamsStore((state) => state.upsertTeamTask);
  const setTeamMemberRuntime = useTeamsStore((state) => state.setTeamMemberRuntime);
  const appendTeamAudit = useTeamsStore((state) => state.appendTeamAudit);
  const appendTeamFlowEvent = useTeamsStore((state) => state.appendTeamFlowEvent);
  const agents = useSubagentsStore((state) => state.agents);
  const agentsLoading = useSubagentsStore((state) => state.loading);
  const agentsError = useSubagentsStore((state) => state.error);
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const createAgent = useSubagentsStore((state) => state.createAgent);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const generateDraftFromPrompt = useSubagentsStore((state) => state.generateDraftFromPrompt);
  const applyDraft = useSubagentsStore((state) => state.applyDraft);
  const setDraftPromptForAgent = useSubagentsStore((state) => state.setDraftPromptForAgent);
  const navigate = useNavigate();

  const team = teams.find((item) => item.id === teamId);
  const outputByAgent = teamId ? (agentLatestOutput[teamId] ?? {}) : {};
  const sessionKeyByAgent = teamId ? (teamSessionKeys[teamId] ?? {}) : {};
  const messages = teamId ? (teamMessagesById[teamId] ?? []) : [];
  const phase = teamId ? (teamPhaseById[teamId] ?? 'discussion') : 'discussion';
  const reportCount = teamId ? (teamReports[teamId]?.length ?? 0) : 0;
  const reports = teamId ? (teamReports[teamId] ?? []) : [];
  const teamPlan = teamId ? (teamPlans[teamId] ?? null) : null;
  const teamTasks = teamId ? (teamTasksById[teamId] ?? []) : [];
  const memberRuntimeMap = teamId ? (teamMemberRuntimeById[teamId] ?? {}) : {};
  const teamAudit = teamId ? (teamAuditById[teamId] ?? []) : [];
  const teamFlowEvents = teamId ? (teamFlowEventsById[teamId] ?? []) : [];
  const availableAgentsToAdd = team
    ? agents.filter((agent) => !team.memberIds.includes(agent.id))
    : [];
  const existingTeamAgents = team
    ? agents.filter((agent) => team.memberIds.includes(agent.id))
    : [];
  const teamMentionCandidates: MentionCandidate[] = team
    ? team.memberIds.map((memberId) => {
      const member = agents.find((item) => item.id === memberId);
      const displayName = member?.name?.trim();
      return {
        id: memberId,
        label: displayName && displayName !== memberId ? displayName : undefined,
        insertText: `@${memberId} 回答 `,
      };
    })
    : [];
  const blockerIssues = convergenceIssues.filter((issue) => issue.kind === 'blocker');
  const requiredDecisionIssues = convergenceIssues.filter((issue) => issue.kind === 'required-decision');
  const suggestionIssues = convergenceIssues.filter((issue) => issue.kind === 'suggestion');
  const openBlockerIssues = blockerIssues.filter((issue) => issue.state === 'open');
  const openRequiredDecisionIssues = requiredDecisionIssues.filter((issue) => issue.state === 'open');
  const canConfirmExecution = teamTasks.length > 0
    && openBlockerIssues.length === 0
    && openRequiredDecisionIssues.length === 0
    && convergenceMode !== 'review_run'
    && convergenceMode !== 'decision_resolution'
    && !executing
    && !bootstrapping;

  const logFlowEvent = (input: {
    type:
      | 'phase-transition'
      | 'controller-decision'
      | 'tool-policy-blocked'
      | 'review-collected'
      | 'convergence-digest'
      | 'convergence-round'
      | 'execution-blueprint'
      | 'action';
    actor: 'program' | 'controller' | 'member';
    phase: TeamPhase;
    agentId?: string;
    note?: string;
    payload?: Record<string, unknown>;
  }) => {
    if (!team) {
      return;
    }
    appendTeamFlowEvent(team.id, {
      id: crypto.randomUUID(),
      teamId: team.id,
      phase: input.phase,
      type: input.type,
      actor: input.actor,
      agentId: input.agentId,
      timestamp: Date.now(),
      note: input.note,
      payload: input.payload,
    });
  };

  const switchPhase = (nextPhase: TeamPhase) => {
    if (!team) {
      return false;
    }
    const currentPhase = useTeamsStore.getState().teamPhaseById[team.id] ?? phase;
    const validation = ensureTeamPhaseTransition({ from: currentPhase, to: nextPhase });
    if (!validation.ok) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(validation.error),
        timestamp: Date.now() / 1000,
      });
      return false;
    }
    setTeamPhase(team.id, nextPhase);
    logFlowEvent({
      type: 'phase-transition',
      actor: 'program',
      phase: currentPhase,
      note: `${currentPhase} -> ${nextPhase}`,
      payload: { from: currentPhase, to: nextPhase },
    });
    return true;
  };

  useEffect(() => {
    void loadAgents();
    void loadAvailableModels();
  }, [loadAgents, loadAvailableModels]);

  useEffect(() => {
    if (!team) {
      console.warn('[TeamChat] binding skipped: team not found', {
        routeTeamId: teamId,
      });
      setBindingState({
        status: 'error',
        missingAgentIds: [],
        error: 'Team not found or removed',
      });
      return;
    }

    setBindingState({ status: 'validating-agents', missingAgentIds: [] });
    try {
      if (team.memberIds.length === 0) {
        setBindingState({
          status: 'error',
          missingAgentIds: [],
          error: 'Team has no members',
        });
        return;
      }
      if (agentsLoading && agents.length === 0) {
        console.info('[TeamChat] binding waiting: agents are loading', {
          teamId: team.id,
          teamMemberIds: team.memberIds,
        });
        return;
      }
      if (agentsError && agents.length === 0) {
        setBindingState({
          status: 'error',
          missingAgentIds: [],
          error: `Failed to load agents: ${agentsError}`,
        });
        return;
      }

      const missingAgentIds = filterMissingAgents(
        team.memberIds,
        agents.map((agent) => agent.id),
      );

      console.info('[TeamChat] member binding check', {
        teamId: team.id,
        teamMemberIds: team.memberIds,
        loadedAgentIds: agents.map((agent) => agent.id),
        missingAgentIds,
      });

      if (missingAgentIds.length > 0) {
        setBindingState({
          status: 'missing-agents',
          missingAgentIds,
          error: `Missing team members: ${missingAgentIds.join(', ')}`,
        });
        return;
      }

      setActiveTeam(team.id);
      bindTeamMembers(team.id, team.memberIds);
      setBindingState({ status: 'ready', missingAgentIds: [] });
    } catch (error) {
      setBindingState({
        status: 'error',
        missingAgentIds: [],
        error: error instanceof Error ? error.message : 'Member validation failed',
      });
    }
  }, [team, teamId, agents, agentsLoading, agentsError, bindTeamMembers, setActiveTeam]);

  useEffect(() => {
    const element = messagesContainerRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!pendingBootstrap) {
      setBootstrapProgress({});
      return;
    }
    const next: Record<string, BootstrapItemStatus> = {};
    pendingBootstrap.requests.forEach((request) => {
      next[bootstrapRequestKey(request)] = 'pending';
    });
    setBootstrapProgress(next);
  }, [pendingBootstrap]);

  useEffect(() => {
    if (phase === 'convergence') {
      return;
    }
    setConvergenceMode('chat');
    setConvergenceIssues([]);
    setPendingConvergenceDecisions([]);
    setResolvedConvergenceDecisions({});
    setDecisionDraftValues({});
    setConvergenceAssumptions([]);
  }, [phase, team?.id]);

  useEffect(() => {
    if (pendingConvergenceDecisions.length === 0) {
      setDecisionDraftValues({});
      return;
    }
    setDecisionDraftValues((prev) => {
      const next: Record<string, string> = {};
      pendingConvergenceDecisions.forEach((item) => {
        next[item.key] = prev[item.key]
          ?? item.defaultValue
          ?? item.options?.[0]
          ?? '';
      });
      return next;
    });
  }, [pendingConvergenceDecisions]);

  const handleExitTeamChat = async () => {
    if (!team) {
      return;
    }
    setExecuting(true);
    try {
      const sessionKeys = team.memberIds.map(
        (agentId) => sessionKeyByAgent[agentId] ?? `agent:${agentId}:team:${team.id}`
      );
      await deleteTeamSessions(sessionKeys);
      resetTeamRuntime(team.id);
      setActiveTeam(null);
      navigate('/teams');
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(error instanceof Error ? error.message : t('flow.exitFailed')),
        timestamp: Date.now() / 1000,
      });
    } finally {
      setExecuting(false);
    }
  };

  const handleRemoveMember = async (agentId: string) => {
    if (!team) {
      return;
    }
    if (team.memberIds.length <= 1) {
      return;
    }
    const nextMemberIds = team.memberIds.filter((id) => id !== agentId);
    if (nextMemberIds.length === 0) {
      return;
    }
    const sessionKey = sessionKeyByAgent[agentId] ?? `agent:${agentId}:team:${team.id}`;
    setRemovingByAgent((state) => ({ ...state, [agentId]: true }));
    try {
      await deleteTeamSessions([sessionKey]);
      clearTeamMemberRuntime(team.id, agentId);
    } finally {
      setRemovingByAgent((state) => ({ ...state, [agentId]: false }));
    }
    const nextControllerId = team.controllerId === agentId ? nextMemberIds[0] : team.controllerId;
    const updatedTeam = {
      ...team,
      memberIds: nextMemberIds,
      controllerId: nextControllerId,
      updatedAt: Date.now(),
    };
    updateTeam(updatedTeam);
    bindTeamMembers(team.id, nextMemberIds);
  };

  const handleAddMember = () => {
    if (!team || !addingAgentId) {
      return;
    }
    if (team.memberIds.includes(addingAgentId)) {
      return;
    }
    updateTeam({
      ...team,
      memberIds: [...team.memberIds, addingAgentId],
      updatedAt: Date.now(),
    });
    setAddingAgentId('');
  };

  const refreshAgent = async (agentId: string) => {
    if (!team || !teamId) {
      return;
    }
    const sessionKey = sessionKeyByAgent[agentId] ?? `agent:${agentId}:team:${team.id}`;
    setRefreshingByAgent((state) => ({ ...state, [agentId]: true }));
    try {
      const latestOutput = await fetchLatestAgentOutput(sessionKey);
      setAgentLatestOutput(team.id, agentId, latestOutput);
    } catch {
      setAgentLatestOutput(team.id, agentId, '');
    } finally {
      setRefreshingByAgent((state) => ({ ...state, [agentId]: false }));
    }
  };

  const refreshTeamMembers = async () => {
    if (!team) {
      return;
    }
    await Promise.all(team.memberIds.map((agentId) => refreshAgent(agentId)));
  };

  const handleChangeDiscussionMaxRounds = (value: number) => {
    const nextValue = normalizeDiscussionMaxRounds(value);
    setDiscussionMaxRounds(nextValue);
    try {
      window.localStorage.setItem(TEAM_DISCUSSION_MAX_ROUNDS_STORAGE_KEY, String(nextValue));
    } catch {
      // Ignore storage write errors and keep runtime value.
    }
  };

  const handleExportFlowAudit = async () => {
    if (!team) {
      return;
    }
    if (teamFlowEvents.length === 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.exportFlowEmpty')),
        timestamp: Date.now() / 1000,
      });
      return;
    }

    try {
      const workspaceByAgent = buildWorkspaceMapForTeam({
        controllerId: team.controllerId,
        memberIds: team.memberIds,
        agents,
      });
      const layout = await initTeamArtifactsLayout({
        teamId: team.id,
        controllerId: team.controllerId,
        workspaceByAgent,
      });
      const result = await exportTeamFlowEvents({
        teamId: team.id,
        controllerId: team.controllerId,
        workspaceByAgent,
        teamName: team.name,
        phase,
        flowEvents: teamFlowEvents,
      });
      await window.electron.ipcRenderer.invoke('shell:showItemInFolder', result.auditPath);
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: t('flow.exportFlowSuccess', {
          file: result.fileName,
          dir: layout.canonicalRoot,
        }),
        timestamp: Date.now() / 1000,
      });
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.exportFlowFailed', {
          error: error instanceof Error ? error.message : String(error),
        })),
        timestamp: Date.now() / 1000,
      });
    }
  };

  const persistResolvedPlan = async (input: {
    plan: TeamPlan;
    fallbackMessage: string;
    finalPlanText: string;
  }): Promise<'ok' | 'pending-bootstrap' | 'failed'> => {
    if (!team) {
      return 'failed';
    }

    const latestTeam = useTeamsStore.getState().teams.find((item) => item.id === team.id);
    if (!latestTeam) {
      return 'failed';
    }
    const latestAgents = useSubagentsStore.getState().agents;
    const resolver = await resolvePlanAssignmentsForTeam({
      team: latestTeam,
      plan: input.plan,
      agents: latestAgents,
      getAgents: () => useSubagentsStore.getState().agents,
      createAgent,
      loadAgents,
      defaultModel: availableModels[0]?.id ?? latestAgents[0]?.model,
      allowCreate: false,
    });

    if (resolver.pendingAgentCreations.length > 0) {
      setPendingBootstrap({
        plan: input.plan,
        sourceMessage: input.fallbackMessage,
        requests: resolver.pendingAgentCreations,
      });
      switchPhase('team-setup');
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: t('flow.pendingBootstrap', { count: resolver.pendingAgentCreations.length }),
        timestamp: Date.now() / 1000,
      });
      return 'pending-bootstrap';
    }

    const runtimeTasks = buildTeamTaskRuntime({
      plan: input.plan,
      resolvedAgentByTaskId: resolver.resolvedAgentByTaskId,
    });

    if (runtimeTasks.length === 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.noExecutableTask')),
        timestamp: Date.now() / 1000,
      });
      return 'failed';
    }

    setTeamPlan(team.id, input.plan);
    setTeamTasks(team.id, runtimeTasks);
    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'system',
      content: t('flow.controllerSuggested'),
      timestamp: Date.now() / 1000,
    });

    if (!input.finalPlanText.trim()) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(`${t('flow.emptyReply')} ${input.fallbackMessage}`),
        timestamp: Date.now() / 1000,
      });
    }
    return 'ok';
  };

  const resolveAndPersistPlan = async (planText: string, fallbackMessage: string): Promise<'ok' | 'pending-bootstrap' | 'failed'> => {
    if (!team) {
      return 'failed';
    }

    let parsedPlan = parseTeamPlanFromText(planText);
    let finalPlanText = planText;

    if (!parsedPlan) {
      const controllerSessionKey = sessionKeyByAgent[team.controllerId] ?? `agent:${team.controllerId}:team:${team.id}`;
      try {
        const retryText = await runAgentAndCollectFinalText({
          agentId: team.controllerId,
          sessionKey: controllerSessionKey,
          message: buildPlanFormatRetryMessage(),
          idempotencyKey: `${team.id}:${team.controllerId}:plan-retry:${crypto.randomUUID()}`,
        });
        finalPlanText = retryText;
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'assistant',
          agentId: team.controllerId,
          content: retryText || t('flow.emptyReply'),
          kind: 'plan',
          timestamp: Date.now() / 1000,
        });
        parsedPlan = parseTeamPlanFromText(retryText);
      } catch (error) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage(error instanceof Error ? error.message : t('flow.planRetryFailed')),
          timestamp: Date.now() / 1000,
        });
        return 'failed';
      }
    }

    if (!parsedPlan) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.invalidPlanOutput')),
        timestamp: Date.now() / 1000,
      });
      return 'failed';
    }

    const validation = validateTeamPlanProtocol(parsedPlan);
    if (!validation.ok) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(validation.error),
        timestamp: Date.now() / 1000,
      });
      return 'failed';
    }

    const status = await persistResolvedPlan({
      plan: parsedPlan,
      fallbackMessage,
      finalPlanText,
    });
    return status;
  };

  const detectCreatedAgentId = (input: {
    beforeIds: Set<string>;
    suggestedName: string;
  }): string | null => {
    const latestAgents = useSubagentsStore.getState().agents;
    const expectedId = normalizeSubagentNameToSlug(input.suggestedName);
    const exact = latestAgents.find((agent) => !input.beforeIds.has(agent.id) && agent.id === expectedId);
    if (exact) {
      return exact.id;
    }
    const fallback = latestAgents.find((agent) => !input.beforeIds.has(agent.id) && normalizeSubagentNameToSlug(agent.name ?? agent.id) === expectedId);
    return fallback?.id ?? null;
  };

  const handleConfirmPendingBootstrap = async () => {
    if (!team || !pendingBootstrap) {
      return;
    }

    setBootstrapping(true);
    try {
      const createdAgentIds: string[] = [];
      const defaultModel = availableModels[0]?.id ?? useSubagentsStore.getState().agents[0]?.model;

      for (const request of pendingBootstrap.requests) {
        const requestKey = bootstrapRequestKey(request);
        try {
          const beforeIds = new Set(useSubagentsStore.getState().agents.map((agent) => agent.id));
          setBootstrapProgress((state) => ({ ...state, [requestKey]: 'creating' }));
          await createAgent({
            name: request.suggestedName,
            workspace: '',
            model: defaultModel,
            emoji: '\uD83E\uDD16',
          });
          await loadAgents();

          const createdAgentId = detectCreatedAgentId({
            beforeIds,
            suggestedName: request.suggestedName,
          });
          if (!createdAgentId) {
            throw new Error(t('flow.bootstrapCreateFailed', { name: request.suggestedName }));
          }

          const bootstrapPrompt = buildBootstrapPrompt({
            request,
            plan: pendingBootstrap.plan,
          });
          setDraftPromptForAgent(createdAgentId, bootstrapPrompt);
          setBootstrapProgress((state) => ({ ...state, [requestKey]: 'drafting' }));
          await generateDraftFromPrompt(createdAgentId, bootstrapPrompt);
          setBootstrapProgress((state) => ({ ...state, [requestKey]: 'applying' }));
          await applyDraft(createdAgentId);

          createdAgentIds.push(createdAgentId);
          setBootstrapProgress((state) => ({ ...state, [requestKey]: 'done' }));
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: t('flow.bootstrapCreatedOne', { name: request.suggestedName }),
            timestamp: Date.now() / 1000,
          });
        } catch (error) {
          setBootstrapProgress((state) => ({ ...state, [requestKey]: 'error' }));
          throw error;
        }
      }

      const latestTeam = useTeamsStore.getState().teams.find((item) => item.id === team.id);
      if (!latestTeam) {
        throw new Error('Team not found after bootstrap');
      }
      const nextMemberIds = uniq([...latestTeam.memberIds, ...createdAgentIds]);
      if (nextMemberIds.length !== latestTeam.memberIds.length) {
        updateTeam({
          ...latestTeam,
          memberIds: nextMemberIds,
          updatedAt: Date.now(),
        });
        bindTeamMembers(latestTeam.id, nextMemberIds);
      }
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: t('flow.autoCreatedAgents', { count: createdAgentIds.length }),
        timestamp: Date.now() / 1000,
      });

      const finalized = await persistResolvedPlan({
        plan: pendingBootstrap.plan,
        fallbackMessage: pendingBootstrap.sourceMessage,
        finalPlanText: '[bootstrap-confirmed]',
      });
      if (finalized !== 'ok') {
        throw new Error(t('flow.bootstrapFinalizeFailed'));
      }

      setPendingBootstrap(null);
      if (switchPhase('convergence')) {
        setConvergenceMode('chat');
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: t('flow.convergenceReady'),
          timestamp: Date.now() / 1000,
        });
      }
      await refreshTeamMembers();
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(error instanceof Error ? error.message : t('flow.execFailed')),
        timestamp: Date.now() / 1000,
      });
    } finally {
      setBootstrapping(false);
    }
  };

  const handleCancelPendingBootstrap = () => {
    if (!team) {
      return;
    }
    setPendingBootstrap(null);
    switchPhase('discussion');
    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'system',
      content: t('flow.bootstrapCancelled'),
      timestamp: Date.now() / 1000,
    });
  };

  const executeRound = async (message: string) => {
    if (!team || !teamId) {
      return;
    }

    const latestTasks = (useTeamsStore.getState().teamTasksById[team.id] ?? [])
      .filter((task) => ['pending', 'blocked', 'missing-report', 'error'].includes(task.status));
    if (latestTasks.length === 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.noTaskToExecute')),
        timestamp: Date.now() / 1000,
      });
      return;
    }

    setExecuting(true);
    try {
      let doneCount = 0;
      for (const task of latestTasks) {
        logFlowEvent({
          type: 'action',
          actor: 'program',
          phase: 'execution',
          agentId: task.agentId,
          note: `dispatch:${task.taskId}`,
        });
        const sessionKey = sessionKeyByAgent[task.agentId] ?? `agent:${task.agentId}:team:${team.id}`;
        const startedAt = Date.now();
        setTeamMemberRuntime(team.id, task.agentId, {
          status: 'running',
          currentTaskId: task.taskId,
          lastTaskId: task.taskId,
        });
        upsertTeamTask(team.id, {
          ...task,
          status: 'running',
          attempts: task.attempts + 1,
          startedAt,
          updatedAt: startedAt,
          lastError: undefined,
        });

        const envelope = buildTeamContextEnvelope({
          team,
          phase,
          context: teamContexts[team.id],
          reports,
          agents: useSubagentsStore.getState().agents,
        });
        const executionMessage = buildTaskExecutionMessage({
          task,
          rawMessage: message,
          envelope,
        });

        try {
          let runResult = await runAgentAndCollectReportWithRun({
            agentId: task.agentId,
            sessionKey,
            message: executionMessage,
            idempotencyKey: `${team.id}:${task.taskId}:${task.attempts + 1}`,
            reportDefaults: {
              defaultTaskId: task.taskId,
              defaultAgentId: task.agentId,
            },
          });
          if (!runResult.report) {
            runResult = await runAgentAndCollectReportWithRun({
              agentId: task.agentId,
              sessionKey,
              message: `${executionMessage}\n\n${buildReportRetryMessage({
                taskId: task.taskId,
                agentId: task.agentId,
              })}`,
              idempotencyKey: `${team.id}:${task.taskId}:retry:${task.attempts + 1}`,
              reportDefaults: {
                defaultTaskId: task.taskId,
                defaultAgentId: task.agentId,
              },
            });
          }

          const finishedAt = Date.now();
          const durationMs = finishedAt - startedAt;
          const reportValidation = validateTeamReportProtocol(runResult.report);
          if (!reportValidation.ok) {
            upsertTeamTask(team.id, {
              ...task,
              status: 'missing-report',
              attempts: task.attempts + 1,
              startedAt,
              finishedAt,
              updatedAt: finishedAt,
              runId: runResult.runId,
              lastError: reportValidation.error,
            });
            setTeamMemberRuntime(team.id, task.agentId, {
              status: 'missing-report',
              currentTaskId: undefined,
              lastTaskId: task.taskId,
              lastRunId: runResult.runId,
              lastDurationMs: durationMs,
              lastError: reportValidation.error,
            });
            appendTeamAudit(team.id, {
              teamId: team.id,
              agentId: task.agentId,
              taskId: task.taskId,
              runId: runResult.runId,
              status: 'missing-report',
              timestamp: finishedAt,
              error: reportValidation.error,
            });
            appendTeamMessage(team.id, {
              id: crypto.randomUUID(),
              role: 'system',
              content: systemErrorMessage(`${task.agentId}: ${reportValidation.error}`),
              timestamp: Date.now() / 1000,
            });
            continue;
          }

          const report = runResult.report!;
          appendReport(team.id, report);
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'assistant',
            agentId: task.agentId,
            content: `REPORT: ${JSON.stringify(report)}`,
            kind: 'report',
            timestamp: Date.now() / 1000,
          });

          const mappedStatus = report.status === 'done'
            ? 'done'
            : report.status === 'blocked'
              ? 'blocked'
              : 'blocked';

          upsertTeamTask(team.id, {
            ...task,
            status: mappedStatus,
            attempts: task.attempts + 1,
            startedAt,
            finishedAt,
            updatedAt: finishedAt,
            runId: runResult.runId,
            reportId: report.reportId,
            lastError: undefined,
          });

          setTeamMemberRuntime(team.id, task.agentId, {
            status: mappedStatus === 'done' ? 'done' : 'blocked',
            currentTaskId: undefined,
            lastTaskId: task.taskId,
            lastRunId: runResult.runId,
            lastReportId: report.reportId,
            lastDurationMs: durationMs,
            lastError: mappedStatus === 'done' ? undefined : t('flow.taskBlocked'),
          });

          appendTeamAudit(team.id, {
            teamId: team.id,
            agentId: task.agentId,
            taskId: task.taskId,
            runId: runResult.runId,
            reportId: report.reportId,
            status: mappedStatus,
            timestamp: finishedAt,
          });

          if (report.status === 'done') {
            doneCount += 1;
            const nextContext = buildNextTeamContext(teamContexts[team.id], report.result);
            updateTeamContext(team.id, nextContext);
          }
        } catch (error) {
          const finishedAt = Date.now();
          const messageText = error instanceof Error ? error.message : t('flow.execFailed');
          upsertTeamTask(team.id, {
            ...task,
            status: 'error',
            attempts: task.attempts + 1,
            startedAt,
            finishedAt,
            updatedAt: finishedAt,
            lastError: messageText,
          });
          setTeamMemberRuntime(team.id, task.agentId, {
            status: 'error',
            currentTaskId: undefined,
            lastTaskId: task.taskId,
            lastError: messageText,
            lastDurationMs: finishedAt - startedAt,
          });
          appendTeamAudit(team.id, {
            teamId: team.id,
            agentId: task.agentId,
            taskId: task.taskId,
            status: 'error',
            timestamp: finishedAt,
            error: messageText,
          });
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: systemErrorMessage(`${task.agentId}: ${messageText}`),
            timestamp: Date.now() / 1000,
          });
        }
      }

      const latestAfter = useTeamsStore.getState().teamTasksById[team.id] ?? [];
      const allDone = latestAfter.length > 0 && latestAfter.every((task) => task.status === 'done');
      if (allDone) {
        switchPhase('done');
      }
    } finally {
      setConvergenceMode((prev) => (prev === 'review_run' ? 'chat' : prev));
      setExecuting(false);
      await refreshTeamMembers();
    }
  };

  const runControllerDecisionRound = async (input: {
    runtimeMessage: string;
  }): Promise<{
    decision: ReturnType<typeof parseControllerDecisionFromText>;
    text: string;
  }> => {
    if (!team) {
      return { decision: null, text: '' };
    }

    const controllerSessionKey = sessionKeyByAgent[team.controllerId] ?? `agent:${team.controllerId}:team:${team.id}`;
    let lastText = '';
    let prompt = [
      input.runtimeMessage,
      '',
      'Return CONTROLLER_DECISION JSON only.',
      'Semantic contract:',
      '- ask_user: use when user input/confirmation is still required.',
      '- keep_research: internal research only, no question to user.',
      '- ready_for_planning: use only when no open questions remain.',
      '- ready_for_convergence: use only when no open questions remain and plan is ready for review.',
      'Format:',
      '{"action":"keep_research|ask_user|ready_for_planning|ready_for_convergence","reply":"...","reason":"optional","questions":[],"missing_info":[],"ready_reason":"optional"}',
    ].join('\n');

    for (let attempt = 0; attempt <= CONTROLLER_DECISION_MAX_RETRY; attempt += 1) {
      const result = await runAgentAndCollectFinalOutput({
        agentId: team.controllerId,
        sessionKey: controllerSessionKey,
        message: prompt,
        idempotencyKey: `${team.id}:${team.controllerId}:decision:${crypto.randomUUID()}`,
      });
      lastText = result.text?.trim() ?? '';

      const forbiddenTools = findForbiddenToolsForPhase({
        phase,
        usedTools: result.usedTools ?? [],
      });
      if (forbiddenTools.length > 0) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage(t('flow.controllerDriftBlocked', {
            phase,
            tools: forbiddenTools.join(', '),
          })),
          timestamp: Date.now() / 1000,
        });
        logFlowEvent({
          type: 'tool-policy-blocked',
          actor: 'controller',
          phase,
          agentId: team.controllerId,
          note: forbiddenTools.join(', '),
        });
        prompt = buildControllerDecisionRetryMessage();
        continue;
      }

      const decision = parseControllerDecisionFromText(lastText);
      if (decision) {
        logFlowEvent({
          type: 'controller-decision',
          actor: 'controller',
          phase,
          agentId: team.controllerId,
          note: decision.action,
        });
        return { decision, text: lastText };
      }

      if (attempt < CONTROLLER_DECISION_MAX_RETRY) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage(t('flow.controllerDecisionInvalid', {
            current: attempt + 1,
            max: CONTROLLER_DECISION_MAX_RETRY + 1,
          })),
          timestamp: Date.now() / 1000,
        });
        prompt = buildControllerDecisionRetryMessage();
      }
    }

    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'system',
      content: systemErrorMessage(t('flow.controllerDecisionFailed')),
      timestamp: Date.now() / 1000,
    });

    return { decision: null, text: lastText };
  };

  const planningRound = async (message: string) => {
    if (!team) {
      return;
    }
    const runtimeMessage = wrapMessageWithTeamContext(message, buildTeamContextEnvelope({
      team,
      phase: 'planning',
      context: teamContexts[team.id],
      reports,
      agents,
    }));

    setExecuting(true);
    try {
      const controllerSessionKey = sessionKeyByAgent[team.controllerId] ?? `agent:${team.controllerId}:team:${team.id}`;
      const output = await runAgentAndCollectFinalOutput({
        agentId: team.controllerId,
        sessionKey: controllerSessionKey,
        message: `${runtimeMessage}\n\nPlease return a strict PLAN JSON object.`,
        idempotencyKey: `${team.id}:${team.controllerId}:planning:${crypto.randomUUID()}`,
      });
      const forbiddenTools = findForbiddenToolsForPhase({
        phase: 'planning',
        usedTools: output.usedTools ?? [],
      });
      if (forbiddenTools.length > 0) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage(t('flow.controllerDriftBlocked', {
            phase: 'planning',
            tools: forbiddenTools.join(', '),
          })),
          timestamp: Date.now() / 1000,
        });
        switchPhase('discussion');
        return;
      }
      const planText = output.text ?? '';
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        agentId: team.controllerId,
        content: planText || t('flow.emptyReply'),
        kind: 'plan',
        timestamp: Date.now() / 1000,
      });

      const parsed = await resolveAndPersistPlan(planText, message);
      if (parsed === 'ok') {
        if (switchPhase('convergence')) {
          setConvergenceMode('chat');
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: `${t('flow.planningDone')}\n${t('flow.convergenceReady')}`,
            timestamp: Date.now() / 1000,
          });
        }
      } else if (parsed === 'pending-bootstrap') {
        switchPhase('team-setup');
      } else {
        switchPhase('discussion');
      }
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(error instanceof Error ? error.message : t('flow.planRetryFailed')),
        timestamp: Date.now() / 1000,
      });
      switchPhase('discussion');
    } finally {
      setExecuting(false);
      await refreshTeamMembers();
    }
  };

  const convergenceDecisionValidationErrors = (): string[] => {
    if (!pendingConvergenceDecisions.length) {
      return [];
    }
    const errors: string[] = [];
    pendingConvergenceDecisions.forEach((decision) => {
      const value = (decisionDraftValues[decision.key] ?? '').trim();
      if (!value) {
        errors.push(`${decision.key}: 不能为空`);
        return;
      }
      if ((decision.options?.length ?? 0) > 0 && !decision.options.includes(value)) {
        errors.push(`${decision.key}: 必须是可选值之一 (${decision.options.join(', ')})`);
      }
    });
    return errors;
  };

  const applyFilledConvergenceDecisions = async () => {
    if (!team || pendingConvergenceDecisions.length === 0 || executing) {
      return;
    }
    const errors = convergenceDecisionValidationErrors();
    if (errors.length > 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(`${t('flow.convergenceDecisionValidationFailed')}: ${errors.join('；')}`),
        timestamp: Date.now() / 1000,
      });
      return;
    }

    const resolved: Record<string, string> = {};
    const assumptions: string[] = [];
    for (const item of pendingConvergenceDecisions) {
      const value = (decisionDraftValues[item.key] ?? '').trim();
      resolved[item.key] = value;
      assumptions.push(`decision:${item.key}=${value}`);
    }
    setResolvedConvergenceDecisions((prev) => ({ ...prev, ...resolved }));
    setConvergenceAssumptions((prev) => uniq([...prev, ...assumptions]));
    setPendingConvergenceDecisions([]);
    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'system',
      content: t('flow.convergenceDecisionsApplied', { count: Object.keys(resolved).length }),
      timestamp: Date.now() / 1000,
    });
    setConvergenceMode('chat');
    setConvergenceIssues((prev) => prev.map((issue) => {
      if (issue.kind === 'required-decision' && issue.decisionKey && resolved[issue.decisionKey]) {
        return { ...issue, state: 'resolved' };
      }
      return issue;
    }));
  };

  const runConvergenceChatByAgent = async (input: {
    agentId: string;
    message: string;
    modeTag: 'CONVERGENCE_CHAT_MODE' | 'CONVERGENCE_MEMBER_CHAT_MODE';
    note: string;
  }) => {
    if (!team) {
      return;
    }
    setExecuting(true);
    try {
      const runtimeMessage = wrapMessageWithTeamContext(
        [
          input.message,
          '',
          `[${input.modeTag}]`,
          'This is normal user Q&A in convergence stage.',
          'Do not run member review in this turn.',
          'Answer briefly and concretely.',
        ].join('\n'),
        buildTeamContextEnvelope({
          team,
          phase: 'convergence',
          context: teamContexts[team.id],
          reports,
          agents,
        }),
      );
      const sessionKey = sessionKeyByAgent[input.agentId] ?? `agent:${input.agentId}:team:${team.id}`;
      const output = await runAgentAndCollectFinalOutput({
        agentId: input.agentId,
        sessionKey,
        message: runtimeMessage,
        idempotencyKey: `${team.id}:${input.agentId}:convergence-chat:${crypto.randomUUID()}`,
      });
      const forbiddenTools = findForbiddenToolsForPhase({
        phase: 'convergence',
        usedTools: output.usedTools ?? [],
      });
      if (forbiddenTools.length > 0) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage(t('flow.controllerDriftBlocked', {
            phase: 'convergence',
            tools: forbiddenTools.join(', '),
          })),
          timestamp: Date.now() / 1000,
        });
        return;
      }
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        agentId: input.agentId,
        content: output.text || t('flow.emptyReply'),
        timestamp: Date.now() / 1000,
      });
      logFlowEvent({
        type: 'action',
        actor: input.agentId === team.controllerId ? 'controller' : 'member',
        phase: 'convergence',
        agentId: input.agentId,
        note: input.note,
      });
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(error instanceof Error ? error.message : t('flow.execFailed')),
        timestamp: Date.now() / 1000,
      });
    } finally {
      setExecuting(false);
      await refreshTeamMembers();
    }
  };

  const controllerChatInConvergence = async (message: string) => {
    if (!team) {
      return;
    }
    await runConvergenceChatByAgent({
      agentId: team.controllerId,
      message,
      modeTag: 'CONVERGENCE_CHAT_MODE',
      note: 'convergence-chat-controller',
    });
  };

  const resolveTeamMemberForDirectReply = (target: string): string | null => {
    if (!team) {
      return null;
    }
    const normalizedTarget = normalizeSubagentNameToSlug(target);
    for (const memberId of team.memberIds) {
      const member = agents.find((item) => item.id === memberId);
      const idMatch = memberId === target || normalizeSubagentNameToSlug(memberId) === normalizedTarget;
      const nameMatch = member?.name
        ? normalizeSubagentNameToSlug(member.name) === normalizedTarget
        : false;
      if (idMatch || nameMatch) {
        return memberId;
      }
    }
    return null;
  };

  const memberChatInConvergence = async (input: {
    target: string;
    prompt: string;
  }) => {
    if (!team) {
      return;
    }
    const targetAgentId = resolveTeamMemberForDirectReply(input.target);
    if (!targetAgentId) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.memberMentionNotFound', { target: input.target })),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    const prompt = input.prompt || t('flow.memberMentionDefaultPrompt');
    await runConvergenceChatByAgent({
      agentId: targetAgentId,
      message: prompt,
      modeTag: 'CONVERGENCE_MEMBER_CHAT_MODE',
      note: `convergence-chat-member:${targetAgentId}`,
    });
  };

  const applyDefaultConvergenceDecisions = async () => {
    if (!team || pendingConvergenceDecisions.length === 0 || executing) {
      return;
    }
    const resolved: Record<string, string> = {};
    const assumptions: string[] = [];
    for (const item of pendingConvergenceDecisions) {
      const fallback = item.defaultValue ?? item.options?.[0] ?? 'accept-default';
      resolved[item.key] = fallback;
      assumptions.push(`decision:${item.key}=${fallback}`);
    }
    setResolvedConvergenceDecisions((prev) => ({ ...prev, ...resolved }));
    setConvergenceAssumptions((prev) => uniq([...prev, ...assumptions]));
    setPendingConvergenceDecisions([]);
    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'system',
      content: t('flow.convergenceDefaultsApplied', { count: Object.keys(resolved).length }),
      timestamp: Date.now() / 1000,
    });
    setConvergenceMode('chat');
    setConvergenceIssues((prev) => prev.map((issue) => {
      if (issue.kind === 'required-decision' && issue.decisionKey && resolved[issue.decisionKey]) {
        return { ...issue, state: 'resolved' };
      }
      return issue;
    }));
  };

  const syncConvergenceIssuesFromRound = (input: {
    round: number;
    reviews: Array<{
      agentId: string;
      review: NonNullable<ReturnType<typeof parseTeamReviewJsonFromText>>;
    }>;
    blockers: string[];
    requiredDecisions: RequiredDecision[];
    suggestions: string[];
  }) => {
    setConvergenceIssues((prev) => {
      const existingById = new Map(prev.map((issue) => [issue.id, issue] as const));
      const nextById = new Map<string, ConvergenceIssue>();

      const blockerOwnerMap = new Map<string, string>();
      const decisionOwnerMap = new Map<string, string>();
      const suggestionOwnerMap = new Map<string, string>();

      input.reviews.forEach(({ agentId, review }) => {
        review.blockers.forEach((item) => {
          if (!blockerOwnerMap.has(item)) {
            blockerOwnerMap.set(item, agentId);
          }
        });
        review.requiredDecisions.forEach((item) => {
          if (!decisionOwnerMap.has(item.key)) {
            decisionOwnerMap.set(item.key, agentId);
          }
        });
        review.suggestions.forEach((item) => {
          if (!suggestionOwnerMap.has(item)) {
            suggestionOwnerMap.set(item, agentId);
          }
        });
      });

      input.blockers.forEach((item) => {
        const id = buildConvergenceIssueId({ kind: 'blocker', content: item });
        const existing = existingById.get(id);
        nextById.set(id, {
          id,
          kind: 'blocker',
          state: 'open',
          content: item,
          owner: blockerOwnerMap.get(item) ?? existing?.owner,
          sourceRound: existing?.sourceRound ?? input.round,
        });
      });

      input.requiredDecisions.forEach((item) => {
        const id = buildConvergenceIssueId({
          kind: 'required-decision',
          content: item.question,
          decisionKey: item.key,
        });
        const existing = existingById.get(id);
        const isResolved = Boolean(resolvedConvergenceDecisions[item.key]);
        nextById.set(id, {
          id,
          kind: 'required-decision',
          state: isResolved ? 'resolved' : 'open',
          content: item.question,
          owner: decisionOwnerMap.get(item.key) ?? existing?.owner,
          sourceRound: existing?.sourceRound ?? input.round,
          decisionKey: item.key,
          options: item.options,
          defaultValue: item.defaultValue,
        });
      });

      input.suggestions.forEach((item) => {
        const id = buildConvergenceIssueId({ kind: 'suggestion', content: item });
        const existing = existingById.get(id);
        nextById.set(id, {
          id,
          kind: 'suggestion',
          state: existing?.state ?? 'deferred',
          content: item,
          owner: suggestionOwnerMap.get(item) ?? existing?.owner,
          sourceRound: existing?.sourceRound ?? input.round,
        });
      });

      existingById.forEach((existing, id) => {
        if (nextById.has(id)) {
          return;
        }
        if (existing.kind === 'suggestion') {
          nextById.set(id, existing);
          return;
        }
        if (existing.kind === 'required-decision') {
          nextById.set(id, {
            ...existing,
            state: 'resolved',
          });
          return;
        }
        nextById.set(id, {
          ...existing,
          state: 'resolved',
        });
      });

      return Array.from(nextById.values()).sort((a, b) => a.id.localeCompare(b.id));
    });
  };

  const convergenceRound = async (message: string) => {
    if (!team || !teamPlan) {
      return;
    }
    if (teamTasks.length === 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.noExecutableTask')),
        timestamp: Date.now() / 1000,
      });
      return;
    }

    const reviewers = team.memberIds.filter((agentId) => agentId !== team.controllerId);
    if (reviewers.length === 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.membersNotReady')),
        timestamp: Date.now() / 1000,
      });
      return;
    }

    setExecuting(true);
    setConvergenceMode('review_run');
    try {
      const planPayload = {
        objective: teamPlan.objective,
        tasks: teamTasks.map((task) => ({
          taskId: task.taskId,
          agentId: task.agentId,
          instruction: task.instruction,
          acceptance: task.acceptance,
          dependsOn: teamPlan.tasks.find((item) => item.taskId === task.taskId)?.dependsOn ?? [],
        })),
        risks: teamPlan.risks ?? [],
      };
      const controllerSessionKey = sessionKeyByAgent[team.controllerId] ?? `agent:${team.controllerId}:team:${team.id}`;

      let digest: ReturnType<typeof parseConvergenceDigestFromText> = null;
      let latestReviews: Array<{
        agentId: string;
        review: NonNullable<ReturnType<typeof parseTeamReviewJsonFromText>>;
      }> = [];
      let latestBlockers: string[] = [];
      let latestRequiredDecisions: RequiredDecision[] = [];
      let latestSuggestions: string[] = [];

      for (let round = 1; round <= CONVERGENCE_MAX_ROUNDS; round += 1) {
        logFlowEvent({
          type: 'convergence-round',
          actor: 'program',
          phase: 'convergence',
          note: `start:${round}`,
          payload: { round },
        });

        const unresolvedFromPrevRound = {
          blockers: latestBlockers,
          requiredDecisions: latestRequiredDecisions.filter((item) => !resolvedConvergenceDecisions[item.key]),
        };
        const roundReviews: Array<{
          agentId: string;
          review: NonNullable<ReturnType<typeof parseTeamReviewJsonFromText>>;
        }> = [];

        for (const agentId of reviewers) {
          const sessionKey = sessionKeyByAgent[agentId] ?? `agent:${agentId}:team:${team.id}`;
          const basePrompt = [
            '[CONVERGENCE_ROUND]',
            String(round),
            '',
            '[PLAN_JSON]',
            JSON.stringify(planPayload, null, 2),
            '',
            '[ROUND_GOAL]',
            round === 1
              ? 'Collect blockers, required_decisions, suggestions.'
              : round === 2
                ? 'Confirm unresolved blockers/required_decisions from previous round.'
                : 'Handle unresolved blockers/required_decisions only. Do not introduce unrelated new items.',
            '',
            round > 1 ? '[UNRESOLVED_FROM_PREVIOUS]' : '',
            round > 1
              ? JSON.stringify(
                {
                  blockers: unresolvedFromPrevRound.blockers,
                  required_decisions: unresolvedFromPrevRound.requiredDecisions,
                },
                null,
                2,
              )
              : '',
            round > 1 ? '' : '',
            '[RESOLVED_DECISIONS]',
            JSON.stringify(resolvedConvergenceDecisions, null, 2),
            '',
            digest ? '[LAST_DIGEST]' : '',
            digest ? JSON.stringify(digest, null, 2) : '',
            digest ? '' : '',
            '[USER_MESSAGE]',
            message,
            '',
            'Return REVIEW_JSON only.',
            '{',
            `  "agent_id": "${agentId}",`,
            '  "verdict": "approve | revise | blocked",',
            '  "summary": "one sentence conclusion",',
            '  "blockers": ["blocking issue 1"],',
            '  "required_decisions": [{"key":"decision-key","question":"one decision question","default_value":"default choice","options":["default choice","alternative"]}],',
            '  "suggestions": ["suggestion 1"],',
            '  "rules": "approve only if blockers=[] and required_decisions=[]"',
            '}',
          ].filter(Boolean).join('\n');

          let prompt = basePrompt;
          let parsedReview: ReturnType<typeof parseTeamReviewJsonFromText> = null;
          let lastText = '';

          for (let attempt = 1; attempt <= CONVERGENCE_REVIEW_MAX_RETRY; attempt += 1) {
            const output = await runAgentAndCollectFinalOutput({
              agentId,
              sessionKey,
              message: prompt,
              idempotencyKey: `${team.id}:${agentId}:review:r${round}:${crypto.randomUUID()}`,
            });
            lastText = output.text ?? '';

            const forbiddenTools = findForbiddenToolsForPhase({
              phase: 'convergence',
              usedTools: output.usedTools ?? [],
            });
            if (forbiddenTools.length > 0) {
              appendTeamMessage(team.id, {
                id: crypto.randomUUID(),
                role: 'system',
                content: systemErrorMessage(t('flow.controllerDriftBlocked', {
                  phase: 'convergence',
                  tools: forbiddenTools.join(', '),
                })),
                timestamp: Date.now() / 1000,
              });
              logFlowEvent({
                type: 'tool-policy-blocked',
                actor: 'member',
                phase: 'convergence',
                agentId,
                note: forbiddenTools.join(', '),
              });
              prompt = buildReviewRetryMessage(agentId);
              continue;
            }

            parsedReview = parseTeamReviewJsonFromText(lastText);
            if (parsedReview) {
              break;
            }
            prompt = buildReviewRetryMessage(agentId);
          }

          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'assistant',
            agentId,
            content: lastText || t('flow.emptyReply'),
            timestamp: Date.now() / 1000,
          });

          if (!parsedReview) {
            appendTeamMessage(team.id, {
              id: crypto.randomUUID(),
              role: 'system',
              content: systemErrorMessage(`${agentId}: invalid REVIEW_JSON`),
              timestamp: Date.now() / 1000,
            });
            parsedReview = {
              agentId,
              verdict: 'blocked',
              summary: 'review-format-invalid',
              blockers: ['invalid REVIEW_JSON'],
              requiredDecisions: [],
              suggestions: [],
            };
          }

          logFlowEvent({
            type: 'review-collected',
            actor: 'member',
            phase: 'convergence',
            agentId,
            note: parsedReview.verdict,
            payload: {
              round,
              verdict: parsedReview.verdict,
              blockerCount: parsedReview.blockers.length,
              requiredDecisionCount: parsedReview.requiredDecisions.length,
            },
          });
          roundReviews.push({ agentId, review: parsedReview });
        }

        latestReviews = roundReviews;
        const roundBlockers = uniq(roundReviews.flatMap((item) => item.review.blockers));
        const roundRequiredDecisions = mergeRequiredDecisions(
          roundReviews.flatMap((item) => item.review.requiredDecisions),
        ).filter((item) => !resolvedConvergenceDecisions[item.key]);
        const roundSuggestions = uniq(roundReviews.flatMap((item) => item.review.suggestions));
        latestSuggestions = uniq([...latestSuggestions, ...roundSuggestions]);
        latestBlockers = roundBlockers;
        latestRequiredDecisions = roundRequiredDecisions;
        syncConvergenceIssuesFromRound({
          round,
          reviews: roundReviews,
          blockers: latestBlockers,
          requiredDecisions: latestRequiredDecisions,
          suggestions: latestSuggestions,
        });

        const baseDigestPrompt = [
          '[CONVERGENCE_ROUND]',
          String(round),
          '',
          '[PLAN_JSON]',
          JSON.stringify(planPayload, null, 2),
          '',
          '[REVIEWS]',
          JSON.stringify(roundReviews.map((item) => item.review), null, 2),
          '',
          '[PROGRAM_CONVERGENCE_STATE]',
          JSON.stringify({
            blockers: latestBlockers,
            required_decisions: latestRequiredDecisions,
            suggestions: latestSuggestions,
          }, null, 2),
          '',
          'Return CONVERGENCE_DIGEST_JSON only.',
          '{',
          '  "status": "continue | ready",',
          '  "summary": "one sentence digest",',
          '  "agreements": ["agreement 1"],',
          '  "conflicts": ["conflict 1"],',
          '  "open_questions": ["open question 1"]',
          '}',
        ].join('\n');

        let digestPrompt = baseDigestPrompt;
        let digestText = '';
        let parsedDigest: ReturnType<typeof parseConvergenceDigestFromText> = null;

        for (let attempt = 1; attempt <= CONVERGENCE_DIGEST_MAX_RETRY; attempt += 1) {
          const output = await runAgentAndCollectFinalOutput({
            agentId: team.controllerId,
            sessionKey: controllerSessionKey,
            message: digestPrompt,
            idempotencyKey: `${team.id}:${team.controllerId}:digest:r${round}:${crypto.randomUUID()}`,
          });
          digestText = output.text ?? '';

          const forbiddenTools = findForbiddenToolsForPhase({
            phase: 'convergence',
            usedTools: output.usedTools ?? [],
          });
          if (forbiddenTools.length > 0) {
            appendTeamMessage(team.id, {
              id: crypto.randomUUID(),
              role: 'system',
              content: systemErrorMessage(t('flow.controllerDriftBlocked', {
                phase: 'convergence',
                tools: forbiddenTools.join(', '),
              })),
              timestamp: Date.now() / 1000,
            });
            logFlowEvent({
              type: 'tool-policy-blocked',
              actor: 'controller',
              phase: 'convergence',
              agentId: team.controllerId,
              note: forbiddenTools.join(', '),
            });
            digestPrompt = buildConvergenceDigestRetryMessage();
            continue;
          }

          parsedDigest = parseConvergenceDigestFromText(digestText);
          if (parsedDigest) {
            break;
          }
          digestPrompt = buildConvergenceDigestRetryMessage();
        }

        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'assistant',
          agentId: team.controllerId,
          content: parsedDigest?.summary || digestText || t('flow.emptyReply'),
          timestamp: Date.now() / 1000,
        });

        if (!parsedDigest) {
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: systemErrorMessage('invalid CONVERGENCE_DIGEST_JSON'),
            timestamp: Date.now() / 1000,
          });
          return;
        }

        digest = parsedDigest;
        logFlowEvent({
          type: 'convergence-digest',
          actor: 'controller',
          phase: 'convergence',
          agentId: team.controllerId,
          note: parsedDigest.status,
          payload: {
            round,
            conflicts: parsedDigest.conflicts.length,
            openQuestions: parsedDigest.openQuestions.length,
            blockers: latestBlockers.length,
            requiredDecisions: latestRequiredDecisions.length,
          },
        });
        logFlowEvent({
          type: 'convergence-round',
          actor: 'program',
          phase: 'convergence',
          note: `end:${round}`,
          payload: {
            round,
            digestStatus: parsedDigest.status,
            blockers: latestBlockers.length,
            requiredDecisions: latestRequiredDecisions.length,
          },
        });

        const unresolvedExists = latestBlockers.length > 0 || latestRequiredDecisions.length > 0;
        if (unresolvedExists && round < CONVERGENCE_MAX_ROUNDS) {
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: t('flow.convergenceContinueRound', { round: round + 1 }),
            timestamp: Date.now() / 1000,
          });
          continue;
        }

        if (parsedDigest.status === 'continue' && round >= CONVERGENCE_MAX_ROUNDS) {
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: systemErrorMessage(t('flow.convergenceRoundLimitReached', { count: CONVERGENCE_MAX_ROUNDS })),
            timestamp: Date.now() / 1000,
          });
          logFlowEvent({
            type: 'action',
            actor: 'program',
            phase: 'convergence',
            note: 'convergence-round-limit-unresolved',
            payload: {
              blockers: latestBlockers.length,
              requiredDecisions: latestRequiredDecisions.length,
            },
          });
        }
        break;
      }

      if (latestRequiredDecisions.length > 0) {
        const withDefaults = latestRequiredDecisions.map((item) => ({
          ...item,
          defaultValue: item.defaultValue || item.options?.[0] || 'accept-default',
        }));
        setPendingConvergenceDecisions(withDefaults);
        setConvergenceMode('decision_resolution');
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: t('flow.convergencePendingDecisions', { count: withDefaults.length }),
          timestamp: Date.now() / 1000,
        });
        logFlowEvent({
          type: 'action',
          actor: 'program',
          phase: 'convergence',
          note: 'convergence-required-decisions-pending',
          payload: {
            count: withDefaults.length,
            keys: withDefaults.map((item) => item.key),
          },
        });
        return;
      }
      setPendingConvergenceDecisions([]);
      setConvergenceMode('chat');

      const mustFix = latestBlockers;
      const requiredDecisionsResolved = latestRequiredDecisions.length === 0;
      const assumptions = uniq(
        [
          ...convergenceAssumptions,
          ...Object.entries(resolvedConvergenceDecisions).map(([key, value]) => `decision:${key}=${value}`),
        ],
      );

      const baseBlueprintPrompt = [
        '[PLAN_JSON]',
        JSON.stringify(planPayload, null, 2),
        '',
        '[REVIEWS]',
        JSON.stringify(latestReviews.map((item) => item.review), null, 2),
        '',
        '[CONVERGENCE_DIGEST_JSON]',
        JSON.stringify(digest, null, 2),
        '',
        '[PROGRAM_GATE]',
        JSON.stringify({
          must_fix: mustFix,
          required_decisions_resolved: requiredDecisionsResolved,
          assumptions,
        }, null, 2),
        '',
        '[USER_MESSAGE]',
        message,
        '',
        'Return EXECUTION_BLUEPRINT JSON only.',
        '{',
        '  "action": "revise_plan | ready_to_execute | ask_user",',
        '  "reply": "one sentence for user",',
        '  "reason": "optional rationale",',
        '  "must_fix": ["blocking item 1"],',
        '  "required_decisions_resolved": true,',
        '  "assumptions": ["decision:x=y"]',
        '}',
      ].join('\n');

      let blueprintPrompt = baseBlueprintPrompt;
      let blueprintText = '';
      let blueprint = null as ReturnType<typeof parseExecutionBlueprintFromText>;
      for (let attempt = 1; attempt <= CONVERGENCE_BLUEPRINT_MAX_RETRY; attempt += 1) {
        const output = await runAgentAndCollectFinalOutput({
          agentId: team.controllerId,
          sessionKey: controllerSessionKey,
          message: blueprintPrompt,
          idempotencyKey: `${team.id}:${team.controllerId}:blueprint:${crypto.randomUUID()}`,
        });
        blueprintText = output.text ?? '';

        const forbiddenTools = findForbiddenToolsForPhase({
          phase: 'convergence',
          usedTools: output.usedTools ?? [],
        });
        if (forbiddenTools.length > 0) {
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: systemErrorMessage(t('flow.controllerDriftBlocked', {
              phase: 'convergence',
              tools: forbiddenTools.join(', '),
            })),
            timestamp: Date.now() / 1000,
          });
          logFlowEvent({
            type: 'tool-policy-blocked',
            actor: 'controller',
            phase: 'convergence',
            agentId: team.controllerId,
            note: forbiddenTools.join(', '),
          });
          blueprintPrompt = buildExecutionBlueprintRetryMessage();
          continue;
        }

        blueprint = parseExecutionBlueprintFromText(blueprintText);
        if (blueprint) {
          break;
        }
        blueprintPrompt = buildExecutionBlueprintRetryMessage();
      }

      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        agentId: team.controllerId,
        content: blueprint?.reply || blueprintText || t('flow.emptyReply'),
        timestamp: Date.now() / 1000,
      });

      if (!blueprint) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage('invalid EXECUTION_BLUEPRINT'),
          timestamp: Date.now() / 1000,
        });
        return;
      }

      logFlowEvent({
        type: 'execution-blueprint',
        actor: 'controller',
        phase: 'convergence',
        agentId: team.controllerId,
        note: blueprint.action,
      });

      const effectiveBlueprintAction: 'revise_plan' | 'ready_to_execute' | 'ask_user' =
        mustFix.length > 0
          ? 'revise_plan'
          : !requiredDecisionsResolved
            ? 'ask_user'
            : blueprint.action;
      if (effectiveBlueprintAction !== blueprint.action) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: systemErrorMessage(
            effectiveBlueprintAction === 'revise_plan'
              ? t('flow.convergenceBlockedBackToPlanning')
              : t('flow.convergenceDecisionUnresolved'),
          ),
          timestamp: Date.now() / 1000,
        });
        logFlowEvent({
          type: 'action',
          actor: 'program',
          phase: 'convergence',
          note: `blueprint-gate:${blueprint.action}->${effectiveBlueprintAction}`,
          payload: {
            mustFixCount: mustFix.length,
            requiredDecisionsResolved,
          },
        });
      }

      if (effectiveBlueprintAction === 'revise_plan') {
        // Only transition phase here; do not auto-run a new planning round.
        switchPhase('planning');
        return;
      }
      if (effectiveBlueprintAction === 'ask_user') {
        setConvergenceMode('chat');
        return;
      }
      switchPhase('convergence');
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(error instanceof Error ? error.message : t('flow.execFailed')),
        timestamp: Date.now() / 1000,
      });
    } finally {
      setExecuting(false);
      await refreshTeamMembers();
    }
  };

  const handleStartConvergenceReview = async (reason: 'start' | 'rerun') => {
    if (!team || phase !== 'convergence' || executing) {
      return;
    }
    if (pendingConvergenceDecisions.length > 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.convergenceDecisionUnresolved')),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    const latestUserMessage = [...messages].reverse().find((item) => item.role === 'user')?.content ?? '';
    const triggerMessage = latestUserMessage || (reason === 'start' ? '[START_CONVERGENCE_REVIEW]' : '[RERUN_CONVERGENCE_REVIEW]');
    logFlowEvent({
      type: 'action',
      actor: 'program',
      phase: 'convergence',
      note: reason === 'start' ? 'start-review' : 'rerun-review',
    });
    await convergenceRound(triggerMessage);
  };

  const handleConfirmExecutionPhase = () => {
    if (!team) {
      return;
    }
    if (openBlockerIssues.length > 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.convergenceBlockedBackToPlanning')),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    if (openRequiredDecisionIssues.length > 0) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.convergenceDecisionUnresolved')),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    if (convergenceMode === 'review_run' || convergenceMode === 'decision_resolution') {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.convergenceModeBusy')),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    switchPhase('execution');
  };

  const discussionRound = async (message: string) => {
    if (!team) {
      return;
    }

    let roundMessage = message;
    for (let round = 1; round <= discussionMaxRounds; round += 1) {
      logFlowEvent({
        type: 'action',
        actor: 'program',
        phase: 'discussion',
        agentId: team.controllerId,
        note: `discussion-loop-round:${round}`,
      });

      const runtimeMessage = wrapMessageWithTeamContext(
        roundMessage,
        buildTeamContextEnvelope({
          team,
          phase: 'discussion',
          context: teamContexts[team.id],
          reports,
          agents,
        })
      );
      const controllerResult = await runControllerDecisionRound({
        runtimeMessage,
      });
      const controllerReply = controllerResult.decision?.reply ?? controllerResult.text;
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        agentId: team.controllerId,
        content: controllerReply || t('flow.emptyReply'),
        timestamp: Date.now() / 1000,
      });

      if (!controllerResult.decision) {
        controllerDriftRoundsRef.current += 1;
        if (controllerDriftRoundsRef.current >= CONTROLLER_DRIFT_MAX_ROUNDS) {
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: systemErrorMessage(t('flow.controllerDecisionFailed')),
            timestamp: Date.now() / 1000,
          });
        }
        return;
      }

      const normalizedDecision = normalizeDiscussionDecision(controllerResult.decision);
      if (normalizedDecision.action !== controllerResult.decision.action) {
        logFlowEvent({
          type: 'controller-decision',
          actor: 'program',
          phase: 'discussion',
          agentId: team.controllerId,
          note: `normalized:${controllerResult.decision.action}->${normalizedDecision.action}`,
        });
      }

      controllerDriftRoundsRef.current = 0;
      if (normalizedDecision.action === 'ready_for_planning') {
        if (!switchPhase('planning')) {
          return;
        }
        await planningRound(message);
        return;
      }
      if (normalizedDecision.action === 'ready_for_convergence') {
        const latestPlan = useTeamsStore.getState().teamPlans[team.id];
        const latestTasks = useTeamsStore.getState().teamTasksById[team.id] ?? [];
        if (latestPlan && latestTasks.length > 0) {
          if (!switchPhase('convergence')) {
            return;
          }
          setConvergenceMode('chat');
          appendTeamMessage(team.id, {
            id: crypto.randomUUID(),
            role: 'system',
            content: t('flow.convergenceReady'),
            timestamp: Date.now() / 1000,
          });
          return;
        }
        if (!switchPhase('planning')) {
          return;
        }
        await planningRound(message);
        return;
      }
      if (normalizedDecision.action === 'ask_user') {
        switchPhase('discussion');
        return;
      }

      if (round < discussionMaxRounds) {
        roundMessage = buildDiscussionLoopContinuationMessage({
          originalMessage: message,
          round: round + 1,
          previousReply: controllerReply || '',
        });
      }
    }

    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'system',
      content: systemErrorMessage(t('flow.discussionRoundLimitReached', { count: discussionMaxRounds })),
      timestamp: Date.now() / 1000,
    });
    switchPhase('discussion');
  };

  const handleSend = async (text: string) => {
    if (!team || !teamId) {
      return;
    }
    if (bindingState.status !== 'ready') {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.membersNotReady')),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    if (pendingBootstrap) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.pendingBootstrapBlocked')),
        timestamp: Date.now() / 1000,
      });
      return;
    }
    const message = text.trim();
    if (!message) {
      return;
    }

    appendTeamMessage(team.id, {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now() / 1000,
    });

    if (phase === 'execution') {
      await executeRound(message);
      return;
    }

    if (phase === 'planning') {
      await planningRound(message);
      return;
    }
    if (phase === 'convergence') {
      const normalizedMessage = message.trim();
      if (normalizedMessage === '开始会审') {
        await handleStartConvergenceReview('start');
        return;
      }
      if (normalizedMessage === '重新会审') {
        await handleStartConvergenceReview('rerun');
        return;
      }

      const directMemberCommand = parseDirectMemberReplyCommand(message);
      if (pendingConvergenceDecisions.length > 0) {
        appendTeamMessage(team.id, {
          id: crypto.randomUUID(),
          role: 'system',
          content: t('flow.convergencePendingDecisionChatOnly'),
          timestamp: Date.now() / 1000,
        });
      }
      if (directMemberCommand) {
        await memberChatInConvergence({
          target: directMemberCommand.target,
          prompt: directMemberCommand.prompt,
        });
      } else {
        await controllerChatInConvergence(message);
      }
      return;
    }
    if (phase === 'team-setup') {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(t('flow.pendingBootstrapBlocked')),
        timestamp: Date.now() / 1000,
      });
      return;
    }

    setExecuting(true);
    try {
      await discussionRound(message);
    } catch (error) {
      appendTeamMessage(team.id, {
        id: crypto.randomUUID(),
        role: 'system',
        content: systemErrorMessage(error instanceof Error ? error.message : t('flow.execFailed')),
        timestamp: Date.now() / 1000,
      });
    } finally {
      setExecuting(false);
      await refreshTeamMembers();
    }
  };

  return (
    <>
      <div className={cn(
      'grid h-[calc(100vh-150px)] min-h-[520px] max-h-[calc(100vh-120px)] gap-4 overflow-hidden',
      panelCollapsed ? 'lg:grid-cols-[1fr_48px]' : 'lg:grid-cols-[1fr_320px]'
    )}>
      <div className="flex min-h-0 flex-col gap-4">
        <div className="rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {t('flow.phaseLabel')}: {t(`phase.${phase}`)}
              {teamPlan?.objective ? ` | ${teamPlan.objective}` : ''}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={executing}
                onClick={() => {
                  void handleExitTeamChat();
                }}
              >
                <LogOut className="mr-1 h-4 w-4" />
                {t('flow.exitTeamChat')}
              </Button>
              {team && phase === 'discussion' && (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">{t('flow.maxRoundsLabel')}</span>
                  <Select
                    value={String(discussionMaxRounds)}
                    onChange={(event) => handleChangeDiscussionMaxRounds(Number(event.target.value))}
                    className="h-8 w-[78px] text-xs"
                    disabled={executing || bootstrapping}
                  >
                    {CONTROLLER_DISCUSSION_MAX_ROUNDS_OPTIONS.map((value) => (
                      <option key={value} value={value}>
                        {t('flow.maxRoundsOption', { count: value })}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {team && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={executing || teamFlowEvents.length === 0}
                  onClick={() => {
                    void handleExportFlowAudit();
                  }}
                >
                  {t('flow.exportFlowAudit')}
                </Button>
              )}
              {phase === 'discussion' && team && (
                <Button size="sm" variant="outline" onClick={() => switchPhase('planning')}>
                  {t('flow.toPlanning')}
                </Button>
              )}
              {phase === 'planning' && team && (
                <Button size="sm" variant="outline" onClick={() => switchPhase('discussion')}>
                  {t('flow.keepDiscussion')}
                </Button>
              )}
              {phase === 'convergence' && team && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      executing
                      || bootstrapping
                      || convergenceMode === 'review_run'
                      || !teamPlan
                      || teamTasks.length === 0
                      || pendingConvergenceDecisions.length > 0
                    }
                    onClick={() => {
                      void handleStartConvergenceReview('start');
                    }}
                  >
                    {t('flow.startConvergenceReview')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      executing
                      || bootstrapping
                      || convergenceMode === 'review_run'
                      || !teamPlan
                      || teamTasks.length === 0
                      || pendingConvergenceDecisions.length > 0
                    }
                    onClick={() => {
                      void handleStartConvergenceReview('rerun');
                    }}
                  >
                    {t('flow.rerunConvergenceReview')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canConfirmExecution}
                    onClick={handleConfirmExecutionPhase}
                  >
                    {t('flow.confirmExecution')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => switchPhase('discussion')}>
                    {t('flow.keepDiscussion')}
                  </Button>
                </>
              )}
              {(phase === 'execution' || phase === 'done') && team && (
                <Button size="sm" variant="outline" onClick={() => switchPhase('discussion')}>
                  {t('flow.backToDiscussion')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div
          ref={messagesContainerRef}
          className="flex-1 min-h-0 space-y-2 overflow-y-auto rounded-lg border border-dashed border-muted-foreground/40 bg-muted/10 p-4"
        >
          {bindingState.status !== 'ready' && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                {t('flow.membersNotReady')}
              </div>
              <div className="text-xs text-amber-800 dark:text-amber-300">
                {bindingState.status === 'missing-agents'
                  ? t('flow.missingMembers', { ids: bindingState.missingAgentIds.join(', ') })
                  : bindingState.error || t('flow.memberChecking')}
              </div>
            </div>
          )}
          {messages.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('chat.placeholder')}</div>
          ) : (
            messages.map((message) => {
              const isUser = message.role === 'user';
              const isAssistant = message.role === 'assistant';
              const agent = isAssistant
                ? agents.find((item) => item.id === message.agentId)
                : undefined;
              const agentAvatar = message.agentId
                ? getAgentDisplayEmoji(agent, message.agentId)
                : '\uD83E\uDD16';

              return (
                <div
                  key={message.id}
                  className={cn('flex items-start gap-2', isUser ? 'justify-end' : 'justify-start')}
                >
                  {!isUser && (
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-muted text-sm">
                      {isAssistant ? agentAvatar : '\u2699\uFE0F'}
                    </div>
                  )}

                  <div
                    className={cn(
                      'max-w-[90%] rounded-2xl border px-3 py-2',
                      isUser
                        ? 'bg-primary text-primary-foreground border-primary/80 shadow-sm'
                        : 'bg-muted/70 border-border/60 text-foreground',
                    )}
                  >
                    <div className={cn(
                      'mb-1 flex items-center gap-2 text-[11px]',
                      isUser ? 'text-primary-foreground/80' : 'text-muted-foreground'
                    )}>
                      <span>
                        {isUser
                          ? t('message.user')
                          : isAssistant
                            ? (agent?.name || message.agentId || t('message.assistant'))
                            : t('message.system')}
                      </span>
                      {message.kind !== 'normal' && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">
                          {message.kind === 'plan' ? t('message.plan') : t('message.report')}
                        </Badge>
                      )}
                    </div>
                    <div className={cn('whitespace-pre-wrap text-sm', isUser ? 'text-primary-foreground' : 'text-foreground')}>
                      {message.content}
                    </div>
                  </div>

                  {isUser && (
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-primary text-primary-foreground">
                      <User className="h-4 w-4" />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <ChatInput
          onSend={(text) => {
            void handleSend(text);
          }}
          onStop={() => undefined}
          sending={executing || bootstrapping}
          disabled={Boolean(pendingBootstrap) || bootstrapping}
          mentionCandidates={teamMentionCandidates}
        />
      </div>

      <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between">
          {!panelCollapsed && (
            <>
              <div className="text-sm font-medium">{t('panel.title')}</div>
              <div className="text-[11px] text-muted-foreground">
                {t('panel.reports', { count: reportCount })} | {t('panel.tasks', { count: teamTasks.length })}
              </div>
            </>
          )}
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7"
            title={panelCollapsed ? t('panel.expand') : t('panel.collapse')}
            aria-label={panelCollapsed ? t('panel.expand') : t('panel.collapse')}
            onClick={() => setPanelCollapsed((prev) => !prev)}
          >
            {panelCollapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
        {!panelCollapsed && (
          <>
            {team && (
              <div className="mb-2 flex items-center gap-2">
                <Select
                  value={addingAgentId}
                  onChange={(event) => setAddingAgentId(event.target.value)}
                  className="h-8 text-xs"
                >
                  <option value="">{t('panel.addPlaceholder')}</option>
                  {availableAgentsToAdd.length > 0 ? (
                    <optgroup label={t('panel.addAvailableGroup')}>
                      {availableAgentsToAdd.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {`${getAgentDisplayEmoji(agent, agent.id)} ${agent.name ?? agent.id}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    <option disabled value="__none__">{t('panel.addUnavailable')}</option>
                  )}
                  {existingTeamAgents.length > 0 && (
                    <optgroup label={t('panel.addExistingGroup')}>
                      {existingTeamAgents.map((agent) => (
                        <option key={`existing-${agent.id}`} disabled value={`existing:${agent.id}`}>
                          {`${getAgentDisplayEmoji(agent, agent.id)} ${agent.name ?? agent.id}`}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-2 text-xs"
                  onClick={handleAddMember}
                  disabled={!addingAgentId || !availableAgentsToAdd.some((agent) => agent.id === addingAgentId)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t('panel.add')}
                </Button>
              </div>
            )}
            {!team || team.memberIds.length === 0 ? (
              <div className="text-xs text-muted-foreground">{t('panel.empty')}</div>
            ) : (
              <div className="h-[calc(100%-36px)] space-y-3 overflow-y-auto pr-1">
                <div className="space-y-2">
                  {team.memberIds.map((agentId) => {
                  const agent = agents.find((item) => item.id === agentId);
                  const latestOutput = outputByAgent[agentId] ?? '';
                  const isRefreshing = Boolean(refreshingByAgent[agentId]);
                  const isRemoving = Boolean(removingByAgent[agentId]);
                  const runtime = memberRuntimeMap[agentId];
                  const agentTasks = teamTasks.filter((task) => task.agentId === agentId);
                  const doneTasks = agentTasks.filter((task) => task.status === 'done').length;
                  const runtimeStatus = runtime?.status ?? 'idle';
                  const runtimeClass = runtimeStatus === 'done'
                    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                    : runtimeStatus === 'running'
                      ? 'bg-blue-100 text-blue-700 border-blue-300'
                      : runtimeStatus === 'blocked' || runtimeStatus === 'missing-report'
                        ? 'bg-amber-100 text-amber-700 border-amber-300'
                        : runtimeStatus === 'error'
                          ? 'bg-rose-100 text-rose-700 border-rose-300'
                          : 'bg-muted text-muted-foreground border-border';
                  const isExpanded = expandedAgentId === agentId;
                  const latestAudit = [...teamAudit].reverse().find((row) => row.agentId === agentId);
                  return (
                    <div key={agentId} className="rounded-md border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-xs font-medium">
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[12px]">
                            {getAgentDisplayEmoji(agent, agentId)}
                          </span>
                          <span>{agent?.name ?? agentId}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            disabled={isRefreshing || isRemoving}
                            onClick={() => {
                              void refreshAgent(agentId);
                            }}
                          >
                            {isRefreshing ? t('panel.refreshing') : t('panel.refresh')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => setExpandedAgentId((prev) => (prev === agentId ? null : agentId))}
                          >
                            {isExpanded ? t('panel.detailLess') : t('panel.detailMore')}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            title={t('panel.remove')}
                            aria-label={t('panel.remove')}
                            disabled={!team || team.memberIds.length <= 1 || isRemoving}
                            onClick={() => {
                              void handleRemoveMember(agentId);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px]">
                        <span className={cn('rounded-full border px-2 py-0.5', runtimeClass)}>
                          {t(`panel.status.${runtimeStatus}`)}
                        </span>
                        <span className="text-muted-foreground">
                          {t('panel.taskProgress', { done: doneTasks, total: agentTasks.length })}
                        </span>
                      </div>
                      {runtime?.lastDurationMs != null && runtime.lastDurationMs > 0 && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {t('panel.lastDuration', { ms: runtime.lastDurationMs })}
                        </div>
                      )}
                      <div className="mt-2 line-clamp-4 text-xs text-muted-foreground">
                        {latestOutput || t('panel.noOutput')}
                      </div>
                      {isExpanded && (
                        <div className="mt-2 space-y-1 rounded-md border border-dashed p-2 text-[11px]">
                          <div className="font-medium text-foreground">{t('panel.detailTitle')}</div>
                          <div className="text-muted-foreground">
                            {t('panel.currentTask')}: {runtime?.currentTaskId ?? '-'}
                          </div>
                          <div className="text-muted-foreground">
                            {t('panel.lastTask')}: {runtime?.lastTaskId ?? '-'}
                          </div>
                          <div className="text-muted-foreground">
                            {t('panel.lastRun')}: {runtime?.lastRunId ?? latestAudit?.runId ?? '-'}
                          </div>
                          <div className="text-muted-foreground">
                            {t('panel.lastReport')}: {runtime?.lastReportId ?? latestAudit?.reportId ?? '-'}
                          </div>
                          <div className="text-muted-foreground">
                            {t('panel.lastError')}: {runtime?.lastError ?? '-'}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                  })}
                </div>
                <div className="rounded-md border p-2">
                  <div className="mb-1 text-xs font-medium">
                    {t('panel.flowTitle')} ({teamFlowEvents.length})
                  </div>
                  <div className="space-y-1 text-[11px] text-muted-foreground">
                    {teamFlowEvents.length === 0 ? (
                      <div>{t('panel.flowEmpty')}</div>
                    ) : (
                      [...teamFlowEvents].slice(-8).reverse().map((event) => (
                        <div key={event.id} className="rounded border border-dashed px-2 py-1">
                          <div>{event.type} 路 {event.phase}</div>
                          <div>{event.note ?? '-'}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {phase === 'convergence' && (
                  <div className="rounded-md border p-2">
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <div className="font-medium">{t('panel.convergence.title')}</div>
                      <div className="text-muted-foreground">
                        {t('panel.convergence.modeLabel')}: {t(`panel.convergence.mode.${convergenceMode}`)}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded border border-rose-200 bg-rose-50/70 p-2">
                        <div className="mb-1 text-[11px] font-medium text-rose-700">
                          {t('panel.convergence.blockers', { count: blockerIssues.length })}
                        </div>
                        <div className="space-y-1 text-[11px] text-rose-900">
                          {blockerIssues.length === 0
                            ? <div>{t('panel.convergence.none')}</div>
                            : blockerIssues.map((item) => (
                              <div key={item.id} className="rounded border border-rose-200 px-1.5 py-1">
                                <div>{item.content}</div>
                                <div className="mt-0.5 text-[10px] text-rose-700">
                                  {t(`panel.convergence.state.${item.state}`)} · {t('panel.convergence.issueRound')}: {item.sourceRound}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                      <div className="rounded border border-amber-200 bg-amber-50/70 p-2">
                        <div className="mb-1 text-[11px] font-medium text-amber-700">
                          {t('panel.convergence.decisions', { count: requiredDecisionIssues.length })}
                        </div>
                        <div className="space-y-1 text-[11px] text-amber-900">
                          {requiredDecisionIssues.length === 0
                            ? <div>{t('panel.convergence.none')}</div>
                            : requiredDecisionIssues.map((item) => (
                              <div key={item.id} className="rounded border border-amber-200 px-1.5 py-1">
                                <div>{item.content}</div>
                                <div className="mt-0.5 text-[10px] text-amber-700">
                                  {t(`panel.convergence.state.${item.state}`)}
                                  {item.decisionKey ? ` · key=${item.decisionKey}` : ''}
                                  {item.owner ? ` · ${t('panel.convergence.issueOwner')}: ${item.owner}` : ''}
                                </div>
                                <div className="mt-0.5 text-[10px] text-amber-700">
                                  {t('panel.convergence.defaultValue')}: {item.defaultValue || item.options?.[0] || 'accept-default'}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                      <div className="rounded border border-sky-200 bg-sky-50/70 p-2">
                        <div className="mb-1 text-[11px] font-medium text-sky-700">
                          {t('panel.convergence.suggestions', { count: suggestionIssues.length })}
                        </div>
                        <div className="space-y-1 text-[11px] text-sky-900">
                          {suggestionIssues.length === 0
                            ? <div>{t('panel.convergence.none')}</div>
                            : suggestionIssues.map((item) => (
                              <div key={item.id} className="rounded border border-sky-200 px-1.5 py-1">
                                <div>{item.content}</div>
                                <div className="mt-0.5 text-[10px] text-sky-700">
                                  {t(`panel.convergence.state.${item.state}`)}
                                  {item.owner ? ` · ${t('panel.convergence.issueOwner')}: ${item.owner}` : ''}
                                  {` · ${t('panel.convergence.issueRound')}: ${item.sourceRound}`}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    </div>
                    {pendingConvergenceDecisions.length > 0 && (
                      <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2">
                        <div className="text-[11px] text-amber-800">
                          {t('panel.convergence.pendingHint')}
                        </div>
                        <div className="mt-2 space-y-2">
                          {pendingConvergenceDecisions.map((item) => (
                            <div key={item.key} className="rounded border border-amber-200 bg-background p-2">
                              <div className="mb-1 text-[11px] font-medium text-foreground">{item.question}</div>
                              {(item.options?.length ?? 0) > 0 ? (
                                <Select
                                  value={decisionDraftValues[item.key] ?? ''}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setDecisionDraftValues((prev) => ({ ...prev, [item.key]: value }));
                                  }}
                                  className="h-8 text-xs"
                                  disabled={executing}
                                >
                                  <option value="">{t('panel.convergence.selectDecision')}</option>
                                  {item.options.map((option) => (
                                    <option key={`${item.key}:${option}`} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                </Select>
                              ) : (
                                <input
                                  type="text"
                                  value={decisionDraftValues[item.key] ?? ''}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setDecisionDraftValues((prev) => ({ ...prev, [item.key]: value }));
                                  }}
                                  className="h-8 w-full rounded border bg-background px-2 text-xs"
                                  disabled={executing}
                                  placeholder={t('panel.convergence.inputDecision')}
                                />
                              )}
                              <div className="mt-1 text-[10px] text-amber-700">
                                {t('panel.convergence.defaultValue')}: {item.defaultValue || item.options?.[0] || 'accept-default'}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={executing}
                            onClick={() => {
                              setDecisionDraftValues({});
                            }}
                            className="mr-2"
                          >
                            {t('panel.convergence.resetDecisions')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={executing}
                            onClick={() => {
                              void applyFilledConvergenceDecisions();
                            }}
                            className="mr-2"
                          >
                            {t('panel.convergence.applyFilled')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={executing}
                            onClick={() => {
                              void applyDefaultConvergenceDecisions();
                            }}
                          >
                            {t('panel.convergence.applyDefaults')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {panelCollapsed && (
          <div className="mt-3 flex flex-1 flex-col items-center gap-2 overflow-y-auto">
            {(team?.memberIds ?? []).map((agentId) => {
              const agent = agents.find((item) => item.id === agentId);
              return (
                <div
                  key={agentId}
                  className="flex h-8 w-8 items-center justify-center rounded-full border bg-muted text-base"
                  title={agent?.name ?? agentId}
                >
                  {getAgentDisplayEmoji(agent, agentId)}
                </div>
              );
            })}
          </div>
        )}
      </aside>
      </div>
      {pendingBootstrap && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <section className="w-full max-w-2xl rounded-lg border bg-background p-4 shadow-lg">
            <header className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">{t('flow.bootstrapDialogTitle')}</h3>
              <span className="text-xs text-muted-foreground">
                {t('flow.bootstrapDialogCount', { count: pendingBootstrap.requests.length })}
              </span>
            </header>
            <div className="space-y-2 rounded-md border p-3">
              {pendingBootstrap.requests.map((request) => (
                <div key={`${request.role}:${request.suggestedName}`} className="rounded border p-2">
                  <div className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span>{request.role} {'->'} {request.suggestedName}</span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px]',
                        bootstrapStatusClass(
                          bootstrapProgress[bootstrapRequestKey(request)] ?? 'pending',
                        ),
                      )}
                    >
                      {bootstrapStatusLabel(bootstrapProgress[bootstrapRequestKey(request)] ?? 'pending')}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{request.summary}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    taskIds: {request.taskIds.join(', ')}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={bootstrapping}
                onClick={handleCancelPendingBootstrap}
              >
                {t('flow.bootstrapCancel')}
              </Button>
              <Button
                disabled={bootstrapping}
                onClick={() => {
                  void handleConfirmPendingBootstrap();
                }}
              >
                {bootstrapping ? t('flow.bootstrapApplying') : t('flow.bootstrapConfirm')}
              </Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function TeamChatPage() {
  const { teamId } = useParams();
  return <TeamChat teamId={teamId} />;
}

export default TeamChatPage;

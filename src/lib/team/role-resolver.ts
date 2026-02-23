import { normalizeSubagentNameToSlug } from '@/lib/subagent/workspace';
import {
  isRoleMetadataWeak,
  mergeRolesFromAgents,
  readRolesMetadata,
  resolveRolesMetadataRoot,
  selectRolesByGoalWithLlm,
} from '@/lib/team/roles-metadata';
import type { SubagentSummary } from '@/types/subagent';
import type { Team, TeamPlan } from '@/types/team';

export interface PendingAgentCreation {
  role: string;
  summary: string;
  suggestedName: string;
  taskIds: string[];
}

interface ResolvePlanAssignmentsInput {
  team: Team;
  plan: TeamPlan;
  agents: SubagentSummary[];
  getAgents: () => SubagentSummary[];
  createAgent: (input: {
    name: string;
    workspace: string;
    model?: string;
    emoji?: string;
  }) => Promise<void>;
  loadAgents: () => Promise<void>;
  defaultModel?: string;
  allowCreate?: boolean;
}

interface ResolvePlanAssignmentsOutput {
  resolvedAgentByTaskId: Record<string, string>;
  addedAgentIds: string[];
  pendingAgentCreations: PendingAgentCreation[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function findAgentById(agents: SubagentSummary[], agentId: string): SubagentSummary | undefined {
  return agents.find((agent) => agent.id === agentId);
}

function findExactRoleMatchFromMetadata(input: {
  role: string;
  metadata: Array<{
    agentId: string;
    name: string;
    role: string;
    tags: string[];
  }>;
}): string | null {
  const roleText = normalize(input.role);
  if (!roleText) {
    return null;
  }
  for (const entry of input.metadata) {
    const keys = [entry.agentId, entry.name, entry.role, ...entry.tags].map((value) => normalize(value));
    if (keys.includes(roleText)) {
      return entry.agentId;
    }
  }
  return null;
}

function buildUniqueAgentName(
  role: string,
  agents: SubagentSummary[],
  reservedSlugs: Set<string>,
): string {
  const base = role.trim() || 'team-role-agent';
  const taken = new Set([
    ...agents.map((agent) => normalizeSubagentNameToSlug(agent.name ?? agent.id)),
    ...reservedSlugs,
  ]);
  let attempt = 0;
  while (attempt < 100) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = `${base}${suffix}`;
    const slug = normalizeSubagentNameToSlug(candidate);
    if (!taken.has(slug)) {
      reservedSlugs.add(slug);
      return candidate;
    }
    attempt += 1;
  }
  const fallback = `${base}-${Date.now()}`;
  reservedSlugs.add(normalizeSubagentNameToSlug(fallback));
  return fallback;
}

function pickMissingRoleSummary(
  missingRoles: { role: string; summary: string }[],
  roleHint: string,
): string {
  const normalizedHint = normalize(roleHint);
  if (!normalizedHint) {
    return 'Role is missing. Please create this specialist and define responsibilities.';
  }
  const exact = missingRoles.find((item) => normalize(item.role) === normalizedHint);
  if (exact?.summary) {
    return exact.summary;
  }
  const fuzzy = missingRoles.find((item) => {
    const role = normalize(item.role);
    return role.includes(normalizedHint) || normalizedHint.includes(role);
  });
  if (fuzzy?.summary) {
    return fuzzy.summary;
  }
  return `${roleHint} role is missing. Please create and define clear responsibilities.`;
}

export async function resolvePlanAssignmentsForTeam(
  input: ResolvePlanAssignmentsInput,
): Promise<ResolvePlanAssignmentsOutput> {
  const allowCreate = input.allowCreate ?? true;
  let agents = [...input.agents];
  const resolvedAgentByTaskId: Record<string, string> = {};
  const addedAgentIds: string[] = [];
  const pendingByRole = new Map<string, PendingAgentCreation>();
  const createdByRole = new Map<string, string>();
  const reservedSlugs = new Set<string>();
  const defaultModel = input.defaultModel || agents[0]?.model || '';

  const metadataRoot = resolveRolesMetadataRoot(agents);
  const currentMetadata = await readRolesMetadata(metadataRoot).catch(() => []);
  let metadata = mergeRolesFromAgents(currentMetadata, agents);
  const strongMetadata = () => metadata.filter((entry) => !isRoleMetadataWeak(entry));
  const isEligibleAgent = (agentId: string): boolean => {
    const entry = metadata.find((item) => item.agentId === agentId);
    if (!entry) {
      return false;
    }
    return !isRoleMetadataWeak(entry);
  };

  for (const task of input.plan.tasks) {
    const roleHint = task.role || task.agentId || '';
    const roleHintKey = normalize(roleHint);

    if (roleHintKey) {
      const createdAgentId = createdByRole.get(roleHintKey);
      if (createdAgentId && findAgentById(agents, createdAgentId)) {
        resolvedAgentByTaskId[task.taskId] = createdAgentId;
        continue;
      }
    }

    if (task.agentId) {
      const existing = findAgentById(agents, task.agentId);
      if (existing && isEligibleAgent(existing.id)) {
        resolvedAgentByTaskId[task.taskId] = existing.id;
        continue;
      }
    }

    if (!roleHint) {
      continue;
    }

    const exactRoleMatchId = findExactRoleMatchFromMetadata({
      role: roleHint,
      metadata: strongMetadata(),
    });
    if (exactRoleMatchId && findAgentById(agents, exactRoleMatchId)) {
      resolvedAgentByTaskId[task.taskId] = exactRoleMatchId;
      continue;
    }

    const candidates = strongMetadata();
    const llmResult = candidates.length > 0
      ? await selectRolesByGoalWithLlm({
        goal: `${input.plan.objective}\nTask: ${task.instruction}\nRole: ${roleHint}`,
        entries: candidates,
      })
      : { selectedAgentIds: [], missingRoles: [] };
    const llmMatch = llmResult.selectedAgentIds.find((agentId) => findAgentById(agents, agentId));
    if (llmMatch) {
      resolvedAgentByTaskId[task.taskId] = llmMatch;
      continue;
    }

    if (!allowCreate) {
      const role = llmResult.missingRoles[0]?.role || roleHint;
      const roleKey = normalize(role);
      const existing = pendingByRole.get(roleKey);
      if (existing) {
        if (!existing.taskIds.includes(task.taskId)) {
          existing.taskIds.push(task.taskId);
        }
        continue;
      }
      const suggestedName = buildUniqueAgentName(role, agents, reservedSlugs);
      pendingByRole.set(roleKey, {
        role,
        summary: pickMissingRoleSummary(llmResult.missingRoles, role),
        suggestedName,
        taskIds: [task.taskId],
      });
      continue;
    }

    const newName = buildUniqueAgentName(roleHint, agents, reservedSlugs);
    await input.createAgent({
      name: newName,
      workspace: '',
      model: defaultModel,
      emoji: '\uD83E\uDD16',
    });
    await input.loadAgents();
    agents = input.getAgents();

    const createdId = normalizeSubagentNameToSlug(newName);
    const createdAgent = findAgentById(agents, createdId);
    if (!createdAgent) {
      continue;
    }

    addedAgentIds.push(createdAgent.id);
    resolvedAgentByTaskId[task.taskId] = createdAgent.id;
    if (roleHintKey) {
      createdByRole.set(roleHintKey, createdAgent.id);
    }

    metadata = mergeRolesFromAgents(metadata, agents);
  }

  return {
    resolvedAgentByTaskId,
    addedAgentIds,
    pendingAgentCreations: Array.from(pendingByRole.values()),
  };
}

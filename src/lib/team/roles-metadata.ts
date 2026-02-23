import { resolveSubagentWorkspaceRoot } from '@/lib/subagent/workspace';
import { extractChatSendOutput } from '@/lib/subagent/prompt';
import { sendChatMessage } from '@/lib/openclaw/session-runtime';
import type { SubagentSummary } from '@/types/subagent';

type RpcResult<T> = { success: boolean; result?: T; error?: string };

export interface RoleMetadataEntry {
  agentId: string;
  name: string;
  role: string;
  summary: string;
  tags: string[];
  model?: string;
  emoji?: string;
  updatedAt: string;
}

export interface MissingRoleSpec {
  role: string;
  summary: string;
}

export interface RoleSelectionResult {
  selectedAgentIds: string[];
  missingRoles: MissingRoleSpec[];
  rawOutput?: string;
}

interface RawRoleSelection {
  selectedAgentIds?: unknown;
  missingRoles?: unknown;
}

async function ipcInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.electron.ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

async function rpc<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke('gateway:rpc', method, params, timeoutMs) as RpcResult<T>;
  if (!response.success) {
    throw new Error(response.error || `RPC failed: ${method}`);
  }
  return response.result as T;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .filter((item) => item.length > 0);
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
}

function normalizeRoleEntry(entry: RoleMetadataEntry): RoleMetadataEntry {
  return {
    ...entry,
    tags: normalizeTags(entry.tags),
    model: normalizeString(entry.model) || undefined,
    emoji: normalizeString(entry.emoji) || undefined,
    updatedAt: normalizeString(entry.updatedAt),
  };
}

function hasCoreRoleDiff(a: RoleMetadataEntry, b: RoleMetadataEntry): boolean {
  if (a.agentId !== b.agentId) return true;
  if (a.name !== b.name) return true;
  if (a.role !== b.role) return true;
  if (a.summary !== b.summary) return true;
  if (a.model !== b.model) return true;
  if (a.emoji !== b.emoji) return true;
  if (a.tags.length !== b.tags.length) return true;
  return a.tags.some((tag, index) => tag !== b.tags[index]);
}

function areRoleEntriesEquivalent(current: RoleMetadataEntry[], next: RoleMetadataEntry[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  const currentById = new Map(
    current
      .map((entry) => normalizeRoleEntry(entry))
      .map((entry) => [entry.agentId, entry] as const),
  );
  for (const rawEntry of next) {
    const entry = normalizeRoleEntry(rawEntry);
    const existing = currentById.get(entry.agentId);
    if (!existing) {
      return false;
    }
    if (hasCoreRoleDiff(existing, entry)) {
      return false;
    }
  }
  return true;
}

function extractFirstJsonObject(text: string): string | null {
  const source = text.trim();
  const start = source.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseJsonBlockFromMarkdown(content: string): string | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return extractFirstJsonObject(content);
}

export function buildRolesMetadataMarkdown(entries: RoleMetadataEntry[]): string {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    roles: entries,
  };
  return [
    '# ROLES_METADATA',
    '',
    'Desktop multi-agent role metadata (not used by OpenClaw runtime).',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n');
}

export function parseRolesMetadata(content: string): RoleMetadataEntry[] {
  const jsonBlock = parseJsonBlockFromMarkdown(content);
  if (!jsonBlock) {
    return [];
  }
  try {
    const parsed = JSON.parse(jsonBlock) as { roles?: unknown };
    if (!Array.isArray(parsed?.roles)) {
      return [];
    }
    const rows: RoleMetadataEntry[] = [];
    for (const row of parsed.roles) {
      if (!row || typeof row !== 'object') {
        continue;
      }
      const data = row as Record<string, unknown>;
      const agentId = normalizeString(data.agentId);
      const name = normalizeString(data.name) || agentId;
      const role = normalizeString(data.role) || name;
      if (!agentId) {
        continue;
      }
      rows.push({
        agentId,
        name,
        role,
        summary: normalizeString(data.summary),
        tags: normalizeStringArray(data.tags),
        model: normalizeString(data.model) || undefined,
        emoji: normalizeString(data.emoji) || undefined,
        updatedAt: normalizeString(data.updatedAt) || new Date().toISOString(),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export function resolveRolesMetadataRoot(agents: SubagentSummary[]): string {
  return resolveSubagentWorkspaceRoot(agents);
}

export async function readRolesMetadata(rootDir: string): Promise<RoleMetadataEntry[]> {
  const response = await ipcInvoke<{ path: string; content: string }>('roles:readMetadata', rootDir);
  return parseRolesMetadata(response.content);
}

export async function writeRolesMetadata(rootDir: string, entries: RoleMetadataEntry[]): Promise<void> {
  const current = await readRolesMetadata(rootDir).catch(() => []);
  if (areRoleEntriesEquivalent(current, entries)) {
    return;
  }
  const content = buildRolesMetadataMarkdown(entries);
  await ipcInvoke('roles:writeMetadata', { rootDir, content });
}

function defaultRoleSummary(agent: SubagentSummary): string {
  const name = agent.name ?? agent.id;
  return `${name} handles tasks in its specialty and reports outcomes.`;
}

export function isRoleMetadataWeak(entry: Pick<RoleMetadataEntry, 'agentId' | 'name' | 'summary' | 'tags'>): boolean {
  const summary = normalizeString(entry.summary);
  const tags = normalizeTags(entry.tags ?? []);
  if (tags.length > 0) {
    return false;
  }
  if (!summary) {
    return true;
  }
  const byName = `${normalizeString(entry.name) || normalizeString(entry.agentId)} handles tasks in its specialty and reports outcomes.`;
  const byId = `${normalizeString(entry.agentId)} handles tasks in its specialty and reports outcomes.`;
  return summary === byName || summary === byId;
}

export function mergeRolesFromAgents(
  current: RoleMetadataEntry[],
  agents: SubagentSummary[],
): RoleMetadataEntry[] {
  const byAgentId = new Map(current.map((item) => [item.agentId, item]));
  const nowIso = new Date().toISOString();
  const next = agents.map((agent) => {
    const agentId = agent.id;
    const prev = byAgentId.get(agentId);
    const normalizedTags = normalizeTags(prev?.tags ?? []);
    const merged = {
      agentId,
      name: agent.name ?? agent.id,
      role: prev?.role || agent.name || agent.id,
      summary: prev?.summary || defaultRoleSummary(agent),
      tags: normalizedTags,
      model: agent.model ?? prev?.model,
      emoji: agent.identityEmoji ?? prev?.emoji,
      updatedAt: nowIso,
    } satisfies RoleMetadataEntry;
    if (!prev) {
      return merged;
    }
    const prevNormalized = normalizeRoleEntry(prev);
    const mergedNormalized = normalizeRoleEntry(merged);
    const changed = hasCoreRoleDiff(prevNormalized, mergedNormalized);
    return {
      ...merged,
      updatedAt: changed ? nowIso : (prevNormalized.updatedAt || nowIso),
    } satisfies RoleMetadataEntry;
  });
  return next;
}

function fallbackSelectRoles(goal: string, entries: RoleMetadataEntry[]): RoleSelectionResult {
  void goal;
  void entries;
  return {
    selectedAgentIds: [],
    missingRoles: [],
  };
}

function normalizeRoleSelection(parsed: RawRoleSelection, entries: RoleMetadataEntry[]): RoleSelectionResult {
  const knownAgentIds = new Set(entries.map((entry) => entry.agentId));
  const selectedAgentIds = normalizeStringArray(parsed.selectedAgentIds)
    .filter((agentId) => knownAgentIds.has(agentId));
  const missingRoles = Array.isArray(parsed.missingRoles)
    ? parsed.missingRoles
      .map((row) => {
        if (!row || typeof row !== 'object') {
          return null;
        }
        const data = row as Record<string, unknown>;
        const role = normalizeString(data.role);
        if (!role) {
          return null;
        }
        return {
          role,
          summary: normalizeString(data.summary) || `${role} 角色缺失，请创建。`,
        } satisfies MissingRoleSpec;
      })
      .filter((item): item is MissingRoleSpec => Boolean(item))
    : [];
  return {
    selectedAgentIds,
    missingRoles,
  };
}

export async function selectRolesByGoalWithLlm(input: {
  goal: string;
  entries: RoleMetadataEntry[];
}): Promise<RoleSelectionResult> {
  if (input.entries.length === 0) {
    return { selectedAgentIds: [], missingRoles: [] };
  }

  const list = input.entries.map((entry) => ({
    agentId: entry.agentId,
    name: entry.name,
    role: entry.role,
    tags: entry.tags,
    summary: entry.summary,
  }));

  const prompt = [
    '你是团队组建助手。根据目标在候选角色中选择最合适成员。',
    '只返回 JSON，不要 Markdown。',
    '格式：{"selectedAgentIds":["..."],"missingRoles":[{"role":"...","summary":"..."}]}',
    `目标：${input.goal}`,
    `候选角色：${JSON.stringify(list)}`,
    '如果候选里没有合适角色，请在 missingRoles 中补充。',
  ].join('\n');

  try {
    const result = await sendChatMessage<Record<string, unknown>>(rpc, {
      sessionKey: 'roles:matcher',
      message: prompt,
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
    }, 45000);
    const output = extractChatSendOutput(result);
    const jsonText = extractFirstJsonObject(output);
    if (!jsonText) {
      return { ...fallbackSelectRoles(input.goal, input.entries), rawOutput: output };
    }
    const parsed = JSON.parse(jsonText) as RawRoleSelection;
    return { ...normalizeRoleSelection(parsed, input.entries), rawOutput: output };
  } catch {
    return fallbackSelectRoles(input.goal, input.entries);
  }
}

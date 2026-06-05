import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHomePath(value: string): string {
  if (value.startsWith('~')) {
    return value.replace('~', homedir());
  }
  return value;
}

function normalizeWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolvePath(expandHomePath(trimmed));
}

function resolveFallbackMainWorkspace(openclawConfigDir: string): string {
  return resolvePath(join(openclawConfigDir, 'workspace'));
}

function parseSessionAgentId(sessionKey: string): string {
  const parts = sessionKey.trim().split(':');
  return parts[0] === 'agent' && parts[1]?.trim() ? parts[1].trim() : '';
}

function normalizeSubagentNameToSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || /^\d+$/.test(slug)) {
    return 'agent';
  }
  return slug;
}

function resolveConfiguredAgentWorkspace(config: unknown, agentId: string): string | null {
  const root = isRecord(config) ? config : {};
  const agents = isRecord(root.agents) ? root.agents : {};
  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id !== agentId) {
      continue;
    }
    const workspace = normalizeWorkspacePath(item.workspace);
    if (workspace) {
      return workspace;
    }
  }
  return null;
}

export function resolveMainWorkspaceDir(config: unknown, openclawConfigDir: string): string {
  const root = isRecord(config) ? config : {};
  const agents = isRecord(root.agents) ? root.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};

  const defaultsWorkspace = normalizeWorkspacePath(defaults.workspace);
  if (defaultsWorkspace) {
    return defaultsWorkspace;
  }

  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const isDefault = item.isDefault === true;
    if (id !== 'main' && !isDefault) {
      continue;
    }
    const workspace = normalizeWorkspacePath(item.workspace);
    if (workspace) {
      return workspace;
    }
  }

  return resolveFallbackMainWorkspace(openclawConfigDir);
}

export function resolveWorkspaceDirForSession(config: unknown, openclawConfigDir: string, sessionKey: string): string {
  const agentId = parseSessionAgentId(sessionKey);
  if (!agentId || agentId === 'main') {
    return resolveMainWorkspaceDir(config, openclawConfigDir);
  }
  return resolveConfiguredAgentWorkspace(config, agentId)
    ?? resolvePath(join(openclawConfigDir, 'workspace-subagents', normalizeSubagentNameToSlug(agentId)));
}

export function resolveTaskWorkspaceDirs(config: unknown, openclawConfigDir: string): string[] {
  const root = isRecord(config) ? config : {};
  const agents = isRecord(root.agents) ? root.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const list = Array.isArray(agents.list) ? agents.list : [];

  const dirs = new Set<string>();
  dirs.add(resolveMainWorkspaceDir(config, openclawConfigDir));

  const defaultsWorkspace = normalizeWorkspacePath(defaults.workspace);
  if (defaultsWorkspace) {
    dirs.add(defaultsWorkspace);
  }

  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const workspace = normalizeWorkspacePath(item.workspace);
    if (workspace) {
      dirs.add(workspace);
    }
  }

  return Array.from(dirs);
}

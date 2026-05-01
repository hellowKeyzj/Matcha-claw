import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { getOpenClawConfigDir, getOpenClawDir, getResourcesDir } from '../../utils/paths';
import { logger } from '../../utils/logger';

const MAIN_AGENT_TEMPLATE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const;

const UPSTREAM_TEMPLATE_SNAPSHOT_DIRNAME = 'templates-upstream-openclaw';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTemplateText(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}

async function tryReadTextFile(pathname: string): Promise<string | null> {
  try {
    return await readFile(pathname, 'utf8');
  } catch {
    return null;
  }
}

function normalizeWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolvePath(trimmed.startsWith('~') ? trimmed.replace('~', homedir()) : trimmed);
}

function readOpenClawConfigJsonLocal(): Record<string, unknown> {
  const configPath = join(getOpenClawConfigDir(), 'openclaw.json');
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resolveMainWorkspaceDirLocal(config: unknown, openclawConfigDir: string): string {
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

  return resolvePath(join(openclawConfigDir, 'workspace'));
}

function resolveManagedTemplateDir(): string {
  const packagedResourcesDir = getResourcesDir();
  const candidates = [
    join(packagedResourcesDir, 'agent-workspace-templates', 'main-agent'),
    join(process.cwd(), 'resources', 'agent-workspace-templates', 'main-agent'),
    join(getOpenClawDir(), 'docs', 'reference', 'templates'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'AGENTS.md'))) ?? candidates[0];
}

function resolveUpstreamTemplateSnapshotDir(): string {
  const candidates = [
    join(getOpenClawDir(), 'docs', 'reference', UPSTREAM_TEMPLATE_SNAPSHOT_DIRNAME),
    join(getOpenClawDir(), 'docs', 'reference', 'templates'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'AGENTS.md'))) ?? candidates[0];
}

export function shouldReplaceWorkspaceTemplateWithManagedVersion(current: string, upstream: string): boolean {
  return normalizeTemplateText(current) === normalizeTemplateText(upstream);
}

export async function migrateMainAgentWorkspaceTemplatesIfNeeded(): Promise<{
  workspaceDir: string;
  migratedFiles: string[];
}> {
  const openclawConfigDir = getOpenClawConfigDir();
  const workspaceDir = resolveMainWorkspaceDirLocal(readOpenClawConfigJsonLocal(), openclawConfigDir);
  const managedTemplateDir = resolveManagedTemplateDir();
  const upstreamTemplateDir = resolveUpstreamTemplateSnapshotDir();

  if (!existsSync(workspaceDir)) {
    return { workspaceDir, migratedFiles: [] };
  }
  if (!existsSync(join(managedTemplateDir, 'AGENTS.md'))) {
    logger.warn(`[workspace] Managed main-agent templates not found: ${managedTemplateDir}`);
    return { workspaceDir, migratedFiles: [] };
  }
  if (!existsSync(join(upstreamTemplateDir, 'AGENTS.md'))) {
    logger.warn(`[workspace] Upstream template snapshot not found: ${upstreamTemplateDir}`);
    return { workspaceDir, migratedFiles: [] };
  }

  const migratedFiles: string[] = [];
  await mkdir(workspaceDir, { recursive: true });

  for (const fileName of MAIN_AGENT_TEMPLATE_FILES) {
    const workspacePath = join(workspaceDir, fileName);
    const currentContent = await tryReadTextFile(workspacePath);
    if (currentContent === null) {
      continue;
    }

    const [managedContent, upstreamContent] = await Promise.all([
      tryReadTextFile(join(managedTemplateDir, fileName)),
      tryReadTextFile(join(upstreamTemplateDir, fileName)),
    ]);
    if (managedContent === null || upstreamContent === null) {
      continue;
    }

    if (!shouldReplaceWorkspaceTemplateWithManagedVersion(currentContent, upstreamContent)) {
      continue;
    }

    await writeFile(workspacePath, managedContent, 'utf8');
    migratedFiles.push(fileName);
  }

  if (migratedFiles.length > 0) {
    logger.info(
      `[workspace] Migrated main-agent templates in ${workspaceDir}: ${migratedFiles.join(', ')}`,
    );
  }

  return { workspaceDir, migratedFiles };
}

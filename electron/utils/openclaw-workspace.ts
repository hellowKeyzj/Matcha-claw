/**
 * OpenClaw workspace context utilities.
 *
 * All file I/O is async (fs/promises) to avoid blocking the Electron
 * main thread.
 */
import { access, readFile, writeFile, readdir, mkdir, unlink } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger';
import { getResourcesDir } from './paths';

const MATCHACLAW_BEGIN = '<!-- matchaclaw:begin -->';
const MATCHACLAW_END = '<!-- matchaclaw:end -->';

// ── Helpers ──────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function ensureDir(dir: string): Promise<void> {
  if (!(await fileExists(dir))) {
    await mkdir(dir, { recursive: true });
  }
}

// ── Pure helpers (no I/O) ────────────────────────────────────────

/**
 * Merge a MatchaClaw context section into an existing file's content.
 * If markers already exist, replaces the section in-place.
 * Otherwise appends it at the end.
 */
export function mergeMatchaClawSection(existing: string, section: string): string {
  const wrapped = `${MATCHACLAW_BEGIN}\n${section.trim()}\n${MATCHACLAW_END}`;
  const beginIdx = existing.indexOf(MATCHACLAW_BEGIN);
  const endIdx = existing.indexOf(MATCHACLAW_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    return existing.slice(0, beginIdx) + wrapped + existing.slice(endIdx + MATCHACLAW_END.length);
  }
  return existing.trimEnd() + '\n\n' + wrapped + '\n';
}

// ── Workspace directory resolution ───────────────────────────────

/**
 * Collect all unique workspace directories from the openclaw config:
 * the defaults workspace and each agent's workspace.
 *
 * We intentionally do not glob all `workspace-*` directories because some
 * auxiliary workspaces (for example `workspace-subagents`) are not seeded
 * with OpenClaw bootstrap files (AGENTS.md/TOOLS.md), which would cause
 * noisy retries and misleading warnings.
 */
async function resolveAllWorkspaceDirs(): Promise<string[]> {
  const openclawDir = join(homedir(), '.openclaw');
  const dirs = new Set<string>();

  const configPath = join(openclawDir, 'openclaw.json');
  try {
    if (await fileExists(configPath)) {
      const config = JSON.parse(await readFile(configPath, 'utf-8'));

      const defaultWs = config?.agents?.defaults?.workspace;
      if (typeof defaultWs === 'string' && defaultWs.trim()) {
        dirs.add(defaultWs.replace(/^~/, homedir()));
      }

      const agents = config?.agents?.list;
      if (Array.isArray(agents)) {
        for (const agent of agents) {
          const ws = agent?.workspace;
          if (typeof ws === 'string' && ws.trim()) {
            dirs.add(ws.replace(/^~/, homedir()));
          }
        }
      }
    }
  } catch {
    // ignore config parse errors
  }

  if (dirs.size === 0) {
    dirs.add(join(openclawDir, 'workspace'));
  }

  return [...dirs];
}

// ── Bootstrap file repair ────────────────────────────────────────

/**
 * Detect and remove bootstrap .md files that contain only MatchaClaw markers
 * with no meaningful OpenClaw content outside them.
 */
export async function repairMatchaClawOnlyBootstrapFiles(): Promise<void> {
  const workspaceDirs = await resolveAllWorkspaceDirs();
  for (const workspaceDir of workspaceDirs) {
    if (!(await fileExists(workspaceDir))) continue;

    let entries: string[];
    try {
      entries = (await readdir(workspaceDir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of entries) {
      const filePath = join(workspaceDir, file);
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }
      const beginIdx = content.indexOf(MATCHACLAW_BEGIN);
      const endIdx = content.indexOf(MATCHACLAW_END);
      if (beginIdx === -1 || endIdx === -1) continue;

      const before = content.slice(0, beginIdx).trim();
      const after = content.slice(endIdx + MATCHACLAW_END.length).trim();
      if (before === '' && after === '') {
        try {
          await unlink(filePath);
          logger.info(`Removed MatchaClaw-only bootstrap file for re-seeding: ${file} (${workspaceDir})`);
        } catch {
          logger.warn(`Failed to remove MatchaClaw-only bootstrap file: ${filePath}`);
        }
      }
    }
  }
}

// ── Context merging ──────────────────────────────────────────────

/**
 * Merge MatchaClaw context snippets into workspace bootstrap files that
 * already exist on disk.  Returns the number of target files that were
 * skipped because they don't exist yet.
 */
async function mergeMatchaClawContextOnce(): Promise<number> {
  const contextDir = join(getResourcesDir(), 'context');
  if (!(await fileExists(contextDir))) {
    logger.debug('MatchaClaw context directory not found, skipping context merge');
    return 0;
  }

  let files: string[];
  try {
    files = (await readdir(contextDir)).filter((f) => f.endsWith('.matchaclaw.md'));
  } catch {
    return 0;
  }

  const workspaceDirs = await resolveAllWorkspaceDirs();
  let skipped = 0;

  for (const workspaceDir of workspaceDirs) {
    await ensureDir(workspaceDir);

    for (const file of files) {
      const targetName = file.replace('.matchaclaw.md', '.md');
      const targetPath = join(workspaceDir, targetName);

      if (!(await fileExists(targetPath))) {
        logger.debug(`Skipping ${targetName} in ${workspaceDir} (file does not exist yet, will be seeded by gateway)`);
        skipped++;
        continue;
      }

      const section = await readFile(join(contextDir, file), 'utf-8');
      const existing = await readFile(targetPath, 'utf-8');

      const merged = mergeMatchaClawSection(existing, section);
      if (merged !== existing) {
        await writeFile(targetPath, merged, 'utf-8');
        logger.info(`Merged MatchaClaw context into ${targetName} (${workspaceDir})`);
      }
    }
  }

  return skipped;
}

const RETRY_INTERVAL_MS = 2000;
const MAX_RETRIES = 15;

/**
 * Ensure MatchaClaw context snippets are merged into the openclaw workspace
 * bootstrap files.
 */
export async function ensureMatchaClawContext(): Promise<void> {
  let skipped = await mergeMatchaClawContextOnce();
  if (skipped === 0) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    skipped = await mergeMatchaClawContextOnce();
    if (skipped === 0) {
      logger.info(`MatchaClaw context merge completed after ${attempt} retry(ies)`);
      return;
    }
    logger.debug(`MatchaClaw context merge: ${skipped} file(s) still missing (retry ${attempt}/${MAX_RETRIES})`);
  }

  logger.warn(`MatchaClaw context merge: ${skipped} file(s) still missing after ${MAX_RETRIES} retries`);
}

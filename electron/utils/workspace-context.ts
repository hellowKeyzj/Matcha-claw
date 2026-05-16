/**
 * Workspace context merge — injects MatchaClaw-managed context snippets
 * into OpenClaw workspace bootstrap files using marker-delimited sections.
 *
 * Runs in the Electron main process where getResourcesDir() is reliable.
 */
import { access, readFile, writeFile, readdir } from 'fs/promises';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from './logger';
import { getResourcesDir } from './paths';

const SNIPPET_SUFFIX = '.matchaclaw.md';
const MARKER_BEGIN = '<!-- matchaclaw:begin -->';
const MARKER_END = '<!-- matchaclaw:end -->';

// ── Helpers ──────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Merge a MatchaClaw context section into existing file content.
 * If markers already exist, replaces the section in-place.
 * Otherwise appends at the end.
 */
export function mergeContextSection(existing: string, section: string): string {
  const wrapped = `${MARKER_BEGIN}\n${section.trim()}\n${MARKER_END}`;
  const beginIdx = existing.indexOf(MARKER_BEGIN);
  const endIdx = existing.indexOf(MARKER_END);
  if (beginIdx !== -1 && endIdx !== -1) {
    return existing.slice(0, beginIdx) + wrapped + existing.slice(endIdx + MARKER_END.length);
  }
  return existing.trimEnd() + '\n\n' + wrapped + '\n';
}

/**
 * Strip the "## First Run" section seeded by the OpenClaw Gateway.
 */
export function stripFirstRunSection(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let skipping = false;
  let consumedFirstParagraph = false;
  let seenBlankAfterParagraph = false;

  for (const line of lines) {
    const isHeading = /^#{1,6}\s/.test(line);
    const trimmed = line.trim();

    if (trimmed === '## First Run') {
      skipping = true;
      consumedFirstParagraph = false;
      seenBlankAfterParagraph = false;
      continue;
    }

    if (skipping) {
      if (isHeading) {
        skipping = false;
      } else if (!consumedFirstParagraph) {
        if (trimmed.length === 0) continue;
        consumedFirstParagraph = true;
        continue;
      } else if (!seenBlankAfterParagraph) {
        if (trimmed.length === 0) {
          seenBlankAfterParagraph = true;
          continue;
        }
        continue;
      } else {
        if (trimmed.length === 0) continue;
        skipping = false;
      }
    }

    if (!skipping) {
      result.push(line);
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── Workspace directory resolution ───────────────────────────────

async function resolveAllWorkspaceDirs(): Promise<string[]> {
  const openclawDir = join(homedir(), '.openclaw');
  const dirs = new Set<string>();

  const configPath = join(openclawDir, 'openclaw.json');
  try {
    if (await fileExists(configPath)) {
      const config = JSON.parse(await readFile(configPath, 'utf-8'));
      const agents = config?.agents;
      const defaults = agents?.defaults;

      if (typeof defaults?.workspace === 'string' && defaults.workspace.trim()) {
        dirs.add(defaults.workspace.replace(/^~/, homedir()));
      }

      const list = Array.isArray(agents?.list) ? agents.list : [];
      for (const agent of list) {
        const ws = agent?.workspace;
        if (typeof ws === 'string' && ws.trim()) {
          dirs.add(ws.replace(/^~/, homedir()));
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

// ── Context merging ──────────────────────────────────────────────

async function mergeContextOnce(): Promise<{ missing: number }> {
  const contextDir = join(getResourcesDir(), 'context');
  if (!(await fileExists(contextDir))) {
    logger.debug('[context-merge] Context directory not found, skipping');
    return { missing: 0 };
  }

  let files: string[];
  try {
    files = (await readdir(contextDir)).filter((f) => f.endsWith(SNIPPET_SUFFIX));
  } catch {
    return { missing: 0 };
  }

  if (files.length === 0) {
    return { missing: 0 };
  }

  const workspaceDirs = await resolveAllWorkspaceDirs();
  let missing = 0;

  for (const workspaceDir of workspaceDirs) {
    if (!(await fileExists(workspaceDir))) {
      missing += files.length;
      continue;
    }

    for (const file of files) {
      const targetName = file.replace(SNIPPET_SUFFIX, '.md');
      const targetPath = join(workspaceDir, targetName);

      if (!(await fileExists(targetPath))) {
        missing++;
        continue;
      }

      const section = await readFile(join(contextDir, file), 'utf-8');
      const originalContent = await readFile(targetPath, 'utf-8');
      let content = originalContent;

      if (targetName === 'AGENTS.md') {
        const stripped = stripFirstRunSection(content);
        if (stripped !== content) {
          content = stripped;
          logger.info(`[context-merge] Stripped First Run section from ${targetName} (${workspaceDir})`);
        }
      }

      const merged = mergeContextSection(content, section);
      if (merged !== originalContent) {
        await writeFile(targetPath, merged, 'utf-8');
        logger.info(`[context-merge] Merged context into ${targetName} (${workspaceDir})`);
      }
    }
  }

  return { missing };
}

// ── Public API ───────────────────────────────────────────────────

const RETRY_INTERVAL_MS = 2000;
const MAX_RETRIES = 5;
let mergePromise: Promise<void> | null = null;

/**
 * Ensure MatchaClaw context snippets are merged into all openclaw workspace
 * bootstrap files. Retries if target files are not yet seeded by Gateway.
 */
export async function ensureWorkspaceContext(): Promise<void> {
  if (mergePromise) {
    return mergePromise;
  }
  mergePromise = runEnsureWorkspaceContext().finally(() => {
    mergePromise = null;
  });
  return mergePromise;
}

async function runEnsureWorkspaceContext(): Promise<void> {
  let result = await mergeContextOnce();
  if (result.missing === 0) {
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    result = await mergeContextOnce();
    if (result.missing === 0) {
      logger.info(`[context-merge] Completed after ${attempt} retry(ies)`);
      return;
    }
    logger.debug(`[context-merge] ${result.missing} file(s) still missing (retry ${attempt}/${MAX_RETRIES})`);
  }

  if (result.missing > 0) {
    logger.warn(`[context-merge] ${result.missing} file(s) still missing after ${MAX_RETRIES} retries`);
  }
}

/**
 * Workspace context merge — injects MatchaClaw-managed context snippets
 * into OpenClaw workspace bootstrap files using marker-delimited sections.
 *
 * Each `.matchaclaw.md` file in the context directory maps to a workspace
 * file of the same base name (e.g. `AGENTS.matchaclaw.md` → `AGENTS.md`).
 * The injected section is wrapped in HTML comment markers so it can be
 * updated in-place on subsequent runs without disturbing user content.
 */
import { join } from 'node:path';
import type { RuntimeFileSystemPort, RuntimeDirectoryEntry } from '../../../common/runtime-ports';
import type { RuntimeHostLogger } from '../../../../shared/logger';

const CONTEXT_SNIPPET_SUFFIX = '.matchaclaw.md';
const MARKER_BEGIN = '<!-- matchaclaw:begin -->';
const MARKER_END = '<!-- matchaclaw:end -->';

// ── Pure helpers ─────────────────────────────────────────────────

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

// ── Service ──────────────────────────────────────────────────────

export interface ContextMergeResult {
  mergedFiles: string[];
  skippedMissing: number;
}

/**
 * Merge all context snippets from `contextDir` into `workspaceDir`.
 */
export async function mergeWorkspaceContext(
  fileSystem: RuntimeFileSystemPort,
  logger: RuntimeHostLogger,
  contextDir: string,
  workspaceDir: string,
): Promise<ContextMergeResult> {
  const result: ContextMergeResult = { mergedFiles: [], skippedMissing: 0 };

  if (!(await fileSystem.exists(workspaceDir))) {
    return result;
  }

  let entries: RuntimeDirectoryEntry[];
  try {
    entries = await fileSystem.listDirectory(contextDir);
  } catch {
    return result;
  }

  const snippetFiles = entries
    .filter((e) => e.isFile && e.name.endsWith(CONTEXT_SNIPPET_SUFFIX))
    .map((e) => e.name);

  for (const snippetFile of snippetFiles) {
    const targetName = snippetFile.replace(CONTEXT_SNIPPET_SUFFIX, '.md');
    const targetPath = join(workspaceDir, targetName);

    if (!(await fileSystem.exists(targetPath))) {
      result.skippedMissing++;
      continue;
    }

    const section = await fileSystem.readTextFile(join(contextDir, snippetFile));
    const originalContent = await fileSystem.readTextFile(targetPath);
    let content = originalContent;

    if (targetName === 'AGENTS.md') {
      const stripped = stripFirstRunSection(content);
      if (stripped !== content) {
        content = stripped;
        logger.info(`[context-merge] Stripped First Run section from ${targetName}`);
      }
    }

    const merged = mergeContextSection(content, section);
    if (merged !== originalContent) {
      await fileSystem.writeTextFile(targetPath, merged);
      result.mergedFiles.push(targetName);
      logger.info(`[context-merge] Merged context into ${targetName} (${workspaceDir})`);
    }
  }

  return result;
}

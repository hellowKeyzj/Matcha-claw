import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { copyDirectorySafe } from '../../utils/copy-safe';
import { logger } from '../../utils/logger';
import { getOpenClawSkillsDir } from '../../utils/paths';

const SKILL_MANIFEST_FILE = 'SKILL.md';
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

type SkillSourceKind = 'directory' | 'zip' | 'markdown';

export interface LocalSkillImportResult {
  skillKey: string;
  installedPath: string;
  sourceKind: SkillSourceKind;
}

function getWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function normalizeSkillKey(input: string): string {
  const normalized = input
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return normalized || `skill-${Date.now()}`;
}

function parseFrontmatterField(frontmatter: string, field: 'name' | 'description'): string | null {
  const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'im');
  const match = frontmatter.match(pattern);
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^["']|["']$/g, '') || null;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function extractZipArchive(zipPath: string, destinationDir: string): Promise<void> {
  if (process.platform === 'win32') {
    await runCommand(getWindowsPowerShellPath(), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }

  if (process.platform === 'darwin') {
    try {
      await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, destinationDir]);
      return;
    } catch (error) {
      logger.warn('Failed to extract skill zip with ditto, falling back to unzip:', error);
    }
  }

  try {
    await runCommand('unzip', ['-qq', '-o', zipPath, '-d', destinationDir]);
  } catch (error) {
    logger.warn('Failed to extract skill zip with unzip, falling back to python zipfile:', error);
    await runCommand(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipfile', '-e', zipPath, destinationDir]);
  }
}

async function collectSkillManifestDirs(rootDir: string): Promise<string[]> {
  const manifestDirs: string[] = [];

  async function visit(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === SKILL_MANIFEST_FILE)) {
      manifestDirs.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(join(currentDir, entry.name));
    }
  }

  await visit(rootDir);
  return manifestDirs;
}

async function resolveSkillDirectory(rootDir: string): Promise<string> {
  const manifestDirs = await collectSkillManifestDirs(rootDir);
  if (manifestDirs.length === 0) {
    throw new Error('未找到 SKILL.md，无法识别为技能目录。');
  }
  if (manifestDirs.length > 1) {
    throw new Error('检测到多个 SKILL.md，请一次只导入一个技能。');
  }
  return manifestDirs[0];
}

async function createMarkdownSkillDirectory(sourcePath: string, stagingRoot: string): Promise<string> {
  const markdown = await readFile(sourcePath, 'utf8');
  const frontmatterMatch = markdown.match(FRONTMATTER_PATTERN);
  if (!frontmatterMatch) {
    throw new Error('Markdown 技能缺少 YAML frontmatter。');
  }

  const frontmatter = frontmatterMatch[1];
  const name = parseFrontmatterField(frontmatter, 'name');
  const description = parseFrontmatterField(frontmatter, 'description');
  if (!name || !description) {
    throw new Error('Markdown 技能必须在 YAML frontmatter 中提供 name 和 description。');
  }

  const fileBaseName = basename(sourcePath, extname(sourcePath));
  const suggestedName = fileBaseName.toLowerCase() === 'skill'
    ? basename(dirname(sourcePath))
    : fileBaseName;
  const skillKey = normalizeSkillKey(suggestedName || name);
  const skillDir = join(stagingRoot, skillKey);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, SKILL_MANIFEST_FILE), markdown, 'utf8');
  return skillDir;
}

async function prepareSourceDirectory(
  sourcePath: string,
  stagingRoot: string,
): Promise<{ skillDir: string; sourceKind: SkillSourceKind }> {
  const info = await stat(sourcePath);
  if (info.isDirectory()) {
    return {
      skillDir: await resolveSkillDirectory(sourcePath),
      sourceKind: 'directory',
    };
  }

  if (!info.isFile()) {
    throw new Error('只支持导入技能文件夹、.zip 压缩包或 .md 技能文件。');
  }

  const extension = extname(sourcePath).toLowerCase();
  if (extension === '.zip') {
    const extractRoot = join(stagingRoot, 'zip');
    await mkdir(extractRoot, { recursive: true });
    await extractZipArchive(sourcePath, extractRoot);
    return {
      skillDir: await resolveSkillDirectory(extractRoot),
      sourceKind: 'zip',
    };
  }

  if (extension === '.md') {
    return {
      skillDir: await createMarkdownSkillDirectory(sourcePath, stagingRoot),
      sourceKind: 'markdown',
    };
  }

  throw new Error('只支持导入技能文件夹、.zip 压缩包或 .md 技能文件。');
}

export async function importLocalSkillSource(sourcePath: string): Promise<LocalSkillImportResult> {
  const normalizedSourcePath = sourcePath.trim();
  if (!normalizedSourcePath) {
    throw new Error('缺少技能来源路径。');
  }
  if (!existsSync(normalizedSourcePath)) {
    throw new Error('选择的技能来源不存在。');
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skill-import-'));
  try {
    const { skillDir, sourceKind } = await prepareSourceDirectory(normalizedSourcePath, stagingRoot);
    const skillKey = normalizeSkillKey(basename(skillDir));
    const skillsRoot = getOpenClawSkillsDir();
    const installedPath = join(skillsRoot, skillKey);

    await mkdir(skillsRoot, { recursive: true });
    if (existsSync(installedPath)) {
      throw new Error(`技能 "${skillKey}" 已存在，请先删除旧版本后再导入。`);
    }

    await copyDirectorySafe(skillDir, installedPath);
    logger.info(`Imported local skill "${skillKey}" from ${normalizedSourcePath} -> ${installedPath}`);

    return {
      skillKey,
      installedPath,
      sourceKind,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

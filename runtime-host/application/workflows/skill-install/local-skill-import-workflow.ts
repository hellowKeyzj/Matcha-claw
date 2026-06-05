import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeFileSystemPort,
  RuntimeSystemEnvironmentPort,
} from '../../common/runtime-ports';
import type { RuntimeHostLogger } from '../../../shared/logger';

const SKILL_MANIFEST_FILE = 'SKILL.md';
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const CONTROL_CHAR_RANGE_PATTERN = `${String.fromCharCode(0)}-${String.fromCharCode(31)}`;
const INVALID_SKILL_KEY_CHARS_PATTERN = new RegExp(`[<>:"/\\\\|?*${CONTROL_CHAR_RANGE_PATTERN}]+`, 'g');

type SkillSourceKind = 'directory' | 'zip' | 'markdown';

export interface LocalSkillImportResult {
  success: true;
  skillKey: string;
  installedPath: string;
  sourceKind: SkillSourceKind;
}

export interface LocalSkillImportWorkflowDeps {
  readonly fileSystem: RuntimeFileSystemPort;
  readonly commandExecutor: RuntimeCommandExecutorPort;
  readonly systemEnvironment: RuntimeSystemEnvironmentPort;
  readonly clock: RuntimeClockPort;
  readonly skillsRoot: () => string;
  readonly logger: RuntimeHostLogger;
}

export class LocalSkillImportWorkflow {
  constructor(private readonly deps: LocalSkillImportWorkflowDeps) {}

  async execute(input: { readonly sourcePath: string }): Promise<LocalSkillImportResult> {
    if (!(await this.deps.fileSystem.exists(input.sourcePath))) {
      throw new Error('选择的技能来源不存在。');
    }

    const stagingRoot = join(
      this.deps.systemEnvironment.tempDir,
      `matchaclaw-skill-import-${this.deps.clock.nowMs()}-${Math.random().toString(36).slice(2)}`,
    );
    await this.deps.fileSystem.ensureDirectory(stagingRoot);
    try {
      const { skillDir, sourceKind } = await this.prepareImportSource(input.sourcePath, stagingRoot);
      const skillKey = this.normalizeSkillKey(basename(skillDir));
      const skillsRoot = this.deps.skillsRoot();
      const installedPath = join(skillsRoot, skillKey);
      await this.deps.fileSystem.ensureDirectory(skillsRoot);
      if (await this.deps.fileSystem.exists(installedPath)) {
        throw new Error(`技能 "${skillKey}" 已存在，请先删除旧版本后再导入。`);
      }
      await this.copyDirectory(skillDir, installedPath);
      this.deps.logger.info(`Imported local skill "${skillKey}" from ${input.sourcePath} -> ${installedPath}`);
      return {
        success: true,
        skillKey,
        installedPath,
        sourceKind,
      };
    } finally {
      await this.deps.fileSystem.removeDirectory(stagingRoot);
    }
  }

  private normalizeSkillKey(input: string): string {
    const normalized = input
      .trim()
      .replace(/\s+/g, '-')
      .replace(INVALID_SKILL_KEY_CHARS_PATTERN, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '');
    return normalized || `skill-${this.deps.clock.nowMs()}`;
  }

  private readRequiredSkillManifestFrontmatter(markdown: string): { name: string; description: string } {
    const frontmatterMatch = markdown.match(FRONTMATTER_PATTERN);
    if (!frontmatterMatch) {
      throw new Error('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
    }
    const frontmatter = frontmatterMatch[1];
    const name = this.parseFrontmatterField(frontmatter, 'name');
    const description = this.parseFrontmatterField(frontmatter, 'description');
    if (!name || !description) {
      throw new Error('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
    }
    return { name, description };
  }

  private parseFrontmatterField(frontmatter: string, field: 'name' | 'description'): string | null {
    const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'im');
    const match = frontmatter.match(pattern);
    if (!match) {
      return null;
    }
    return match[1].trim().replace(/^["']|["']$/g, '') || null;
  }

  private async validateSkillManifest(skillDir: string): Promise<void> {
    const manifestPath = join(skillDir, SKILL_MANIFEST_FILE);
    const markdown = await this.deps.fileSystem.readTextFile(manifestPath);
    this.readRequiredSkillManifestFrontmatter(markdown);
  }

  private async copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
    await this.deps.fileSystem.ensureDirectory(targetDir);
    const entries = await this.deps.fileSystem.listDirectory(sourceDir);
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        await this.copyDirectory(sourcePath, targetPath);
        continue;
      }
      if (entry.isFile) {
        await this.deps.fileSystem.ensureDirectory(dirname(targetPath));
        await this.deps.fileSystem.copyFile(sourcePath, targetPath);
      }
    }
  }

  private async collectSkillManifestDirs(rootDir: string): Promise<string[]> {
    const manifestDirs: string[] = [];
    const visit = async (currentDir: string): Promise<void> => {
      const entries = await this.deps.fileSystem.listDirectory(currentDir);
      if (entries.some((entry) => entry.isFile && entry.name === SKILL_MANIFEST_FILE)) {
        manifestDirs.push(currentDir);
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory) {
          await visit(join(currentDir, entry.name));
        }
      }
    };
    await visit(rootDir);
    return manifestDirs;
  }

  private async resolveSkillDirectory(rootDir: string): Promise<string> {
    const manifestDirs = await this.collectSkillManifestDirs(rootDir);
    if (manifestDirs.length === 0) {
      throw new Error('未找到 SKILL.md，无法识别为技能目录。');
    }
    if (manifestDirs.length > 1) {
      throw new Error('检测到多个 SKILL.md，请一次只导入一个技能。');
    }
    return manifestDirs[0];
  }

  private async extractZipArchive(zipPath: string, destinationDir: string): Promise<void> {
    if (this.deps.systemEnvironment.platform === 'win32') {
      const systemRoot = this.deps.systemEnvironment.getEnv('SystemRoot') || 'C:\\Windows';
      const powershellPath = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await this.deps.commandExecutor.execFile(powershellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`,
      ], { windowsHide: true });
      return;
    }

    if (this.deps.systemEnvironment.platform === 'darwin') {
      try {
        await this.deps.commandExecutor.execFile('/usr/bin/ditto', ['-x', '-k', zipPath, destinationDir]);
        return;
      } catch (error) {
        this.deps.logger.warn(`Failed to extract skill zip with ditto: ${String(error)}`);
      }
    }

    try {
      await this.deps.commandExecutor.execFile('unzip', ['-qq', '-o', zipPath, '-d', destinationDir]);
    } catch {
      await this.deps.commandExecutor.execFile(
        this.deps.systemEnvironment.platform === 'win32' ? 'python' : 'python3',
        ['-m', 'zipfile', '-e', zipPath, destinationDir],
      );
    }
  }

  private async createMarkdownSkillDirectory(sourcePath: string, stagingRoot: string): Promise<string> {
    const markdown = await this.deps.fileSystem.readTextFile(sourcePath);
    const { name } = this.readRequiredSkillManifestFrontmatter(markdown);
    const fileBaseName = basename(sourcePath, extname(sourcePath));
    const suggestedName = fileBaseName.toLowerCase() === 'skill'
      ? basename(dirname(sourcePath))
      : fileBaseName;
    const skillKey = this.normalizeSkillKey(suggestedName || name);
    const skillDir = join(stagingRoot, skillKey);
    await this.deps.fileSystem.ensureDirectory(skillDir);
    await this.deps.fileSystem.writeTextFile(join(skillDir, SKILL_MANIFEST_FILE), markdown);
    return skillDir;
  }

  private async prepareImportSource(
    sourcePath: string,
    stagingRoot: string,
  ): Promise<{ skillDir: string; sourceKind: SkillSourceKind }> {
    const info = await this.deps.fileSystem.stat(sourcePath);
    if (info.isDirectory) {
      const skillDir = await this.resolveSkillDirectory(sourcePath);
      await this.validateSkillManifest(skillDir);
      return {
        skillDir,
        sourceKind: 'directory',
      };
    }
    if (!info.isFile) {
      throw new Error('只支持导入技能文件夹、.zip 压缩包或 .md 技能文件。');
    }
    const extension = extname(sourcePath).toLowerCase();
    if (extension === '.zip') {
      const extractRoot = join(stagingRoot, 'zip');
      await this.deps.fileSystem.ensureDirectory(extractRoot);
      await this.extractZipArchive(sourcePath, extractRoot);
      const skillDir = await this.resolveSkillDirectory(extractRoot);
      await this.validateSkillManifest(skillDir);
      return {
        skillDir,
        sourceKind: 'zip',
      };
    }
    if (extension === '.md') {
      return {
        skillDir: await this.createMarkdownSkillDirectory(sourcePath, stagingRoot),
        sourceKind: 'markdown',
      };
    }
    throw new Error('只支持导入技能文件夹、.zip 压缩包或 .md 技能文件。');
  }
}

export function normalizeSkillKey(input: string, fallbackTimestamp: number): string {
  const normalized = input
    .trim()
    .replace(/\s+/g, '-')
    .replace(INVALID_SKILL_KEY_CHARS_PATTERN, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return normalized || `skill-${fallbackTimestamp}`;
}

export function normalizeBundleFilePath(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) {
    return null;
  }
  if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    return null;
  }
  const normalized = normalize(input.trim()).replace(/\\/g, '/');
  if (
    normalized === '.'
    || normalized.startsWith('../')
    || normalized === '..'
    || normalized.includes(`${sep}..${sep}`)
  ) {
    return null;
  }
  return normalized;
}

export async function collectTextFiles(deps: {
  readonly fileSystem: RuntimeFileSystemPort;
  readonly rootDir: string;
}): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  const visit = async (currentDir: string): Promise<void> => {
    const entries = await deps.fileSystem.listDirectory(currentDir);
    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }
      const filePath = relative(deps.rootDir, entryPath).replace(/\\/g, '/');
      files.push({
        path: filePath,
        content: await deps.fileSystem.readTextFile(entryPath),
      });
    }
  };
  await visit(deps.rootDir);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function validateSkillManifest(deps: {
  readonly fileSystem: RuntimeFileSystemPort;
  readonly skillDir: string;
}): Promise<void> {
  const markdown = await deps.fileSystem.readTextFile(join(deps.skillDir, SKILL_MANIFEST_FILE));
  const frontmatterMatch = markdown.match(FRONTMATTER_PATTERN);
  if (!frontmatterMatch) {
    throw new Error('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
  }
  const frontmatter = frontmatterMatch[1];
  const readField = (field: 'name' | 'description'): string | null => {
    const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'im');
    const match = frontmatter.match(pattern);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') || null : null;
  };
  if (!readField('name') || !readField('description')) {
    throw new Error('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
  }
}

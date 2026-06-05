import { dirname, join } from 'node:path';
import type { RuntimeClockPort, RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { SkillsJobPort } from '../../skills/skills-jobs';
import type { SkillsConfigRepository } from '../../skills/store';
import {
  collectTextFiles,
  normalizeBundleFilePath,
  normalizeSkillKey,
  validateSkillManifest,
} from './local-skill-import-workflow';

const SKILL_MANIFEST_FILE = 'SKILL.md';

export interface SkillBundleFile {
  path: string;
  content: string;
}

export interface SkillBundle {
  skillKey: string;
  files: SkillBundleFile[];
}

export interface SkillBundleImportResult {
  ok: true;
  installed: string[];
  skipped?: string[];
}

export interface SkillBundleTransferWorkflowDeps {
  readonly repository: Pick<SkillsConfigRepository, 'setEnabled'>;
  readonly jobs: Pick<SkillsJobPort, 'submitGatewayUpdate' | 'submitRefreshStatus'>;
  readonly clock: RuntimeClockPort;
  readonly fileSystem: RuntimeFileSystemPort;
  readonly skillsRoot: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class SkillBundleTransferWorkflow {
  constructor(private readonly deps: SkillBundleTransferWorkflowDeps) {}

  async exportBundles(payload: unknown): Promise<SkillBundle[]> {
    const body = isRecord(payload) ? payload : {};
    const requestedSkillKeys = Array.isArray(body.skillKeys)
      ? body.skillKeys.map(normalizeOptionalString).filter((value): value is string => Boolean(value))
      : [];
    const bundles: SkillBundle[] = [];
    const skillsRoot = this.deps.skillsRoot();
    for (const requestedSkillKey of Array.from(new Set(requestedSkillKeys))) {
      const skillKey = this.normalizeSkillKey(requestedSkillKey);
      const skillDir = join(skillsRoot, skillKey);
      if (!(await this.deps.fileSystem.exists(join(skillDir, SKILL_MANIFEST_FILE)))) {
        continue;
      }
      bundles.push({
        skillKey,
        files: await collectTextFiles({ fileSystem: this.deps.fileSystem, rootDir: skillDir }),
      });
    }
    return bundles;
  }

  async importBundles(payload: unknown): Promise<SkillBundleImportResult> {
    const body = isRecord(payload) ? payload : {};
    const bundles = this.normalizeSkillBundles(body.skillBundles);
    if (bundles.length === 0) {
      return { ok: true, installed: [] };
    }

    const skillsRoot = this.deps.skillsRoot();
    await this.deps.fileSystem.ensureDirectory(skillsRoot);
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const bundle of bundles) {
      await this.importBundle(skillsRoot, bundle, installed, skipped);
    }
    this.deps.jobs.submitRefreshStatus();
    return {
      ok: true,
      installed,
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }

  private normalizeSkillBundles(input: unknown): SkillBundle[] {
    if (!Array.isArray(input)) {
      return [];
    }
    const bundles: SkillBundle[] = [];
    for (const item of input) {
      if (!isRecord(item)) {
        continue;
      }
      const skillKey = normalizeOptionalString(item.skillKey);
      if (!skillKey || !Array.isArray(item.files)) {
        continue;
      }
      const files = item.files.flatMap((file): SkillBundleFile[] => {
        if (!isRecord(file) || typeof file.content !== 'string') {
          return [];
        }
        const filePath = normalizeBundleFilePath(file.path);
        return filePath ? [{ path: filePath, content: file.content }] : [];
      });
      if (files.length > 0) {
        bundles.push({ skillKey: this.normalizeSkillKey(skillKey), files });
      }
    }
    return bundles;
  }

  private async importBundle(
    skillsRoot: string,
    bundle: SkillBundle,
    installed: string[],
    skipped: string[],
  ): Promise<void> {
    if (!bundle.files.some((file) => file.path === SKILL_MANIFEST_FILE)) {
      throw new Error(`Skill "${bundle.skillKey}" is missing SKILL.md`);
    }
    const skillDir = join(skillsRoot, bundle.skillKey);
    if (await this.deps.fileSystem.exists(skillDir)) {
      if (!(await this.deps.fileSystem.exists(join(skillDir, SKILL_MANIFEST_FILE)))) {
        throw new Error(`技能 "${bundle.skillKey}" 已存在但缺少 SKILL.md，请先删除旧目录后再导入。`);
      }
      await this.enableImportedSkill(bundle.skillKey);
      skipped.push(bundle.skillKey);
      return;
    }
    for (const file of bundle.files) {
      const targetPath = join(skillDir, file.path);
      await this.deps.fileSystem.ensureDirectory(dirname(targetPath));
      await this.deps.fileSystem.writeTextFile(targetPath, file.content);
    }
    await validateSkillManifest({ fileSystem: this.deps.fileSystem, skillDir });
    await this.enableImportedSkill(bundle.skillKey);
    installed.push(bundle.skillKey);
  }

  private async enableImportedSkill(skillKey: string): Promise<void> {
    const stateResult = await this.deps.repository.setEnabled(skillKey, true);
    if (!stateResult.success) {
      throw new Error(stateResult.error || `Failed to enable skill "${skillKey}"`);
    }
    this.deps.jobs.submitGatewayUpdate({ skillKey, updates: { enabled: true } });
  }

  private normalizeSkillKey(input: string): string {
    return normalizeSkillKey(input, this.deps.clock.nowMs());
  }
}

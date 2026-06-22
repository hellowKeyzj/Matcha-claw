import { join } from 'node:path';
import type { GatewayRpcPort } from '../../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot, isGatewayStartupConnectionError, type GatewayReadinessPort } from '../../gateway/gateway-readiness';
import type { RuntimeClockPort, RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { SkillsJobPort } from '../../skills/skills-jobs';
import type { SkillsConfigRepository } from '../../skills/store';
import type { RuntimeHostLogger } from '../../../shared/logger';

const SKILL_MANIFEST_FILE = 'SKILL.md';
const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export interface SkillRuntimeWorkspacePort {
  getSkillsDir(): string;
  getBuiltinVisibleSkillsManifestCandidates(): readonly string[];
  getBuiltinSkillRootCandidates(): readonly string[];
}

interface SkillInventoryEntry {
  skillKey: string;
  name: string;
  description: string;
  version?: string;
  source: string;
  baseDir: string;
  filePath: string;
  bundled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSkillIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function pushUniqueString(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

export interface SkillRuntimeWorkflowDeps {
  gateway: GatewayRpcPort & GatewayReadinessPort;
  jobs: Pick<SkillsJobPort, 'submitRefreshStatus'>;
  clock: RuntimeClockPort;
  repository: Pick<SkillsConfigRepository, 'getAllConfigs'>;
  fileSystem: RuntimeFileSystemPort;
  workspace: SkillRuntimeWorkspacePort;
  logger: RuntimeHostLogger;
}

export class SkillRuntimeWorkflow {
  private statusSnapshot: unknown = { skills: [] };
  private statusSnapshotReady = false;
  private statusSnapshotError: string | null = null;
  private statusSnapshotUpdatedAt: number | null = null;

  constructor(private readonly deps: SkillRuntimeWorkflowDeps) {}

  async status() {
    if (await isGatewayReadyForSnapshot(this.deps.gateway)) {
      this.deps.jobs.submitRefreshStatus();
    }
    return this.buildStatusPayload();
  }

  async refreshStatus() {
    if (!(await isGatewayReadyForSnapshot(this.deps.gateway))) {
      return this.buildStatusPayload();
    }
    try {
      const gatewayStatus = await this.deps.gateway.gatewayRpc('skills.status');
      this.statusSnapshot = await this.buildInstalledStatusSnapshot(gatewayStatus);
      this.statusSnapshotReady = true;
      this.statusSnapshotError = null;
      this.statusSnapshotUpdatedAt = this.deps.clock.nowMs();
      return this.buildStatusPayload();
    } catch (error) {
      if (isGatewayStartupConnectionError(error)) {
        return this.buildStatusPayload();
      }
      this.statusSnapshotError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async resolveCanonicalSkillKeys(skillIds: readonly string[]): Promise<string[]> {
    if (skillIds.length === 0) {
      return [];
    }

    const canonicalKeyBySkillId = await this.resolveCanonicalSkillKeyMap(skillIds);
    const canonicalKeys: string[] = [];
    for (const skillId of skillIds) {
      const canonicalKey = canonicalKeyBySkillId[skillId.trim()];
      if (canonicalKey && !canonicalKeys.includes(canonicalKey)) {
        canonicalKeys.push(canonicalKey);
      }
    }
    return canonicalKeys;
  }

  async resolveCanonicalSkillKeyMap(skillIds: readonly string[]): Promise<Record<string, string>> {
    if (skillIds.length === 0) {
      return {};
    }

    const canonicalKeyByIdentity = await this.buildCanonicalSkillKeyByIdentity();
    const canonicalKeyBySkillId: Record<string, string> = {};
    for (const skillId of skillIds) {
      const trimmedSkillId = skillId.trim();
      const canonicalKey = canonicalKeyByIdentity.get(normalizeSkillIdentity(trimmedSkillId));
      if (trimmedSkillId && canonicalKey) {
        canonicalKeyBySkillId[trimmedSkillId] = canonicalKey;
      }
    }
    return canonicalKeyBySkillId;
  }

  async validateCanonicalSkillKeys(skillIds: readonly string[]): Promise<
    { ok: true; skillKeys: string[] }
    | { ok: false; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] }
  > {
    if (skillIds.length === 0) {
      return { ok: true, skillKeys: [] };
    }

    const canonicalKeyByIdentity = await this.buildCanonicalSkillKeyByIdentity();
    const validatedSkillKeys: string[] = [];
    const unknownSkillKeys: string[] = [];
    const nonCanonicalSkillKeys: string[] = [];
    for (const skillId of skillIds) {
      const trimmedSkillId = skillId.trim();
      const canonicalKey = canonicalKeyByIdentity.get(normalizeSkillIdentity(trimmedSkillId));
      if (!canonicalKey) {
        pushUniqueString(unknownSkillKeys, trimmedSkillId);
        continue;
      }
      if (trimmedSkillId !== canonicalKey) {
        pushUniqueString(nonCanonicalSkillKeys, trimmedSkillId);
        continue;
      }
      pushUniqueString(validatedSkillKeys, canonicalKey);
    }
    if (unknownSkillKeys.length > 0 || nonCanonicalSkillKeys.length > 0) {
      return { ok: false, unknownSkillKeys, nonCanonicalSkillKeys };
    }
    return { ok: true, skillKeys: validatedSkillKeys };
  }

  async executeGatewayUpdate(
    skillKey: string,
    updates: Record<string, unknown>,
  ): Promise<string | null> {
    let gatewayRunning: boolean;
    try {
      gatewayRunning = await this.deps.gateway.isGatewayRunning();
    } catch (error) {
      return String(error);
    }
    if (!gatewayRunning) {
      return null;
    }
    try {
      await this.deps.gateway.gatewayRpc('skills.update', {
        skillKey,
        ...updates,
      });
      this.deps.jobs.submitRefreshStatus();
      return null;
    } catch (error) {
      return String(error);
    }
  }

  private async buildCanonicalSkillKeyByIdentity(): Promise<Map<string, string>> {
    const canonicalKeyByIdentity = new Map<string, string>();
    for (const entry of await this.listInstalledSkillInventory()) {
      this.addCanonicalSkillIdentity(canonicalKeyByIdentity, entry.skillKey, entry.name);
    }
    for (const skill of Object.values(this.normalizeGatewayStatusSkills(this.statusSnapshot))) {
      this.addCanonicalSkillIdentity(
        canonicalKeyByIdentity,
        String(skill.skillKey),
        normalizeOptionalString(skill.name),
      );
    }
    return canonicalKeyByIdentity;
  }

  private addCanonicalSkillIdentity(
    canonicalKeyByIdentity: Map<string, string>,
    skillKey: string,
    name?: string,
  ): void {
    const normalizedSkillKey = skillKey.trim();
    if (!normalizedSkillKey) {
      return;
    }
    canonicalKeyByIdentity.set(normalizeSkillIdentity(normalizedSkillKey), normalizedSkillKey);
    if (name?.trim()) {
      canonicalKeyByIdentity.set(normalizeSkillIdentity(name), normalizedSkillKey);
    }
  }

  private async readSkillInventoryEntry(
    rootDir: string,
    skillKey: string,
    input: { source: string; bundled: boolean },
  ): Promise<SkillInventoryEntry | null> {
    const baseDir = join(rootDir, skillKey);
    const filePath = join(baseDir, SKILL_MANIFEST_FILE);
    if (!(await this.deps.fileSystem.exists(filePath))) {
      return null;
    }

    let name = skillKey;
    let description = '';
    try {
      const markdown = await this.deps.fileSystem.readTextFile(filePath);
      const frontmatter = markdown.match(FRONTMATTER_PATTERN)?.[1] ?? '';
      const markdownFields = this.parseMarkdownSkillFields(markdown);
      name = this.parseFrontmatterField(frontmatter, 'name') ?? markdownFields.name ?? name;
      description = this.parseFrontmatterField(frontmatter, 'description') ?? markdownFields.description ?? description;
    } catch (error) {
      this.deps.logger.warn(`Failed to read skill manifest: ${filePath}: ${String(error)}`);
    }

    return {
      skillKey,
      name,
      description,
      source: input.source,
      baseDir,
      filePath,
      bundled: input.bundled,
    };
  }

  private async listSkillInventoryRoot(
    rootDir: string,
    input: { source: string; bundled: boolean },
  ): Promise<SkillInventoryEntry[]> {
    if (!(await this.deps.fileSystem.exists(rootDir))) {
      return [];
    }
    const entries = await this.deps.fileSystem.listDirectory(rootDir);
    const skills: SkillInventoryEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }
      const skill = await this.readSkillInventoryEntry(rootDir, entry.name, input);
      if (skill) {
        skills.push(skill);
      }
    }
    return skills;
  }

  private async listInstalledSkillInventory(): Promise<SkillInventoryEntry[]> {
    const inventory = new Map<string, SkillInventoryEntry>();

    for (const entry of await this.listConfiguredBuiltinSkillInventory()) {
      inventory.set(entry.skillKey, entry);
    }

    for (const entry of await this.listSkillInventoryRoot(this.deps.workspace.getSkillsDir(), {
      source: 'managed',
      bundled: false,
    })) {
      inventory.set(entry.skillKey, {
        ...inventory.get(entry.skillKey),
        ...entry,
      });
    }

    return [...inventory.values()];
  }

  private async readVisibleBuiltinSkillKeys(): Promise<string[]> {
    const manifestPath = await this.firstExistingPath([...this.deps.workspace.getBuiltinVisibleSkillsManifestCandidates()]);
    if (!manifestPath) {
      return [];
    }
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(manifestPath));
      const skills = isRecord(parsed) && Array.isArray(parsed.skills) ? parsed.skills : [];
      return [...new Set(skills
        .map((item) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean))];
    } catch (error) {
      this.deps.logger.warn(`Failed to read builtin visible skills manifest: ${String(error)}`);
      return [];
    }
  }

  private async listConfiguredBuiltinSkillInventory(): Promise<SkillInventoryEntry[]> {
    const skillKeys = await this.readVisibleBuiltinSkillKeys();
    if (skillKeys.length === 0) {
      return [];
    }

    const rootDirs = [...this.deps.workspace.getBuiltinSkillRootCandidates()];
    const skills: SkillInventoryEntry[] = [];
    for (const skillKey of skillKeys) {
      let skill: SkillInventoryEntry | null = null;
      for (const rootDir of rootDirs) {
        skill = await this.readSkillInventoryEntry(rootDir, skillKey, {
          source: 'bundled',
          bundled: true,
        });
        if (skill) {
          break;
        }
      }
      if (!skill) {
        this.deps.logger.warn(`Configured builtin skill missing SKILL.md, skipping: ${skillKey}`);
        continue;
      }
      skills.push(skill);
    }
    return skills;
  }

  private normalizeGatewayStatusSkills(statusSnapshot: unknown): Record<string, Record<string, unknown>> {
    if (!isRecord(statusSnapshot) || !Array.isArray(statusSnapshot.skills)) {
      return {};
    }
    const result: Record<string, Record<string, unknown>> = {};
    for (const item of statusSnapshot.skills) {
      if (!isRecord(item) || typeof item.skillKey !== 'string' || !item.skillKey.trim()) {
        continue;
      }
      result[item.skillKey] = item;
    }
    return result;
  }

  private readBooleanConfig(configs: Record<string, unknown>, skillKey: string): boolean | undefined {
    const entry = isRecord(configs[skillKey]) ? configs[skillKey] : null;
    return typeof entry?.enabled === 'boolean' ? entry.enabled : undefined;
  }

  private readOptionalConfig(configs: Record<string, unknown>, skillKey: string): Record<string, unknown> | undefined {
    const entry = isRecord(configs[skillKey]) ? configs[skillKey] : null;
    if (!entry) {
      return undefined;
    }
    const config: Record<string, unknown> = {};
    if (typeof entry.apiKey === 'string') {
      config.apiKey = entry.apiKey;
    }
    if (isRecord(entry.env)) {
      config.env = entry.env;
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  private resolveDisabled(configEnabled: boolean | undefined, gatewayDisabled: unknown): boolean {
    if (typeof configEnabled === 'boolean') {
      return !configEnabled;
    }
    return gatewayDisabled === true;
  }

  private isDisplayableInstalledSkill(skill: Record<string, unknown>): boolean {
    if (skill.installed !== true) {
      return false;
    }
    if (skill.blockedByAllowlist === true) {
      return false;
    }
    return true;
  }

  private async buildInstalledStatusSnapshot(statusSnapshot: unknown): Promise<Record<string, unknown>> {
    const configs = await this.deps.repository.getAllConfigs();
    const gatewaySkills = this.normalizeGatewayStatusSkills(statusSnapshot);
    const bySkillKey = new Map<string, Record<string, unknown>>();

    for (const inventoryEntry of await this.listInstalledSkillInventory()) {
      const enabled = this.readBooleanConfig(configs, inventoryEntry.skillKey);
      const config = this.readOptionalConfig(configs, inventoryEntry.skillKey);
      bySkillKey.set(inventoryEntry.skillKey, {
        skillKey: inventoryEntry.skillKey,
        name: inventoryEntry.name,
        description: inventoryEntry.description,
        installed: true,
        eligible: true,
        disabled: this.resolveDisabled(enabled, undefined),
        bundled: inventoryEntry.bundled,
        always: false,
        source: inventoryEntry.source,
        baseDir: inventoryEntry.baseDir,
        filePath: inventoryEntry.filePath,
        ...(inventoryEntry.version ? { version: inventoryEntry.version } : {}),
        ...(config ? { config } : {}),
      });
    }

    for (const gatewaySkill of Object.values(gatewaySkills)) {
      const skillKey = String(gatewaySkill.skillKey);
      const existing = bySkillKey.get(skillKey);
      const enabled = this.readBooleanConfig(configs, skillKey);
      const config = this.readOptionalConfig(configs, skillKey);
      bySkillKey.set(skillKey, {
        ...existing,
        ...gatewaySkill,
        name: normalizeOptionalString(gatewaySkill.name) ?? normalizeOptionalString(existing?.name) ?? skillKey,
        description: normalizeOptionalString(gatewaySkill.description) ?? normalizeOptionalString(existing?.description) ?? '',
        installed: existing?.installed === true || gatewaySkill.installed === true,
        eligible: typeof gatewaySkill.eligible === 'boolean'
          ? gatewaySkill.eligible
          : existing?.eligible,
        disabled: this.resolveDisabled(enabled, gatewaySkill.disabled),
        ...(config ? { config: { ...(isRecord(gatewaySkill.config) ? gatewaySkill.config : {}), ...config } } : {}),
      });
    }

    return {
      ...(isRecord(statusSnapshot) ? statusSnapshot : {}),
      skills: [...bySkillKey.values()].filter((skill) => this.isDisplayableInstalledSkill(skill)).sort((left, right) => {
        const leftName = typeof left.name === 'string' && left.name.trim() ? left.name : String(left.skillKey ?? '');
        const rightName = typeof right.name === 'string' && right.name.trim() ? right.name : String(right.skillKey ?? '');
        return leftName.localeCompare(rightName, 'en');
      }),
    };
  }

  private parseFrontmatterField(frontmatter: string, field: 'name' | 'description'): string | null {
    const pattern = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'im');
    const match = frontmatter.match(pattern);
    if (!match) {
      return null;
    }
    return match[1].trim().replace(/^["']|["']$/g, '') || null;
  }

  private parseMarkdownSkillFields(markdown: string): { name?: string; description?: string } {
    const body = markdown.replace(FRONTMATTER_PATTERN, '').trim();
    if (!body) {
      return {};
    }

    const lines = body.split(/\r?\n/);
    const headingIndex = lines.findIndex((line) => /^#\s+/.test(line.trim()));
    const name = headingIndex >= 0
      ? this.normalizeMarkdownText(lines[headingIndex].trim().replace(/^#\s+/, ''))
      : undefined;

    const descriptionLines: string[] = [];
    let inFence = false;
    for (let index = headingIndex >= 0 ? headingIndex + 1 : 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line.startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      if (inFence || /^#{1,6}\s+/.test(line)) {
        if (descriptionLines.length > 0) {
          break;
        }
        continue;
      }
      if (!line) {
        if (descriptionLines.length > 0) {
          break;
        }
        continue;
      }
      descriptionLines.push(line);
    }

    const description = this.normalizeMarkdownText(descriptionLines.join(' '));
    return {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  }

  private normalizeMarkdownText(value: string): string {
    return value
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async firstExistingPath(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.deps.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private buildStatusPayload() {
    return {
      success: true,
      ...(isRecord(this.statusSnapshot) ? this.statusSnapshot : { result: this.statusSnapshot }),
      ready: this.statusSnapshotReady,
      updatedAt: this.statusSnapshotUpdatedAt,
      error: this.statusSnapshotError,
    };
  }
}

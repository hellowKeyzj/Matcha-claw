import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { TeamRuntimePackagePort } from './team-runtime-service';

const REQUIRED_PACKAGE_FILES = ['SKILL.md', 'workflow.md', 'dependencies.yaml'] as const;

export class TeamRuntimePackageService implements TeamRuntimePackagePort {
  constructor(private readonly deps: {
    readonly fileSystem: Pick<RuntimeFileSystemPort, 'readTextFile'>;
  }) {}

  async validate(packagePath: string): ReturnType<TeamRuntimePackagePort['validate']> {
    const errors: Array<{ code: string; message: string; path?: string }> = [];
    const sourcePath = path.resolve(packagePath);
    const files = await this.readRequiredFiles(sourcePath, errors);
    if (!files) {
      return { valid: false, errors, warnings: [] };
    }

    const manifest = this.readManifest(files['SKILL.md'], errors);
    const dependencies = this.readDependencies(files['dependencies.yaml'], errors);
    const workflow = { markdown: files['workflow.md'] };
    const bind = await this.readOptionalFile(path.join(sourcePath, 'bind.md'));
    const roles = manifest ? await this.readRoles(sourcePath, manifest.roles, errors) : [];

    if (!manifest || !dependencies || errors.length > 0) {
      return { valid: false, errors, warnings: [] };
    }

    return {
      valid: true,
      package: {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        sourcePath,
        roles,
        skill: { markdown: files['SKILL.md'] },
        workflow,
        ...(bind === undefined ? {} : { bind: { markdown: bind } }),
        dependencies: { ...dependencies, yaml: files['dependencies.yaml'] },
      },
      errors,
      warnings: [],
    };
  }

  private async readRequiredFiles(sourcePath: string, errors: Array<{ code: string; message: string; path?: string }>): Promise<Record<typeof REQUIRED_PACKAGE_FILES[number], string> | null> {
    const files: Partial<Record<typeof REQUIRED_PACKAGE_FILES[number], string>> = {};
    for (const fileName of REQUIRED_PACKAGE_FILES) {
      const filePath = path.join(sourcePath, fileName);
      try {
        files[fileName] = await this.deps.fileSystem.readTextFile(filePath);
      } catch {
        errors.push({ code: 'required_file_missing', message: `Missing required TeamSkill file: ${fileName}`, path: filePath });
      }
    }
    return errors.some((issue) => issue.code === 'required_file_missing') ? null : files as Record<typeof REQUIRED_PACKAGE_FILES[number], string>;
  }

  private readManifest(skillMarkdown: string, errors: Array<{ code: string; message: string; path?: string }>): { name: string; version: string; description: string; roles: Array<{ id: string; purpose: string; skills: string[]; tools: string[] }> } | null {
    const frontmatter = this.extractFrontmatter(skillMarkdown);
    if (!frontmatter) {
      errors.push({ code: 'manifest_frontmatter_missing', message: 'SKILL.md must start with YAML frontmatter.', path: 'SKILL.md' });
      return null;
    }
    const raw = this.parseYamlRecord(frontmatter, 'SKILL.md', errors);
    if (!raw) return null;
    const manifest = {
      name: readString(raw.name),
      version: readString(raw.version),
      description: readString(raw.description),
      roles: Array.isArray(raw.roles) ? raw.roles.map(readManifestRole).filter((role): role is NonNullable<ReturnType<typeof readManifestRole>> => Boolean(role)) : [],
    };
    if (!manifest.name) errors.push({ code: 'manifest_name_missing', message: 'SKILL.md frontmatter must include name.', path: 'SKILL.md' });
    if (!manifest.version) errors.push({ code: 'manifest_version_missing', message: 'SKILL.md frontmatter must include version.', path: 'SKILL.md' });
    if (readString(raw.kind) !== 'team-skill') errors.push({ code: 'invalid_kind', message: 'SKILL.md frontmatter kind must be team-skill.', path: 'SKILL.md' });
    if (manifest.roles.length === 0) errors.push({ code: 'roles_missing', message: 'SKILL.md frontmatter must include at least one role.', path: 'SKILL.md' });
    return manifest;
  }

  private readDependencies(dependenciesYaml: string, errors: Array<{ code: string; message: string; path?: string }>): { skills: unknown[]; tools: unknown[] } | null {
    const raw = this.parseYamlRecord(dependenciesYaml, 'dependencies.yaml', errors);
    if (!raw) return null;
    if (!Array.isArray(raw.skills)) errors.push({ code: 'dependencies_skills_missing', message: 'dependencies.yaml must contain a skills array.', path: 'dependencies.yaml' });
    if (!Array.isArray(raw.tools)) errors.push({ code: 'dependencies_tools_missing', message: 'dependencies.yaml must contain a tools array.', path: 'dependencies.yaml' });
    return { skills: Array.isArray(raw.skills) ? raw.skills : [], tools: Array.isArray(raw.tools) ? raw.tools : [] };
  }

  private async readOptionalFile(filePath: string): Promise<string | undefined> {
    try {
      return await this.deps.fileSystem.readTextFile(filePath);
    } catch {
      return undefined;
    }
  }

  private async readRoles(sourcePath: string, manifestRoles: Array<{ id: string; purpose: string; skills: string[]; tools: string[] }>, errors: Array<{ code: string; message: string; path?: string }>) {
    const roles: Array<{ id: string; purpose: string; skills: string[]; tools: string[]; agentsMd: string }> = [];
    const seenRoleIds = new Set<string>();
    for (const role of manifestRoles) {
      if (!role.id) {
        errors.push({ code: 'role_id_missing', message: 'Every role must include id.', path: 'SKILL.md' });
        continue;
      }
      if (role.id === 'leader') {
        errors.push({ code: 'reserved_role_id', message: `Role id is reserved for the Team leader: ${role.id}`, path: 'SKILL.md' });
        continue;
      }
      if (seenRoleIds.has(role.id)) {
        errors.push({ code: 'duplicate_role_id', message: `Duplicate role id: ${role.id}`, path: 'SKILL.md' });
        continue;
      }
      seenRoleIds.add(role.id);
      const roleFilePath = path.join(sourcePath, 'roles', `${role.id}.md`);
      try {
        roles.push({ ...role, agentsMd: await this.deps.fileSystem.readTextFile(roleFilePath) });
      } catch {
        errors.push({ code: 'role_file_missing', message: `Missing role file for role ${role.id}.`, path: roleFilePath });
      }
    }
    return roles;
  }

  private extractFrontmatter(markdown: string): string | null {
    return markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? null;
  }

  private parseYamlRecord(markdown: string, source: string, errors: Array<{ code: string; message: string; path?: string }>): Record<string, unknown> | null {
    try {
      const parsed = parseYaml(markdown);
      if (!isRecord(parsed)) {
        errors.push({ code: 'yaml_not_object', message: `${source} must parse to a YAML object.`, path: source });
        return null;
      }
      return parsed;
    } catch (error) {
      errors.push({ code: 'yaml_parse_error', message: `${source} is not valid YAML: ${String(error)}`, path: source });
      return null;
    }
  }
}

function readManifestRole(value: unknown): { id: string; purpose: string; skills: string[]; tools: string[] } | null {
  if (!isRecord(value)) return null;
  return {
    id: readString(value.id),
    purpose: readString(value.purpose),
    skills: readStringArray(value.skills),
    tools: readStringArray(value.tools),
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

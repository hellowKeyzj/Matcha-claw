import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'
import { TEAM_LEADER_ROLE_ID, TEAM_ROLE_MANAGED_DENIED_TOOLS } from '../domain/team-role.js'
import type {
  TeamSkillBindSpec,
  TeamSkillDependencies,
  TeamSkillDependencyEntry,
  TeamSkillPackageValidationResult,
  TeamSkillRoleSpec,
  TeamSkillValidationIssue,
  TeamSkillWorkflowSpec,
} from '../domain/team-skill-package.js'

interface SkillManifestRole {
  id: string
  purpose: string
  skills: string[]
  tools: string[]
}

interface SkillManifest {
  name: string
  version: string
  kind: string
  description: string
  roles: SkillManifestRole[]
}

type DependencyKind = 'skill' | 'tool'

const REQUIRED_PACKAGE_FILES = ['SKILL.md', 'workflow.md', 'bind.md', 'dependencies.yaml'] as const
const REQUIRED_ROLE_SECTIONS = ['Identity', 'Success Criteria', 'Boundary', 'Output Schema'] as const
const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz'] as const
const ARCHIVE_CACHE_ROOT = path.join(os.tmpdir(), 'matchaclaw-team-skill-packages')

export class TeamSkillPackageService {
  async validate(packagePath: string): Promise<TeamSkillPackageValidationResult> {
    const inputPath = path.resolve(packagePath)
    const errors: TeamSkillValidationIssue[] = []
    const warnings: TeamSkillValidationIssue[] = []
    const sourcePath = await this.resolvePackageSourcePath(inputPath, errors)

    if (!sourcePath) {
      return { valid: false, errors, warnings }
    }

    const files = await this.readRequiredFiles(sourcePath, errors)

    if (!files) {
      return { valid: false, errors, warnings }
    }

    const manifest = this.readManifest(files['SKILL.md'], errors)
    const dependencies = this.readDependencies(files['dependencies.yaml'], errors)

    if (!manifest || !dependencies) {
      return { valid: false, errors, warnings }
    }

    this.validateManifest(manifest, errors)
    this.validateDependencyConsistency(manifest, dependencies, errors)

    const roles = await this.readRoles(sourcePath, manifest.roles, errors)
    const workflow = this.readWorkflow(files['workflow.md'])
    const bind = this.readBind(files['bind.md'])

    if (errors.length > 0) {
      return { valid: false, errors, warnings }
    }

    return {
      valid: true,
      package: {
        name: manifest.name,
        version: manifest.version,
        kind: 'team-skill',
        description: manifest.description,
        roles,
        dependencies,
        workflow,
        bind,
        sourcePath,
      },
      errors,
      warnings,
    }
  }

  private async resolvePackageSourcePath(inputPath: string, errors: TeamSkillValidationIssue[]): Promise<string | null> {
    if (!this.isArchivePath(inputPath)) {
      return inputPath
    }
    const archiveRoot = this.buildArchiveExtractRoot(inputPath)
    try {
      await rm(archiveRoot, { recursive: true, force: true })
      await mkdir(archiveRoot, { recursive: true })
      await this.extractArchive(inputPath, archiveRoot)
      return await this.findExtractedPackageRoot(archiveRoot)
    } catch (error) {
      errors.push({
        code: 'archive_extract_failed',
        message: `Failed to extract TeamSkill archive: ${error instanceof Error ? error.message : String(error)}`,
        path: inputPath,
      })
      return null
    }
  }

  private isArchivePath(inputPath: string): boolean {
    const normalized = inputPath.toLowerCase()
    return ARCHIVE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
  }

  private buildArchiveExtractRoot(inputPath: string): string {
    const hash = Buffer.from(inputPath).toString('base64url')
    return path.join(ARCHIVE_CACHE_ROOT, hash)
  }

  private async extractArchive(inputPath: string, outputRoot: string): Promise<void> {
    const normalized = inputPath.toLowerCase()
    if (normalized.endsWith('.zip')) {
      await this.extractZip(inputPath, outputRoot)
      return
    }
    if (normalized.endsWith('.tar') || normalized.endsWith('.tgz') || normalized.endsWith('.tar.gz')) {
      const { x: extractTar } = await import('tar')
      await extractTar({
        file: inputPath,
        cwd: outputRoot,
        preservePaths: false,
        strict: true,
        filter: (entryPath) => {
          this.resolveArchiveEntryPath(outputRoot, entryPath)
          return true
        },
      })
      return
    }
    throw new Error('Unsupported archive extension')
  }

  private async extractZip(inputPath: string, outputRoot: string): Promise<void> {
    const entries = unzipSync(await readFile(inputPath))
    await Promise.all(Object.entries(entries).map(async ([entryName, content]) => {
      if (entryName.endsWith('/')) {
        await mkdir(this.resolveArchiveEntryPath(outputRoot, entryName), { recursive: true })
        return
      }
      const outputPath = this.resolveArchiveEntryPath(outputRoot, entryName)
      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(outputPath, content)
    }))
  }

  private resolveArchiveEntryPath(outputRoot: string, entryName: string): string {
    const outputPath = path.resolve(outputRoot, entryName)
    const root = path.resolve(outputRoot)
    if (outputPath !== root && !outputPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Archive entry escapes package root: ${entryName}`)
    }
    return outputPath
  }

  private async findExtractedPackageRoot(archiveRoot: string): Promise<string> {
    try {
      await readFile(path.join(archiveRoot, 'SKILL.md'), 'utf8')
      return archiveRoot
    } catch {}
    const entries = await readdir(archiveRoot, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory())
    if (directories.length === 1) {
      const nestedRoot = path.join(archiveRoot, directories[0]!.name)
      try {
        await readFile(path.join(nestedRoot, 'SKILL.md'), 'utf8')
        return nestedRoot
      } catch {}
    }
    return archiveRoot
  }

  private async readRequiredFiles(sourcePath: string, errors: TeamSkillValidationIssue[]) {
    const files: Record<string, string> = {}
    for (const fileName of REQUIRED_PACKAGE_FILES) {
      const filePath = path.join(sourcePath, fileName)
      try {
        files[fileName] = await readFile(filePath, 'utf8')
      } catch {
        errors.push({
          code: 'required_file_missing',
          message: `Missing required TeamSkill file: ${fileName}`,
          path: filePath,
        })
      }
    }
    return errors.some((issue) => issue.code === 'required_file_missing') ? null : files
  }

  private readManifest(skillMarkdown: string, errors: TeamSkillValidationIssue[]): SkillManifest | null {
    const frontmatter = this.extractFrontmatter(skillMarkdown)
    if (!frontmatter) {
      errors.push({
        code: 'manifest_frontmatter_missing',
        message: 'SKILL.md must start with YAML frontmatter.',
        path: 'SKILL.md',
      })
      return null
    }

    const raw = this.parseYamlRecord(frontmatter, 'SKILL.md', errors)
    if (!raw) {
      return null
    }

    const roles = Array.isArray(raw.roles) ? raw.roles.map((role) => this.readManifestRole(role)).filter(Boolean) : []
    return {
      name: this.readString(raw.name),
      version: this.readString(raw.version),
      kind: this.readString(raw.kind),
      description: this.readString(raw.description),
      roles,
    }
  }

  private readDependencies(dependenciesYaml: string, errors: TeamSkillValidationIssue[]): TeamSkillDependencies | null {
    const raw = this.parseYamlRecord(dependenciesYaml, 'dependencies.yaml', errors)
    if (!raw) {
      return null
    }

    if (!Array.isArray(raw.skills)) {
      errors.push({
        code: 'dependencies_skills_missing',
        message: 'dependencies.yaml must contain a skills array.',
        path: 'dependencies.yaml',
      })
    }
    if (!Array.isArray(raw.tools)) {
      errors.push({
        code: 'dependencies_tools_missing',
        message: 'dependencies.yaml must contain a tools array.',
        path: 'dependencies.yaml',
      })
    }

    return {
      skills: this.readDependencyEntries(raw.skills, 'skill', errors),
      tools: this.readDependencyEntries(raw.tools, 'tool', errors),
    }
  }

  private validateManifest(manifest: SkillManifest, errors: TeamSkillValidationIssue[]) {
    if (!manifest.name) {
      errors.push({ code: 'manifest_name_missing', message: 'SKILL.md frontmatter must include name.', path: 'SKILL.md' })
    }
    if (!manifest.version) {
      errors.push({ code: 'manifest_version_missing', message: 'SKILL.md frontmatter must include version.', path: 'SKILL.md' })
    }
    if (manifest.kind !== 'team-skill') {
      errors.push({
        code: 'invalid_kind',
        message: 'SKILL.md frontmatter kind must be team-skill.',
        path: 'SKILL.md',
      })
    }
    if (manifest.roles.length === 0) {
      errors.push({ code: 'roles_missing', message: 'SKILL.md frontmatter must include at least one role.', path: 'SKILL.md' })
    }

    const seenRoleIds = new Set<string>()
    for (const role of manifest.roles) {
      if (!role.id) {
        errors.push({ code: 'role_id_missing', message: 'Every role must include id.', path: 'SKILL.md' })
        continue
      }
      if (role.id === TEAM_LEADER_ROLE_ID) {
        errors.push({ code: 'reserved_role_id', message: `Role id is reserved for the Team leader: ${role.id}`, path: 'SKILL.md' })
      }
      if (seenRoleIds.has(role.id)) {
        errors.push({ code: 'duplicate_role_id', message: `Duplicate role id: ${role.id}`, path: 'SKILL.md' })
      }
      seenRoleIds.add(role.id)
    }
  }

  private validateDependencyConsistency(
    manifest: SkillManifest,
    dependencies: TeamSkillDependencies,
    errors: TeamSkillValidationIssue[],
  ) {
    const declaredSkills = new Set(dependencies.skills.map((item) => item.name))
    const declaredTools = new Set(dependencies.tools.map((item) => item.name))

    for (const role of manifest.roles) {
      for (const skill of role.skills) {
        if (!declaredSkills.has(skill)) {
          errors.push({
            code: 'role_skill_not_declared',
            message: `Role ${role.id} references skill ${skill}, but dependencies.yaml does not declare it.`,
            path: 'dependencies.yaml',
          })
        }
      }
      for (const tool of role.tools) {
        if (!declaredTools.has(tool)) {
          errors.push({
            code: 'role_tool_not_declared',
            message: `Role ${role.id} references tool ${tool}, but dependencies.yaml does not declare it.`,
            path: 'dependencies.yaml',
          })
        }
        if (TEAM_ROLE_MANAGED_DENIED_TOOLS.includes(tool as typeof TEAM_ROLE_MANAGED_DENIED_TOOLS[number])) {
          errors.push({
            code: 'role_tool_denied_for_managed_agent',
            message: `Role ${role.id} cannot allow denied managed agent tool: ${tool}`,
            path: 'SKILL.md',
          })
        }
      }
    }
  }

  private async readRoles(
    sourcePath: string,
    manifestRoles: SkillManifestRole[],
    errors: TeamSkillValidationIssue[],
  ): Promise<TeamSkillRoleSpec[]> {
    const roles: TeamSkillRoleSpec[] = []
    for (const role of manifestRoles) {
      const roleFilePath = path.join(sourcePath, 'roles', `${role.id}.md`)
      let agentsMd: string
      try {
        agentsMd = await readFile(roleFilePath, 'utf8')
      } catch {
        errors.push({
          code: 'role_file_missing',
          message: `Missing role file for role ${role.id}.`,
          path: roleFilePath,
        })
        continue
      }

      for (const section of REQUIRED_ROLE_SECTIONS) {
        if (!this.hasMarkdownSection(agentsMd, section)) {
          errors.push({
            code: 'role_required_section_missing',
            message: `Role ${role.id} is missing required section: ${section}.`,
            path: roleFilePath,
          })
        }
      }

      const outputSchemaMarkdown = this.extractMarkdownSection(agentsMd, 'Output Schema')
      roles.push({
        id: role.id,
        purpose: role.purpose,
        skills: role.skills,
        tools: role.tools,
        roleFilePath,
        agentsMd,
        inlinePersona: this.extractMarkdownSection(agentsMd, 'Inline Persona for Teammate') || undefined,
        outputSchemaMarkdown,
      })
    }
    return roles
  }

  private readWorkflow(markdown: string): TeamSkillWorkflowSpec {
    const gateKeywords = Array.from(new Set(markdown.match(/\b[A-Z][A-Z0-9-]*(?:-[A-Z0-9]+)+\b/g) ?? []))
    return { markdown, stages: [], gateKeywords }
  }

  private readBind(markdown: string): TeamSkillBindSpec {
    const maxParallelMatch = markdown.match(/`max_parallel_teammates`\s*\|\s*(\d+)/)
    return {
      markdown,
      maxParallelTeammates: maxParallelMatch ? Number(maxParallelMatch[1]) : undefined,
      totalWallClockBudgetMs: this.readDurationMs(markdown, 'total_wall_clock_budget'),
      totalTokenBudget: this.readTokenBudget(markdown, 'total_token_budget'),
      roleWallClockBudgetMs: this.readRoleDurationBudgets(markdown),
      roleTokenBudget: this.readRoleTokenBudgets(markdown),
      requiresNpuAuthorization: /No live NPU testing without authorization/i.test(markdown),
      leaderOnly: /Leader-as-orchestrator only/i.test(markdown),
      adversaryIsolation: /Adversary isolation/i.test(markdown),
    }
  }

  private readRoleDurationBudgets(markdown: string): Record<string, number> {
    const budgets: Record<string, number> = {}
    for (const match of markdown.matchAll(/`([^`]+)_wall_clock`\s*\|\s*([^|\r\n]+)/g)) {
      const roleId = match[1]?.trim()
      const duration = this.parseDurationMs(match[2] ?? '')
      if (roleId && roleId !== 'total' && duration !== undefined) {
        budgets[roleId] = duration
      }
    }
    return budgets
  }

  private readRoleTokenBudgets(markdown: string): Record<string, number> {
    const budgets: Record<string, number> = {}
    for (const match of markdown.matchAll(/`([^`]+)_token_budget`\s*\|\s*([^|\r\n]+)/g)) {
      const roleId = match[1]?.trim()
      const tokens = this.parseTokenBudget(match[2] ?? '')
      if (roleId && roleId !== 'total' && tokens !== undefined) {
        budgets[roleId] = tokens
      }
    }
    return budgets
  }

  private readDurationMs(markdown: string, key: string): number | undefined {
    const match = markdown.match(new RegExp('`' + this.escapeRegExp(key) + '`\\s*\\|\\s*([^|\\r\\n]+)'))
    return match?.[1] ? this.parseDurationMs(match[1]) : undefined
  }

  private readTokenBudget(markdown: string, key: string): number | undefined {
    const match = markdown.match(new RegExp('`' + this.escapeRegExp(key) + '`\\s*\\|\\s*([^|\\r\\n]+)'))
    return match?.[1] ? this.parseTokenBudget(match[1]) : undefined
  }

  private parseDurationMs(value: string): number | undefined {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hour|hours)\b/i)
    if (!match?.[1] || !match[2]) {
      return undefined
    }
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    if (!Number.isFinite(amount) || amount <= 0) {
      return undefined
    }
    if (unit === 'ms') return Math.round(amount)
    if (unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds') return Math.round(amount * 1_000)
    if (unit === 'min' || unit === 'mins' || unit === 'minute' || unit === 'minutes') return Math.round(amount * 60_000)
    return Math.round(amount * 3_600_000)
  }

  private parseTokenBudget(value: string): number | undefined {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(k|m)?\s*tokens?\b/i)
    if (!match?.[1]) {
      return undefined
    }
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) {
      return undefined
    }
    const unit = match[2]?.toLowerCase()
    if (unit === 'm') return Math.round(amount * 1_000_000)
    if (unit === 'k') return Math.round(amount * 1_000)
    return Math.round(amount)
  }

  private extractFrontmatter(markdown: string): string | null {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    return match?.[1] ?? null
  }

  private parseYamlRecord(markdown: string, source: string, errors: TeamSkillValidationIssue[]): Record<string, unknown> | null {
    try {
      const parsed = parseYaml(markdown)
      if (!this.isRecord(parsed)) {
        errors.push({ code: 'yaml_not_object', message: `${source} must parse to a YAML object.`, path: source })
        return null
      }
      return parsed
    } catch (error) {
      errors.push({ code: 'yaml_parse_error', message: `${source} is not valid YAML: ${String(error)}`, path: source })
      return null
    }
  }

  private readManifestRole(value: unknown): SkillManifestRole | null {
    if (!this.isRecord(value)) {
      return null
    }
    return {
      id: this.readString(value.id),
      purpose: this.readString(value.purpose),
      skills: this.readStringArray(value.skills),
      tools: this.readStringArray(value.tools),
    }
  }

  private readDependencyEntries(value: unknown, dependencyKind: DependencyKind, errors: TeamSkillValidationIssue[]): TeamSkillDependencyEntry[] {
    if (!Array.isArray(value)) {
      return []
    }
    return value.flatMap((item, index) => this.readDependencyEntry(item, dependencyKind, index, errors))
  }

  private readDependencyEntry(
    value: unknown,
    dependencyKind: DependencyKind,
    index: number,
    errors: TeamSkillValidationIssue[],
  ): TeamSkillDependencyEntry[] {
    if (!this.isRecord(value)) {
      errors.push({ code: 'dependency_entry_invalid', message: `dependencies.yaml ${dependencyKind}s[${index}] must be an object.`, path: 'dependencies.yaml' })
      return []
    }

    const name = this.readString(value.name)
    const purpose = this.readString(value.purpose)
    const source = this.readString(value.source)
    const required = value.required
    if (!name) {
      errors.push({ code: 'dependency_name_missing', message: `dependencies.yaml ${dependencyKind}s[${index}].name must be a non-empty string.`, path: 'dependencies.yaml' })
    }
    if (typeof required !== 'boolean') {
      errors.push({ code: 'dependency_required_missing', message: `dependencies.yaml ${dependencyKind}s[${index}].required must be true or false.`, path: 'dependencies.yaml' })
    }
    if (!purpose) {
      errors.push({ code: 'dependency_purpose_missing', message: `dependencies.yaml ${dependencyKind}s[${index}].purpose must be a non-empty string.`, path: 'dependencies.yaml' })
    }
    if (dependencyKind === 'skill' && !source) {
      errors.push({ code: 'dependency_source_missing', message: `dependencies.yaml skills[${index}].source must be a non-empty string.`, path: 'dependencies.yaml' })
    }
    if (!name || typeof required !== 'boolean' || !purpose || (dependencyKind === 'skill' && !source)) {
      return []
    }

    return [{ name, required, purpose, ...(source ? { source } : {}) }]
  }

  private hasMarkdownSection(markdown: string, section: string): boolean {
    return this.markdownSectionHeading(section).test(markdown)
  }

  private extractMarkdownSection(markdown: string, section: string): string {
    const lines = markdown.split(/\r?\n/)
    const targetHeading = this.markdownSectionHeading(section)
    let collecting = false
    let inFence = false
    const collected: string[] = []

    for (const line of lines) {
      if (line.trim().startsWith('```')) {
        if (collecting) {
          collected.push(line)
        }
        inFence = !inFence
        continue
      }

      if (!inFence && targetHeading.test(line)) {
        collecting = true
        continue
      }

      if (collecting && !inFence && /^##\s+[^\r\n]+\s*$/.test(line)) {
        break
      }

      if (collecting) {
        collected.push(line)
      }
    }

    return collected.join('\n').trim()
  }

  private markdownSectionHeading(section: string): RegExp {
    return new RegExp(`^##\\s+(?:${this.escapeRegExp(section)}|[^\r\n#]*[（(]${this.escapeRegExp(section)}[）)][^\r\n#]*)\\s*$`, 'm')
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
  }

  private readStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
